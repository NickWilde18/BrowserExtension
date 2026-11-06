// AI 动作执行期间对顶层导航的两道把关（Fetch 域，只拦本标签页的 Document 请求；插件内部用法，不对服务端
// 开放，计划 4.6）：
//
// 1. 跨站跳转（计划 4.5）：AI 点链接、提交表单、前进后退、执行脚本时，页面要跳到没授权过的站点，在请求
//    发出之前拦下（请求还没带着用户的登录态出去），做站点授权；拒绝就本地回 204，页面留在原处。
// 2. 导航类下载（计划 4.7）：响应带 `Content-Disposition: attachment` 的是下载，在响应阶段截下：交给动作
//    做逐次确认，允许就取出响应体送回 Chat，然后回 204 取消浏览器自己的下载（不落进用户的下载目录）。
//    跨源的文件地址、表单 POST 触发的导出都走这条；`<a download>` 这类不经导航的下载由 downloads.ts 处理。
//
// 只在 AI 的动作执行期间开，用户自己在标签里点来点去时不拦；动作结束后页面自己跳走的，下一个动作开始前的
// 站点核对会补上授权（ActionContext.ensureSite）。

import { siteOf } from '../policy/url';
import type { TabSession } from './tab-session';

/** 响应阶段截下的一个下载。 */
export interface CapturedDownload {
  url: string;
  /** 响应头里的文件名（Content-Disposition），没有时为空。 */
  disposition: string;
  contentType: string;
  /** 响应头里声明的大小，没有时为 null。 */
  size: number | null;
  /** 取出响应体（只在用户允许之后调）。 */
  body(): Promise<Uint8Array>;
}

export interface NavGuardHooks {
  /** 顶层导航要去的站点能不能去（已授权，或这一步问过用户）。 */
  decide(site: string): Promise<boolean>;
  /** 截下了一个下载；返回之后这次响应被回 204 取消。 */
  download(d: CapturedDownload): Promise<void>;
  /** 一次顶层导航被回 204 取消了（拦下的跨站跳转、截下的下载）：页面留在原处，不会再有加载完成的事件。 */
  aborted(): void;
}

function header(headers: Array<{ name: string; value: string }> | undefined, name: string): string {
  return headers?.find((h) => h.name.toLowerCase() === name)?.value ?? '';
}

export class NavGuard {
  private off: (() => void) | null = null;
  private readonly decisions = new Map<string, Promise<boolean>>();
  /** 被拦下、用户没同意的站点（动作据此回 user_denied）。 */
  blocked: string | null = null;

  constructor(private readonly s: TabSession, private readonly hooks: NavGuardHooks) {}

  async enable(): Promise<void> {
    this.off = this.s.on((method, params, sessionId) => {
      if (method === 'Fetch.requestPaused' && sessionId === undefined) {
        void this.handle(params);
      }
    });

    await this.s.cdp.send('Fetch.enable', {
      patterns: [
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
        { urlPattern: '*', resourceType: 'Document', requestStage: 'Response' },
      ],
    });
  }

  async disable(): Promise<void> {
    this.off?.();
    this.off = null;
    try {
      await this.s.cdp.send('Fetch.disable');
    } catch {
      // 标签页已经关了或断开了。
    }
  }

  private async handle(params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? '');
    const atResponse = params.responseStatusCode !== undefined || params.responseErrorReason !== undefined;

    if (atResponse) {
      await this.handleResponse(requestId, params);
      return;
    }

    const request = params.request as { url?: string } | undefined;
    const site = siteOf(request?.url ?? '');

    // 子框架的文档、非 http(s) 的导航（about:blank、blob: 等）不在站点授权的范围里。
    if (params.frameId !== this.s.mainFrameId || site === null) {
      await this.continue(requestId);
      return;
    }

    let decision = this.decisions.get(site);
    if (!decision) {
      decision = this.hooks.decide(site).catch(() => false);
      this.decisions.set(site, decision);
    }

    if (await decision) {
      await this.continue(requestId);
      return;
    }

    this.blocked = site;
    // 本地回 204：导航收到 204 就取消，页面留在原处，请求不会发到那个站点。用 failRequest 的话 Chrome 会提交
    // 一个「被扩展程序屏蔽」的错误页，标签停在错误页上、地址显示成被拦的网址（实测）。
    await this.fulfill204(requestId);
  }

  private async handleResponse(requestId: string, params: Record<string, unknown>): Promise<void> {
    const headers = params.responseHeaders as Array<{ name: string; value: string }> | undefined;
    const disposition = header(headers, 'content-disposition');
    if (!/^\s*attachment/i.test(disposition)) {
      await this.continue(requestId);
      return;
    }

    const request = params.request as { url?: string } | undefined;
    const declared = Number(header(headers, 'content-length'));
    try {
      await this.hooks.download({
        url: request?.url ?? '',
        disposition,
        contentType: header(headers, 'content-type'),
        size: Number.isFinite(declared) && declared > 0 ? declared : null,
        body: async () => {
          const res = await this.s.cdp.send<{ body: string; base64Encoded: boolean }>('Fetch.getResponseBody', { requestId });
          if (res.base64Encoded) {
            const bin = atob(res.body);
            const out = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) {
              out[i] = bin.charCodeAt(i);
            }

            return out;
          }

          return new TextEncoder().encode(res.body);
        },
      });
    } finally {
      // 不管允不允许、送没送成，浏览器自己的这次下载都取消。
      await this.fulfill204(requestId);
    }
  }

  private async fulfill204(requestId: string): Promise<void> {
    try {
      await this.s.cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 204, responseHeaders: [] });
    } catch {
      // 请求已经没了。
    }

    this.hooks.aborted();
  }

  private async continue(requestId: string): Promise<void> {
    try {
      await this.s.cdp.send('Fetch.continueRequest', { requestId });
    } catch {
      // 请求已经没了（页面又跳走了）。
    }
  }
}
