// 一个请求执行期间的上下文：计时、标签与附着、站点授权、逐次确认、下载、导航拦截。

import type { Gate, GateContext } from '../approval/gate';
import type { PromptManager } from '../approval/prompts';
import type { DownloadSeen, DownloadWatcher } from '../browser/downloads';
import { NavGuard } from '../browser/navguard';
import type { CapturedDownload } from '../browser/navguard';
import type { SessionManager } from '../browser/sessions';
import type { TabSession } from '../browser/tab-session';
import type { TabRegistry } from '../browser/tabs';
import type { ExecutionBackend } from '../browser/backend';
import { TransportError } from '../connection/transport';
import type { Transport } from '../connection/transport';
import { isUnattachableUrl, siteOf } from '../policy/url';
import type { SiteStore } from '../policy/sites';
import { ActionError } from '../protocol/errors';
import type { RequestFrame } from '../protocol/frames';
import type { AbortReason } from '../scheduler';

export interface Services {
  backend?: ExecutionBackend;
  tabs: TabRegistry;
  sessions: SessionManager;
  sites: SiteStore;
  gate: Gate;
  prompts: PromptManager;
  downloads: DownloadWatcher;
  transport(): Transport | null;
  maxFileBytes(): number;
  stopped(): boolean;
  /** 正在执行动作的 AI 标签（后台据此关掉动作期间从它冒出来的新标签，见 newtab-guard.ts）。 */
  acting: Set<number>;
  /** 动作之外发生、要在这个对话的下一个结果里告诉模型的事（如被取消的下载）。 */
  notices: Notices;
}

export interface Notices {
  add(conversation: string, text: string): void;
  /** 取走这个对话攒下的说明。 */
  take(conversation: string): string[];
}

/** 下载处理的结果，进触发它的那个动作的 payload。 */
export interface DownloadOutcome {
  file?: { file_id: string; kind: 'download'; name: string; size: number; content_type: string };
  denied?: boolean;
  timedOut?: boolean;
  /**
   * 用户允许了、文件没取回来（站点要求重新登录、链接只能用一次、浏览器断线、送回 Chat 失败）：动作本身已经生效，
   * 结果仍按 ok 回，payload.download_failed，这句原因进 message（契约 3.2）。
   */
  failed?: string;
  /** 只有 file_too_large（文件超过对话的文件上限）：整个结果按错误回（契约 3.2）。 */
  error?: ActionError;
}

/** 下载没成时的说明：动作本身（点击、提交）已经生效，只是文件没取回来；写明这一点，免得模型重点一次、重复提交。 */
const DOWNLOAD_DONE = 'The action itself went through (do not repeat it); ';
const DOWNLOAD_NOT_CONNECTED = DOWNLOAD_DONE + 'only the file it downloaded could not be sent to the conversation because the browser is not connected.';
const DOWNLOAD_NOT_SENT = DOWNLOAD_DONE + 'only the file it downloaded could not be sent to the conversation.';
const DOWNLOAD_TOO_LARGE = DOWNLOAD_DONE + 'only the file it downloaded is larger than the size limit for files in the conversation.';
const DOWNLOAD_NOT_RETRIEVED = DOWNLOAD_DONE + 'only the file it downloaded could not be retrieved';

