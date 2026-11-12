// 插件自己的确认小窗（计划 4.5「站点授权」「逐次确认」）。
//
// 小窗是插件自己的页面（approval.html），用 chrome.windows.create 开成独立的弹出窗口：平台网页被 XSS
// 也点不到它。等用户点选单独计时（auth_wait_ms）；关掉窗口、请求被中止按拒绝处理并关窗，到时没答记为超时
// （和拒绝分开）且窗口留着改显示「确认已过期，请查看页面」，由用户自己关（设计状态集 07 的确认窗）。

import type { ApprovalKind } from '../protocol/frames';
import type { PromptAnswer, PromptView } from '../messages';

export type PromptOutcome = PromptAnswer | 'timeout' | 'closed' | 'aborted';

/** 每种确认在每个阶段允许的答复。 */
const ALLOWED: Record<ApprovalKind, Record<PromptView['stage'], PromptAnswer[]>> = {
  site: { choose: ['allow_once', 'allow_always', 'deny'], self_wait: [], expired: [] },
  password: { choose: ['allow', 'self', 'deny'], self_wait: ['done', 'deny'], expired: [] },
  upload: { choose: ['allow', 'deny'], self_wait: [], expired: [] },
  download: { choose: ['allow', 'deny'], self_wait: [], expired: [] },
  script: { choose: ['allow', 'deny'], self_wait: [], expired: [] },
};

export interface PromptSpec {
  kind: ApprovalKind;
  site: string;
  conversationTitle?: string;
  detail: Record<string, unknown>;
  reason?: string;
  timeoutMs: number;
  signal: AbortSignal;
}

