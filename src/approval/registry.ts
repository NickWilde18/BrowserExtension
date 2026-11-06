// 等着 Chat 回 approval 的审批登记（契约 3.3、计划 4.8 必做项第 5 条「放行只认自己的连接」）。
//
// 插件只接受：自己这条连接上（epoch 相同）、对应自己发出的 request_id 与 approval_id、kind 与发出时
// 相同且在五类里的 approval。对不上的一律当 ask_user——宁可多问用户一次，也不让伪造或串线的帧放行。
// 15 秒没回、连接断开，也按 ask_user。

import type { ApprovalDecision, ApprovalFrame, ApprovalKind } from '../protocol/frames';
import { isApprovalDecision, isApprovalKind } from '../protocol/frames';

export interface ApprovalVerdict {
  decision: ApprovalDecision;
  reason?: string;
}

interface Pending {
  requestId: string;
  kind: ApprovalKind;
  epoch: number;
  resolve: (v: ApprovalVerdict) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class ApprovalRegistry {
  private readonly pending = new Map<string, Pending>();
  private seq = 0;

  /** 发出 approval_request 之前登记，返回 approval_id 与结论。 */
  expect(requestId: string, kind: ApprovalKind, epoch: number, timeoutMs: number): { approvalId: string; verdict: Promise<ApprovalVerdict> } {
    const suffix = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
    const approvalId = `a${++this.seq}-${suffix}`;

    const verdict = new Promise<ApprovalVerdict>((resolve) => {
      const timer = setTimeout(() => this.settle(approvalId, { decision: 'ask_user' }), timeoutMs);
      this.pending.set(approvalId, { requestId, kind, epoch, resolve, timer });
    });

    return { approvalId, verdict };
  }

  /** 收到一帧 approval；fromEpoch 是这帧所在连接的编号。 */
  receive(frame: ApprovalFrame, fromEpoch: number): void {
    const p = this.pending.get(frame.approval_id);
    if (!p) {
      return;
    }

    const matches = p.requestId === frame.request_id && p.epoch === fromEpoch && fromEpoch > 0 &&
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

  /** 一条连接断开：它上面等着的审批都按 ask_user 处理。 */
  dropEpoch(epoch: number): void {
    for (const [id, p] of this.pending) {
      if (p.epoch === epoch) {
        this.settle(id, { decision: 'ask_user' });
      }
    }
  }

  /** 请求被中止时撤掉还在等的审批。 */
  abandon(approvalId: string): void {
    this.settle(approvalId, { decision: 'ask_user' });
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
