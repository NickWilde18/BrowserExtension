// 附着管理：同一回合连续动作复用附着，回合结束后释放，网页与标签组保留。
// 用户点调试提示条的「取消」仍是全局叫停，不在断开回调里重新附着。

import type { RequestFrame } from '../protocol/frames';
import { installCdp } from './cdp';
import type { DetachReason } from './cdp';
import { TabSession } from './tab-session';

export class SessionManager {
  private readonly sessions = new Map<number, TabSession>();
  private readonly pending = new Map<number, Promise<TabSession>>();
  private readonly detaching = new Map<number, Promise<boolean>>();
  /** 标签页可以由新旧两轮同时持有；旧轮迟到的释放不能断开新轮的附着。 */
  private readonly owners = new Map<number, Set<string>>();

  constructor(private readonly onUserCancel: () => void, private readonly onTabGone: (tabId: number) => void) {
    installCdp((tabId, reason) => this.handleDetach(tabId, reason));
  }

  /** 取这个标签页的附着会话；正在断开时先等它结束，避免旧断开误伤新附着。 */
  async get(tabId: number, owner?: Pick<RequestFrame, 'conversation' | 'turn_id'>, signal?: AbortSignal): Promise<TabSession> {
    signal?.throwIfAborted();
    const closing = this.detaching.get(tabId);
    if (closing) {
      await closing;
      signal?.throwIfAborted();
    }

    const holders = this.owners.get(tabId) ?? new Set<string>();
    // 旧服务的动作没有回合标识，沿用空闲回收，不能被新服务的一轮 release 清掉。
    holders.add(owner ? `${owner.conversation}:${owner.turn_id ?? 'legacy'}` : 'legacy');
    this.owners.set(tabId, holders);
    const existing = this.sessions.get(tabId);
    if (existing && !existing.detached) {
      return existing;
    }

    let p = this.pending.get(tabId);
    if (!p) {
      p = TabSession.attach(tabId).then((s) => {
        this.sessions.set(tabId, s);
        return s;
      }).finally(() => this.pending.delete(tabId));
      this.pending.set(tabId, p);
    }

    const s = await p;
    signal?.throwIfAborted();
    return s;
  }

  /** 已附着的会话（不新附着）。 */
  peek(tabId: number): TabSession | undefined {
    const s = this.sessions.get(tabId);
    return s && !s.detached ? s : undefined;
  }

  /** 只撤销指定回合的持有；其它回合仍使用的标签保持附着。 */
  async release(conversation: string, turnId: string): Promise<void> {
    const key = `${conversation}:${turnId}`;
    const jobs: Array<Promise<boolean>> = [];
    for (const [tabId, holders] of this.owners) {
      if (holders.delete(key) && holders.size === 0) {
        jobs.push(this.detach(tabId));
      }
    }

    await Promise.all(jobs);
  }

  /** 强制断开一页（用户取消、关闭标签或动作超时）；也接住尚未完成的附着。 */
  detach(tabId: number): Promise<boolean> {
    const closing = this.detaching.get(tabId);
    if (closing) {
      return closing;
    }

    const p = this.detachCurrent(tabId).finally(() => this.detaching.delete(tabId));
    this.detaching.set(tabId, p);
    return p;
  }

  private async detachCurrent(tabId: number): Promise<boolean> {
    await this.pending.get(tabId)?.catch(() => undefined);
    const s = this.sessions.get(tabId);
    this.sessions.delete(tabId);
    this.owners.delete(tabId);
    if (!s || s.detached) {
      return false;
    }

    await s.detach();
    return true;
  }

  async detachAll(): Promise<number> {
    const ids = new Set([...this.sessions.keys(), ...this.pending.keys(), ...this.detaching.keys()]);
    const detached = await Promise.all([...ids].map((id) => this.detach(id)));
    return detached.filter(Boolean).length;
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
    this.owners.delete(tabId);
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