interface Open {
  view: PromptView;
  windowId: number | null;
  resolve: ((o: PromptOutcome) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  onAbort: (() => void) | null;
  signal: AbortSignal;
}

/** 窗口操作抽出来，单测里换成假的。 */
export interface WindowOps {
  open(url: string): Promise<number>;
  close(windowId: number): Promise<void>;
  pageUrl(id: string): string;
}

export const chromeWindowOps: WindowOps = {
  async open(url) {
    // 先用紧凑尺寸打开；页面拿到内容后连同浏览器边框一起量高，不为短确认固定预留大片空白。
    // 宽度与插件弹窗一致（设计 360px 内容宽，再留出窗口边框）。
    const win = await chrome.windows.create({ url, type: 'popup', width: 380, height: 400, focused: true });
    if (win?.id === undefined) {
      throw new Error('window not created');
    }

    return win.id;
  },
  async close(windowId) {
    try {
      await chrome.windows.remove(windowId);
    } catch {
      // 用户已经关掉了。
    }
  },
  pageUrl: (id) => chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(id)}`),
};

export class PromptManager {
  private readonly open = new Map<string, Open>();

  constructor(private readonly windows: WindowOps = chromeWindowOps) {}

  /** 开一个确认小窗，等用户第一次答复。 */
  async ask(spec: PromptSpec): Promise<{ id: string; outcome: PromptOutcome }> {
    const id = crypto.randomUUID();
    const view: PromptView = {
      id,
      kind: spec.kind,
      site: spec.site,
      detail: spec.detail,
      stage: 'choose',
      expiresAt: Date.now() + spec.timeoutMs,
    };

    if (spec.reason !== undefined) {
      view.reason = spec.reason;
    }

    if (spec.conversationTitle) {
      view.conversationTitle = spec.conversationTitle;
    }

    const entry: Open = { view, windowId: null, resolve: null, timer: null, onAbort: null, signal: spec.signal };
    this.open.set(id, entry);

    const outcome = this.wait(entry, spec.timeoutMs);

    try {
      entry.windowId = await this.windows.open(this.windows.pageUrl(id));
      if (!this.open.has(id) || entry.signal.aborted) {
        await this.windows.close(entry.windowId);
      }
    } catch {
      this.finish(id, 'closed');
    }

    return { id, outcome: await outcome };
  }

  /**
   * 密码框「我自己输入」：小窗切到「完成」，等用户输完点完成。返回 done，或 deny / timeout / closed / aborted。
   * 结束后关掉小窗；超时时窗口留着显示已过期。
   */
  async waitSelfInput(id: string, timeoutMs: number): Promise<PromptOutcome> {
    const entry = this.open.get(id);
    if (!entry) {
      return 'closed';
    }

    entry.view = { ...entry.view, stage: 'self_wait', expiresAt: Date.now() + timeoutMs };
    const outcome = await this.wait(entry, timeoutMs);
    if (outcome !== 'timeout') {
      await this.dismiss(id);
    }

    return outcome;
  }

  /** 关掉小窗（答复处理完之后）。 */
  async dismiss(id: string): Promise<void> {
    const entry = this.open.get(id);
    this.open.delete(id);
    if (entry) {
      this.clear(entry);
      if (entry.windowId !== null) {
        await this.windows.close(entry.windowId);
      }
    }
  }

  /** 运行期结束时关闭全部确认；迟到的 windows.open 由 ask 的存活检查清理。 */
  async closeAll(): Promise<void> {
    const ids = [...this.open.keys()];
    await Promise.all(ids.map(async (id) => {
      const entry = this.open.get(id);
      if (entry?.resolve) {
        entry.resolve('aborted');
      }
      await this.dismiss(id);
    }));
  }

  /** 小窗页面取要显示的内容。windowId 是发消息的那个页面所在的窗口：只给它自己那一个。 */
  view(id: string, windowId: number | undefined): PromptView | null {
    const entry = this.open.get(id);
    if (!entry || entry.windowId === null || entry.windowId !== windowId) {
      return null;
    }

    return entry.view;
  }

  /** 小窗页面交答复。只收本窗口、当前阶段允许的答复。 */
  answer(id: string, windowId: number | undefined, answer: PromptAnswer): boolean {
    const entry = this.open.get(id);
    if (!entry || entry.windowId === null || entry.windowId !== windowId || !entry.resolve) {
      return false;
    }

    if (!ALLOWED[entry.view.kind][entry.view.stage].includes(answer)) {
      return false;
    }

    this.finish(id, answer);
    return true;
  }

  /** 用户自己关掉了小窗。 */
  windowClosed(windowId: number): void {
    for (const [id, entry] of this.open) {
      if (entry.windowId === windowId) {
        entry.windowId = null;
        this.finish(id, 'closed');
        this.open.delete(id);
      }
    }
  }

  private wait(entry: Open, timeoutMs: number): Promise<PromptOutcome> {
    return new Promise<PromptOutcome>((resolve) => {
      entry.resolve = resolve;
      entry.timer = setTimeout(() => this.finish(entry.view.id, 'timeout'), timeoutMs);

      if (entry.signal.aborted) {
        queueMicrotask(() => this.finish(entry.view.id, 'aborted'));
        return;
      }

      entry.onAbort = () => this.finish(entry.view.id, 'aborted');
      entry.signal.addEventListener('abort', entry.onAbort, { once: true });
    });
  }

  private finish(id: string, outcome: PromptOutcome): void {
    const entry = this.open.get(id);
    if (!entry || !entry.resolve) {
      return;
    }

    const resolve = entry.resolve;
    this.clear(entry);
    // 到时没答：窗口留着改显示「确认已过期」（答复入口随 resolve 一起失效），等用户关窗时由 windowClosed 清理。
    if (outcome === 'timeout') {
      entry.view = { ...entry.view, stage: 'expired' };
    }

    resolve(outcome);

    // 中止、窗口没了：关掉小窗，并从登记里拿掉。
    if (outcome === 'aborted' || outcome === 'closed') {
      void this.dismiss(id);
    }
  }

  private clear(entry: Open): void {
    entry.resolve = null;
    if (entry.timer !== null) {
      clearTimeout(entry.timer);
      entry.timer = null;
    }

    if (entry.onAbort) {
      entry.signal.removeEventListener('abort', entry.onAbort);
      entry.onAbort = null;
    }
  }
}
