// 等着 Chat 回 approval 的审批登记（契约 3.3、计划 4.8 必做项第 5 条「放行只认自己的连接」）。
//
// 「自己的连接」是插件自己发起的下行连接：帧只从那里来（ConnectionManager 只交出当前连接连上之后的帧）。下行连接
// 5 分钟轮换、断线重连之后，旧连接上开始的请求，它的 approval 从新连接发来（补充约定 1），所以不按是哪一条连接
// 匹配，只认：对应自己发出的 request_id 与 approval_id、kind 与发出时相同且在五类里的 approval。对不上的一律当
// ask_user——宁可多问用户一次，也不让伪造或串线的帧放行。15 秒没回按 ask_user；连接断开不提前放弃（结论可能从
// 新连接来）。

import type { ApprovalDecision, ApprovalFrame, ApprovalKind } from '../protocol/frames';
import { isApprovalDecision, isApprovalKind } from '../protocol/frames';

export interface ApprovalVerdict {
  decision: ApprovalDecision;
  reason?: string;
}

interface Pending {
  requestId: string;
  kind: ApprovalKind;
  resolve: (v: ApprovalVerdict) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalRegistry {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  /** 发出 approval_request 之前登记，返回 approval_id 与结论。 */
  expect(requestId: string, kind: ApprovalKind, timeoutMs: number): { approvalId: string; verdict: Promise<ApprovalVerdict> } {
    const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
    const approvalId = `a${++this.seq}-${suffix}`;

    const verdict = new Promise<ApprovalVerdict>((resolve) => {
      const timer = setTimeout(() => this.settle(approvalId, { decision: 'ask_user' }), timeoutMs);
      this.pending.set(approvalId, { requestId, kind, resolve, timer });
    });

    return { approvalId, verdict };
  }

  /** 收到一帧 approval（来自插件自己发起的下行连接，哪一条都算）。 */
  receive(frame: ApprovalFrame): void {
    const p = this.pending.get(frame.approval_id);
    if (!p) {
      return;
    }

    const matches = p.requestId === frame.request_id &&
      isApprovalKind(frame.kind) && frame.kind === p.kind && isApprovalDecision(frame.decision);

    if (!matches) {
      this.settle(frame.approval_id, { decision: 'ask_user' });
      return;
    }

    const verdict: ApprovalVerdict = { decision: frame.decision };
    if (frame.reason !== undefined) {
      verdict.reason = frame.reason;
    }

    this.settle(frame.approval_id, verdict);
  }

  /** 请求被中止时撤掉还在等的审批。 */
  abandon(approvalId: string): void {
    this.settle(approvalId, { decision: 'ask_user' });
  }

  /** 服务器运行期结束，不允许它的迟到审批影响新的连接。 */
  clear(): void {
    for (const id of this.pending.keys()) this.abandon(id);
  }

  private settle(approvalId: string, verdict: ApprovalVerdict): void {
    const p = this.pending.get(approvalId);
    if (!p) {
      return;
    }

    this.pending.delete(approvalId);
    clearTimeout(p.timer);
    p.resolve(verdict);
  }
}
