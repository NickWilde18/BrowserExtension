// 附着管理：按标签页附着、整任务保持附着、断开（计划 4.5「调试提示条」）。
//
// - 附着期间浏览器顶部一定会出「<插件名> 已开始调试此浏览器」，普通安装藏不掉；整个任务期间一直附着，
//   不每个动作附着一次，避免闪烁。
// - 用户点提示条上的「取消」（onDetach reason=canceled_by_user）当作叫停：不在断开回调里重新附着
//   （提示条会立刻再出来），交给上层置「已停止」，之后的请求回 user_stopped，直到用户在弹窗里恢复。

import { installCdp } from './cdp';
import type { DetachReason } from './cdp';
import { TabSession } from './tab-session';

export class SessionManager {
  private readonly sessions = new Map<number, TabSession>();
  private readonly pending = new Map<number, Promise<TabSession>>();

  constructor(private readonly onUserCancel: () => void, private readonly onTabGone: (tabId: number) => void) {
    installCdp((tabId, reason) => this.handleDetach(tabId, reason));
  }

  /** 取这个标签页的附着会话，没附着就附着。 */
  get(tabId: number): Promise<TabSession> {
    const existing = this.sessions.get(tabId);
    if (existing && !existing.detached) {
      return Promise.resolve(existing);
    }

    const inflight = this.pending.get(tabId);
    if (inflight) {
      return inflight;
    }

    const p = TabSession.attach(tabId).then((s) => {
      this.sessions.set(tabId, s);
      return s;
    }).finally(() => this.pending.delete(tabId));
    this.pending.set(tabId, p);
    return p;
  }

  /** 已附着的会话（不新附着）。 */
  peek(tabId: number): TabSession | undefined {
    const s = this.sessions.get(tabId);
    return s && !s.detached ? s : undefined;
  }

  async detach(tabId: number): Promise<boolean> {
    const s = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    if (!s || s.detached) {
      return false;
    }

    await s.detach();
    return true;
  }

  async detachAll(): Promise<number> {
    const ids = [...this.sessions.keys()];
    let n = 0;
    for (const id of ids) {
      if (await this.detach(id)) {
        n++;
      }
    }

    return n;
  }

  get attachedCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (!s.detached) {
        n++;
      }
    }

    return n;
  }

  private handleDetach(tabId: number, reason: DetachReason): void {
    const s = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    if (s) {
      s.detached = true;
    }

    if (reason === 'canceled_by_user') {
      this.onUserCancel();
      return;
    }

    if (reason === 'target_closed') {
      this.onTabGone(tabId);
    }
  }
}
