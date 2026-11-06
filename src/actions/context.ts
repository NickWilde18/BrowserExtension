// 一个请求执行期间的上下文：计时、标签与附着、站点授权、逐次确认、下载、导航拦截。

import type { Gate, GateContext } from '../approval/gate';
import type { PromptManager } from '../approval/prompts';
import type { DownloadSeen, DownloadWatcher } from '../browser/downloads';
import { NavGuard } from '../browser/navguard';
import type { SessionManager } from '../browser/sessions';
import type { TabSession } from '../browser/tab-session';
import type { TabRegistry } from '../browser/tabs';
import type { Transport } from '../connection/transport';
import { isUnattachableUrl, siteOf } from '../policy/url';
import type { SiteStore } from '../policy/sites';
import { ActionError } from '../protocol/errors';
import type { RequestFrame } from '../protocol/frames';
import type { AbortReason } from '../scheduler';

export interface Services {
  tabs: TabRegistry;
  sessions: SessionManager;
  sites: SiteStore;
  gate: Gate;
  prompts: PromptManager;
  downloads: DownloadWatcher;
  transport(): Transport | null;
  maxFileBytes(): number;
  stopped(): boolean;
}

/** 下载处理的结果，进触发它的那个动作的 payload。 */
export interface DownloadOutcome {
  file?: { file_id: string; kind: 'download'; name: string; size: number; content_type: string };
  denied?: boolean;
  error?: ActionError;
}

/** 动作执行完、等页面稳定的上限。 */
const SETTLE_MAX_MS = 10_000;
/** 动作之后等页面开始导航（点击触发的跳转是异步的）的时间。 */
const NAV_GRACE_MS = 500;

export class ActionContext implements GateContext {
  readonly signal: AbortSignal;
  private readonly deadlineCtrl = new AbortController();
  private deadlineTimer: ReturnType<typeof setTimeout> | null = null;
  private deadlineLeft: number;
  private deadlineStartedAt = 0;
  private paused = 0;
  private authLeft: number;
  private readonly downloadJobs: Array<Promise<DownloadOutcome>> = [];

  constructor(readonly request: RequestFrame, readonly services: Services, outer: AbortSignal) {
    this.deadlineLeft = request.deadline_ms;
    this.authLeft = request.auth_wait_ms;
    this.signal = AbortSignal.any([outer, this.deadlineCtrl.signal]);
    this.startDeadline();
  }

  get conversation(): string {
    return this.request.conversation;
  }

  get requestId(): string {
    return this.request.request_id;
  }

  readonly authWait = {
    remainingMs: (): number => Math.max(0, this.authLeft),
    consume: (ms: number): void => {
      this.authLeft -= ms;
    },
  };

  pauseDeadline(): void {
    if (this.paused++ === 0 && this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
      this.deadlineLeft -= Date.now() - this.deadlineStartedAt;
    }
  }

  resumeDeadline(): void {
    if (this.paused > 0 && --this.paused === 0) {
      this.startDeadline();
    }
  }

  /** 动作计时还剩多少毫秒（暂停期间不走）。 */
  remainingMs(): number {
    if (this.paused > 0 || this.deadlineTimer === null) {
      return Math.max(0, this.deadlineLeft);
    }

    return Math.max(0, this.deadlineLeft - (Date.now() - this.deadlineStartedAt));
  }