/** 在页面里重新取下载失败时的原因（page-agent.ts 的 fetchDownload 返回的 reason / status）。 */
function notRetrieved(reason?: string, status?: number): string {
  if (reason === 'status' && status !== undefined) {
    return `${DOWNLOAD_NOT_RETRIEVED}: fetching it again got HTTP ${status} (the link may work only once, or the site wants the user to sign in again).`;
  }

  if (reason === 'network') {
    return `${DOWNLOAD_NOT_RETRIEVED}: the site could not be reached when fetching it again.`;
  }

  return `${DOWNLOAD_NOT_RETRIEVED}.`;
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
  /** 这个请求期间在响应阶段截下过的下载网址。 */
  private readonly capturedUrls = new Set<string>();
  private navigationTimedOut = false;
  /** 成功结果里要附给模型的说明（如下载没取回来的原因），runRequest 接在 message 后面。 */
  readonly notes: string[] = [];

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

  get conversationTitle(): string {
    return this.request.conversation_title;
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
    this.throwIfAborted();
    if (this.services.stopped()) {
      throw new ActionError('user_stopped', STOPPED_MESSAGE);
    }

    await reloadIfDiscarded(tabId, this.signal);
    this.throwIfAborted();
    const s = await this.services.sessions.get(tabId, this.request, this.signal);
    s.onDownloadWillBegin = (p) => this.services.downloads.hint(tabId, p.url, p.suggestedFilename);
    // 浏览器省电时会冻结后台页面，冻结的页面里点击等输入一直不返回（实测）：先解冻。
    await s.cdp.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => undefined);
    // 量不出来（页面正在跳转）不挡动作：后面读页面时会重新装代理。
    await s.ensureViewport().catch(() => undefined);
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
    this.throwIfAborted();
    if (await this.services.sites.isAllowed(this.conversation, site)) {
      this.throwIfAborted();
      return;
    }

    const r = await this.services.gate.confirm(this, { kind: 'site', site, reviewDetail: {}, promptDetail: {} });
    if (r.result === 'allow') {
      this.throwIfAborted();
      await this.services.sites.grant(this.conversation, site, r.scope);
      this.throwIfAborted();
      return;
    }

    this.throwIfAborted();
    throw new ActionError(r.result === 'deny' && r.why === 'timeout' ? 'approval_timeout' : 'user_denied', r.result === 'deny' && r.why === 'timeout'
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
    this.navigationTimedOut = false;
    const watch = new NavWatch(s);
    const guard = new NavGuard(s, {
      decide: (site) => this.decideNavigation(site),
      download: (d) => {
        // 响应停在拦截里等这一步做完（确认、取内容、送回 Chat），完了才回 204 取消浏览器的下载。
        const job = this.handleCapturedDownload(s, d);
        this.downloadJobs.push(job);
        return job.then(() => undefined);
      },
      aborted: () => watch.markAborted(),
    });
    await guard.enable();
    const disarm = this.services.downloads.arm(s.tabId, (d) => {
      // 表单 POST 触发的下载：响应阶段已经截下并回了 204，浏览器仍会用同一份响应再建一个下载（实测；
      // 服务端只收到一次 POST）。下载拦截那边已经把它取消、从列表里抹掉，这里不再重复确认。
      if (this.capturedUrls.has(d.url)) {
        return;
      }

      this.downloadJobs.push(this.handleDownload(s, d));
    });
    const stopWaiting = new AbortController();
    this.services.acting.add(s.tabId);
    await s.setActing(true);

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
        throw new ActionError(this.navigationTimedOut ? 'approval_timeout' : 'user_denied', this.navigationTimedOut
          ? 'Navigation confirmation timed out and the cross-site navigation was stopped. Effects already triggered cannot be undone; read the page first and do not retry automatically.'
          : `The page tried to go to ${guard.blocked}, which the user did not allow; it was stopped.`);
      }

      return outcome.kind === 'done' ? outcome.value : (undefined as T);
    } finally {
      stopWaiting.abort();
      watch.dispose();
      disarm();
      this.services.acting.delete(s.tabId);
      await s.setActing(false).catch(() => undefined);
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
      this.throwIfAborted();
      await this.services.sites.grant(this.conversation, site, r.scope);
      this.throwIfAborted();
      return true;
    }

    if (r.result === 'deny' && r.why === 'timeout') this.navigationTimedOut = true;
    return false;
  }

  /** 下载的逐次确认（kind=download）：发起站点是当前页的站点。返回是否允许。 */
  private async confirmDownload(s: TabSession, url: string, filename: string, size: number | null, contentType: string): Promise<{ allowed: boolean; timedOut: boolean }> {
    const site = siteOf(await currentUrl(s.tabId).catch(() => '')) ?? siteOf(url) ?? '';
    const detail = { filename, size, content_type: contentType };
    const r = await this.services.gate.confirm(this, { kind: 'download', site, reviewDetail: detail, promptDetail: detail });
    return { allowed: r.result === 'allow', timedOut: r.result === 'deny' && r.why === 'timeout' };
  }

  /** 送回 Chat 存成交付文件。 */
  private async deliverDownload(name: string, contentType: string, bytes: Uint8Array<ArrayBuffer>): Promise<DownloadOutcome> {
    const transport = this.services.transport();
    if (!transport) {
      return { failed: DOWNLOAD_NOT_CONNECTED };
    }

    const max = this.services.maxFileBytes();
    if (max > 0 && bytes.length > max) {
      return { error: new ActionError('file_too_large', DOWNLOAD_TOO_LARGE) };
    }

    const type = contentType.split(';')[0]?.trim() || 'application/octet-stream';
    try {
      const { file_id } = await transport.sendFile(this.requestId, { kind: 'download', name, contentType: type, data: new Blob([bytes], { type }) });
      return { file: { file_id, kind: 'download', name, size: bytes.length, content_type: type } };
    } catch (err) {
      // 413：Chat 按它的文件上限拒收（契约 2.1）。其余（断线、请求已结束）只是文件没送到。
      if (err instanceof TransportError && err.reason === 'file_too_large') {
        return { error: new ActionError('file_too_large', DOWNLOAD_TOO_LARGE) };
      }

      return { failed: DOWNLOAD_NOT_SENT };
    }
  }

  /** 导航类下载（响应阶段截下的）：逐次确认 → 取响应体 → 送回 Chat。 */
  private async handleCapturedDownload(s: TabSession, d: CapturedDownload): Promise<DownloadOutcome> {
    this.capturedUrls.add(d.url);
    const name = filenameFromDisposition(d.disposition) || filenameFromUrl(d.url);
    const max = this.services.maxFileBytes();
    if (max > 0 && d.size !== null && d.size > max) {
      return { error: new ActionError('file_too_large', DOWNLOAD_TOO_LARGE) };
    }

    const verdict = await this.confirmDownload(s, d.url, name, d.size, d.contentType);
    if (!verdict.allowed) return { denied: true, timedOut: verdict.timedOut };

    let body: Uint8Array;
    try {
      body = await d.body();
    } catch {
      return { failed: notRetrieved() };
    }

    return this.deliverDownload(name, d.contentType, new Uint8Array(body));
  }

  /** 不经导航的下载（`<a download>` 等）：逐次确认 → 页面里带登录态重新取 → 送回 Chat 存成交付文件。 */
  private async handleDownload(s: TabSession, d: DownloadSeen): Promise<DownloadOutcome> {
    const verdict = await this.confirmDownload(s, d.url, d.filename, d.size, d.contentType);
    if (!verdict.allowed) return { denied: true, timedOut: verdict.timedOut };

    if (!this.services.transport()) {
      return { failed: DOWNLOAD_NOT_CONNECTED };
    }

    const max = this.services.maxFileBytes();
    const id = crypto.randomUUID();
    let meta: { ok: boolean; reason?: string; status?: number; size?: number; contentType?: string; disposition?: string };
    let bytes: Uint8Array<ArrayBuffer>;
    try {
      meta = await s.call(s.mainFrameId, 'fetchDownload', [id, d.url, max]);
      if (!meta.ok) {
        return meta.reason === 'too_large'
          ? { error: new ActionError('file_too_large', DOWNLOAD_TOO_LARGE) }
          : { failed: notRetrieved(meta.reason, meta.status) };
      }

      const size = meta.size ?? 0;
      bytes = new Uint8Array(size);
      const chunk = 768 * 1024;
      for (let offset = 0; offset < size; offset += chunk) {
        const part = await s.call<string>(s.mainFrameId, 'downloadChunk', [id, offset, chunk]);
        bytes.set(decodeBase64(part), offset);
      }
    } catch {
      // 页面在取的过程中跳走或关掉了：内容随隔离世界没了。
      return { failed: notRetrieved() };
    } finally {
      void s.call(s.mainFrameId, 'dropDownload', [id]).catch(() => undefined);
    }

    const name = filenameFromDisposition(meta.disposition ?? '') || d.filename;
    return this.deliverDownload(name, meta.contentType || d.contentType || 'application/octet-stream', bytes);
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

export function abortPromise(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) {
      reject(abortError(signal));
      return;
    }

    signal.addEventListener('abort', () => reject(abortError(signal)), { once: true });
  });
}

