// chrome.debugger 的薄封装：按标签页附着、发命令（含跨源 iframe 的子会话）、分发事件。
//
// 这里只是传输；插件对调试接口的用法写死在 browser/ 与 actions/ 里，服务端发不来任意命令（计划 4.6）。

/** 调试命令失败。message 是调试接口的原始报错，只用于插件内部判断，不原样交给模型。 */
export class CdpError extends Error {
  constructor(readonly method: string, message: string) {
    super(message);
    this.name = 'CdpError';
  }
}

export type CdpListener = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void;

/** 附着断开的原因：用户点了提示条上的「取消」、标签页关掉了，或插件自己断开。 */
export type DetachReason = 'canceled_by_user' | 'target_closed' | 'self';

const listeners = new Map<number, Set<CdpListener>>();
let detachHandler: ((tabId: number, reason: DetachReason) => void) | null = null;
let installed = false;

/** 注册全局的事件与断开回调（后台启动时调一次）。 */
export function installCdp(onDetach: (tabId: number, reason: DetachReason) => void): void {
  detachHandler = onDetach;
  if (installed) {
    return;
  }

  installed = true;
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === undefined) {
      return;
    }

    const set = listeners.get(source.tabId);
    if (!set) {
      return;
    }

    for (const l of set) {
      try {
        l(method, (params ?? {}) as Record<string, unknown>, source.sessionId);
      } catch {
        // 一个监听者出错不影响别的。
      }
    }
  });

  chrome.debugger.onDetach.addListener((source, reason) => {
    if (source.tabId === undefined) {
      return;
    }

    detachHandler?.(source.tabId, reason === 'canceled_by_user' ? 'canceled_by_user' : 'target_closed');
  });
}

export class Cdp {
  constructor(readonly tabId: number) {}

  async attach(): Promise<void> {
    try {
      await chrome.debugger.attach({ tabId: this.tabId }, '1.3');
    } catch (err) {
      throw new CdpError('attach', err instanceof Error ? err.message : String(err));
    }
  }

  async detach(): Promise<void> {
    listeners.delete(this.tabId);
    try {
      await chrome.debugger.detach({ tabId: this.tabId });
    } catch {
      // 已经断开（标签页关了、用户点了取消）。
    }
  }

  async send<T = Record<string, unknown>>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> {
    const target: chrome.debugger.DebuggerSession = { tabId: this.tabId };
    if (sessionId) {
      target.sessionId = sessionId;
    }

    try {
      return (await chrome.debugger.sendCommand(target, method, params)) as T;
    } catch (err) {
      throw new CdpError(method, err instanceof Error ? err.message : String(err));
    }
  }

  on(listener: CdpListener): () => void {
    let set = listeners.get(this.tabId);
    if (!set) {
      set = new Set();
      listeners.set(this.tabId, set);
    }

    set.add(listener);
    return () => {
      listeners.get(this.tabId)?.delete(listener);
    };
  }
}