  dispose(): void {
    if (this.deadlineTimer !== null) {
      clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
  }

  /** 中止了就抛出对应的错误（超时 / 用户叫停）。 */
  throwIfAborted(): void {
    if (this.signal.aborted) {
      throw abortError(this.signal);
    }
  }

  /** 本对话当前的 AI 标签（已附着）。没有时抛 no_tab。 */
  async currentSession(): Promise<TabSession> {
    const tabId = await this.services.tabs.active(this.conversation);
    if (tabId === null) {
      throw new ActionError('no_tab', 'There is no open browser tab for this conversation yet; use browser_open first.');
    }

    return this.attach(tabId);
  }

  async attach(tabId: number): Promise<TabSession> {
    if (this.services.stopped()) {
      throw new ActionError('user_stopped', STOPPED_MESSAGE);
    }

    const s = await this.services.sessions.get(tabId);
    s.onDownloadWillBegin = (p) => this.services.downloads.hint(tabId, p.url, p.suggestedFilename);
    return s;
  }

  /**
   * 动作前的站点授权：AI 当前标签所在的站点没授权过就先问（Auto Mode 下先交审查）。返回当前站点，
   * about:blank 这类不需要授权的返回 null。
   */
  async ensureSite(s: TabSession): Promise<string | null> {
    const url = await currentUrl(s.tabId);
    if (isUnattachableUrl(url)) {
      throw new ActionError('unsupported_page', 'This page cannot be controlled by the extension.');
    }

    const site = siteOf(url);
    if (site === null) {
      return null;
    }

    await this.authorizeSite(site);
    return site;
  }

  /** 站点授权：已授权直接过；否则逐次确认，拒绝抛 user_denied。 */
  async authorizeSite(site: string): Promise<void> {
    if (await this.services.sites.isAllowed(this.conversation, site)) {
      return;
    }

    const r = await this.services.gate.confirm(this, { kind: 'site', site, reviewDetail: {}, promptDetail: {} });
    if (r.result === 'allow') {
      await this.services.sites.grant(this.conversation, site, r.scope);
      return;
    }

    this.throwIfAborted();
    throw new ActionError('user_denied', r.result === 'deny' && r.why === 'timeout'
      ? `The user did not answer in time whether the assistant may use ${site}.`
      : `The user did not allow the assistant to use ${site}.`);
  }

  /** 动作前核对网址（计划 4.5）：页面在动作中途跳到了别的站点就不做。 */
  async checkSiteUnchanged(s: TabSession, expected: string | null): Promise<void> {
    const now = siteOf(await currentUrl(s.tabId));
    if (now !== expected) {
      throw new ActionError('site_changed', 'The page moved to a different site before the action could run; check the page with browser_read.');
    }
  }

  /**
   * 包住会改页面的一步：期间拦跨站的顶层导航、登记下载；做完等页面稳定（有导航就等加载完），等下载处理完。
   * 页面弹出对话框时不再等（页面脚本被它阻塞），对话框随结果的 page.dialog 交给模型。
   */
  async guarded<T>(s: TabSession, step: () => Promise<T>): Promise<T> {
    const guard = new NavGuard(s, (site) => this.decideNavigation(site));
    await guard.enable();
    const disarm = this.services.downloads.arm(s.tabId, (d) => this.downloadJobs.push(this.handleDownload(s, d)));
    const watch = new NavWatch(s);
    const stopWaiting = new AbortController();

    try {
      const dialog = s.waitFor((m) => m === 'Page.javascriptDialogOpening', 3_600_000,
        AbortSignal.any([this.signal, stopWaiting.signal]));
      const outcome = await Promise.race([
        step().then((value) => ({ kind: 'done' as const, value })),
        dialog.then(() => ({ kind: 'dialog' as const })),
        abortPromise(this.signal),
      ]);

      if (outcome.kind === 'done' && !s.dialog) {
        await watch.settle(Math.min(SETTLE_MAX_MS, this.remainingMs()), this.signal);
      }

      this.throwIfAborted();
      if (guard.blocked) {
        throw new ActionError('user_denied', `The page tried to go to ${guard.blocked}, which the user did not allow; it was stopped.`);
      }

      return outcome.kind === 'done' ? outcome.value : (undefined as T);
    } finally {
      stopWaiting.abort();
      watch.dispose();
      disarm();
      await guard.disable();
    }
  }

  /** 这一个请求期间拦下的下载的处理结果（guarded 之后调）。 */
  async downloadOutcomes(): Promise<DownloadOutcome[]> {
    return Promise.all(this.downloadJobs);
  }

  private async decideNavigation(site: string): Promise<boolean> {
    if (await this.services.sites.isAllowed(this.conversation, site)) {
      return true;
    }

    const r = await this.services.gate.confirm(this, { kind: 'site', site, reviewDetail: {}, promptDetail: {} });
    if (r.result === 'allow') {
      await this.services.sites.grant(this.conversation, site, r.scope);
      return true;
    }

    return false;
  }

  /** 下载：逐次确认 → 页面里带登录态重新取 → 送回 Chat 存成交付文件。 */
  private async handleDownload(s: TabSession, d: DownloadSeen): Promise<DownloadOutcome> {
    const site = siteOf(await currentUrl(s.tabId)) ?? siteOf(d.url) ?? '';
    const detail = { filename: d.filename, size: d.size, content_type: d.contentType };
    const r = await this.services.gate.confirm(this, { kind: 'download', site, reviewDetail: detail, promptDetail: detail });
    if (r.result !== 'allow') {
      return { denied: true };
    }

    const transport = this.services.transport();
    if (!transport) {
      return { error: new ActionError('action_failed', 'The download could not be sent to the conversation because the browser is not connected.') };
    }

    const max = this.services.maxFileBytes();
    const id = crypto.randomUUID();
    const meta = await s.call<{ ok: boolean; reason?: string; size?: number; contentType?: string; disposition?: string }>(
      s.mainFrameId, 'fetchDownload', [id, d.url, max]);

    if (!meta.ok) {
      if (meta.reason === 'too_large') {
        return { error: new ActionError('file_too_large', 'The downloaded file is larger than the size limit for files in the conversation.') };
      }

      return { error: new ActionError('action_failed', 'The download started, but the extension could not retrieve the file from the page.') };
    }

    const size = meta.size ?? 0;
    const bytes = new Uint8Array(size);
    const chunk = 768 * 1024;
    try {
      for (let offset = 0; offset < size; offset += chunk) {
        const part = await s.call<string>(s.mainFrameId, 'downloadChunk', [id, offset, chunk]);
        bytes.set(decodeBase64(part), offset);
      }
    } finally {
      void s.call(s.mainFrameId, 'dropDownload', [id]).catch(() => undefined);
    }

    const name = filenameFromDisposition(meta.disposition ?? '') || d.filename;
    const contentType = (meta.contentType || d.contentType || 'application/octet-stream').split(';')[0]?.trim() || 'application/octet-stream';
    const { file_id } = await transport.sendFile(this.requestId, { kind: 'download', name, contentType, data: new Blob([bytes], { type: contentType }) });
    return { file: { file_id, kind: 'download', name, size, content_type: contentType } };
  }

  private startDeadline(): void {
    this.deadlineStartedAt = Date.now();
    this.deadlineTimer = setTimeout(() => {
      this.deadlineTimer = null;
      this.deadlineLeft = 0;
      this.deadlineCtrl.abort({ code: 'timeout', message: 'The browser action took too long and was stopped.' } satisfies AbortReason);
    }, Math.max(0, this.deadlineLeft));
  }
}

export const STOPPED_MESSAGE = 'The user stopped the assistant from using the browser. Ask the user to resume it from the extension popup if they want you to continue.';

/** 中止原因 → ActionError。 */
export function abortError(signal: AbortSignal): ActionError {
  const reason = signal.reason as Partial<AbortReason> | undefined;
  if (reason?.code === 'user_stopped') {
    return new ActionError('user_stopped', reason.message ?? STOPPED_MESSAGE);
  }

  return new ActionError('timeout', reason?.message ?? 'The browser action took too long and was stopped.');
}

function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }

    signal.addEventListener('abort', () => reject(abortError(signal)), { once: true });
  });
}