/**
 * 后台标签被浏览器丢弃（省内存）后没有页面进程，附着不上也读不了：先重新加载，等加载完。重新加载的是
 * 它原来的网址，站点没有变。
 */
async function reloadIfDiscarded(tabId: number, signal: AbortSignal): Promise<void> {
  let tab: chrome.tabs.Tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new ActionError('no_tab', 'The browser tab for this conversation was closed; use browser_open to open a new one.');
  }

  if (!tab.discarded) {
    return;
  }

  await chrome.tabs.reload(tabId);
  const until = Date.now() + 15_000;
  while (!signal.aborted && Date.now() < until) {
    const now = await chrome.tabs.get(tabId).catch(() => null);
    if (!now) {
      throw new ActionError('no_tab', 'The browser tab for this conversation was closed; use browser_open to open a new one.');
    }

    if (!now.discarded && now.status === 'complete') {
      return;
    }

    await new Promise((r) => setTimeout(r, 100));
  }
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

/** 网址最后一段当文件名（响应头里没有时）。 */
export function filenameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return sanitizeFilename(last ? decodeURIComponent(last) : 'download');
  } catch {
    return 'download';
  }
}

/** 文件名去掉路径分隔与控制字符，限长。 */
export function sanitizeFilename(name: string): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = name.replace(/[\u0000-\u001f\u007f/\\]/g, '_').trim();
  return [...cleaned].slice(0, 200).join('') || 'file';
}

/** 等页面稳定：动作之后短暂等导航开始，开始了就等加载完（或等到它被取消）。 */
class NavWatch {
  private started = false;
  private stopped = false;
  private readonly off: () => void;

  constructor(private readonly s: TabSession) {
    this.off = s.on((method, params, sessionId) => {
      if (sessionId !== undefined || params.frameId !== s.mainFrameId) {
        return;
      }

      // 下载链接也会先报一次「请求导航」（disposition=download），页面并不跳转。
      if (method === 'Page.frameRequestedNavigation' && params.disposition !== 'download') {
        this.started = true;
        this.stopped = false;
      } else if (method === 'Page.frameStartedLoading') {
        this.started = true;
        this.stopped = false;
      } else if (method === 'Page.frameStoppedLoading') {
        this.stopped = true;
      }
    });
  }

  /** 导航被导航拦截回 204 取消了：不会再有加载完成的事件，别等。 */
  markAborted(): void {
    this.stopped = true;
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
