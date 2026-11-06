// 跨站跳转拦截（计划 4.5「跨站跳转」）：AI 点链接、提交表单、前进后退、执行脚本时，页面要跳到没授权过
// 的站点，在顶层导航的请求发出之前拦下（请求还没带着用户的登录态出去），做站点授权，拒绝就不让发。
//
// 只在 AI 的动作执行期间开（Fetch 域只拦主框架的 Document 请求），用户自己在标签里点来点去时不拦；
// 动作结束后页面自己跳走的，下一个动作开始前的站点核对会补上授权（ActionContext.ensureSite）。
// Fetch 域是插件内部用法，不对服务端开放（计划 4.6）。

import { siteOf } from '../policy/url';
import type { TabSession } from './tab-session';

export class NavGuard {
  private off: (() => void) | null = null;
  private readonly decisions = new Map<string, Promise<boolean>>();
  /** 被拦下、用户没同意的站点（动作据此回 user_denied）。 */
  blocked: string | null = null;

  constructor(private readonly s: TabSession, private readonly decide: (site: string) => Promise<boolean>) {}

  async enable(): Promise<void> {
    this.off = this.s.on((method, params, sessionId) => {
      if (method === 'Fetch.requestPaused' && sessionId === undefined) {
        void this.handle(params);
      }
    });

    await this.s.cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] });
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
    const request = params.request as { url?: string } | undefined;
    const site = siteOf(request?.url ?? '');

    // 子框架的文档、非 http(s) 的导航（about:blank、blob: 等）不在站点授权的范围里。
    if (params.frameId !== this.s.mainFrameId || site === null) {
      await this.continue(requestId);
      return;
    }

    let decision = this.decisions.get(site);
    if (!decision) {
      decision = this.decide(site).catch(() => false);
      this.decisions.set(site, decision);
    }

    if (await decision) {
      await this.continue(requestId);
      return;
    }

    this.blocked = site;
    try {
      await this.s.cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
    } catch {
      // 请求已经没了。
    }
  }

  private async continue(requestId: string): Promise<void> {
    try {
      await this.s.cdp.send('Fetch.continueRequest', { requestId });
    } catch {
      // 请求已经没了（页面又跳走了）。
    }
  }
}