export async function currentUrl(tabId: number): Promise<string> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return tab.url ?? tab.pendingUrl ?? '';
  } catch {
    throw new ActionError('no_tab', 'The browser tab for this conversation was closed; use browser_open to open a new one.');
  }
}

export function decodeBase64(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }

  return out;
}

export function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }

  return btoa(binary);
}

/** Content-Disposition 里的文件名（filename* 优先）。 */
export function filenameFromDisposition(header: string): string {
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(header);
  if (star?.[1]) {
    try {
      return sanitizeFilename(decodeURIComponent(star[1].trim()));
    } catch {
      // 落到下面普通的 filename。
    }
  }

  const plain = /filename\s*=\s*"?([^";]+)"?/.exec(header);
  return plain?.[1] ? sanitizeFilename(plain[1].trim()) : '';
}

/** 文件名去掉路径分隔与控制字符，限长。 */
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  return [...cleaned].slice(0, 200).join('') || 'file';
}

/** 等页面稳定：动作之后短暂等导航开始，开始了就等加载完。 */
class NavWatch {
  private started = false;
  private stopped = false;
  private readonly off: () => void;

  constructor(private readonly s: TabSession) {
    this.off = s.on((method, params, sessionId) => {
      if (sessionId !== undefined || params.frameId !== s.mainFrameId) {
        return;
      }

      if (method === 'Page.frameRequestedNavigation' || method === 'Page.frameStartedLoading') {
        this.started = true;
        this.stopped = false;
      } else if (method === 'Page.frameStoppedLoading') {
        this.stopped = true;
      }
    });
  }

  async settle(maxMs: number, signal: AbortSignal): Promise<void> {
    const until = Date.now() + maxMs;
    const grace = Date.now() + Math.min(NAV_GRACE_MS, maxMs);
    while (!signal.aborted && Date.now() < until) {
      if (this.s.dialog) {
        return;
      }

      if (this.started ? this.stopped : Date.now() >= grace) {
        return;
      }

      await new Promise((r) => setTimeout(r, 50));
    }
  }

  dispose(): void {
    this.off();
  }
}
