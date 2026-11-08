// 逐次确认的流程（契约 3.3、计划 4.5 与 4.8）：
//
//  1. 弹窗开关「Auto Mode 下由平台审查代替我确认」开着、连接可用时，先发 approval_request 并原地等
//     （最多 15 秒）：allow 直接继续、不弹小窗；block（带理由）、ask_user、超时、发不出去都回到小窗。
//  2. 小窗由用户定；等用户点选按 auth_wait_ms 计时，到时没答记为超时（approval_timeout），和主动拒绝分开。
//  3. 审查与等用户的耗时都算在 auth_wait_ms 里，不算动作超时：期间暂停动作计时。
//
// 等用户之前发 progress{awaiting_user}，用户点完发 progress{working}（契约 3.2）；确认窗开着的期间同时告诉网页
// 控制条这段对话在等确认。每次确认的结果类别记到请求上下文，随结果帧交给 Chat 写进操作记录（只有种类和结论）。

import { APPROVAL_REPLY_TIMEOUT_MS } from '../config';
import type { ApprovalKind, ApprovalNote, OutboundFrame } from '../protocol/frames';
import type { ApprovalRegistry } from './registry';
import type { PromptManager, PromptOutcome } from './prompts';

export type { ApprovalNote };

/** 一次确认所在的请求。 */
export interface GateContext {
  requestId: string;
  /** 请求所属的对话：控制条按它显示「等待你确认」。 */
  conversation: string;
  /** 记下这次确认的结果类别。 */
  noteApproval(note: ApprovalNote): void;
  /** 请求已有的对话标题，只用于本地确认窗。 */
  conversationTitle?: string;
  signal: AbortSignal;
  /** 剩余的等用户时限（毫秒），每次确认从中扣除。 */
  authWait: { remainingMs(): number; consume(ms: number): void };
  /** 动作计时：确认期间暂停。 */
  pauseDeadline(): void;
  resumeDeadline(): void;
}

export type ConfirmResult =
  | { result: 'allow'; by: 'review' | 'user'; scope: 'conversation' | 'always'; promptId?: string }
  | { result: 'self'; promptId: string }
  | { result: 'deny'; why: 'user' | 'timeout' | 'aborted' };

export interface GateDeps {
  registry: ApprovalRegistry;
  prompts: PromptManager;
  autoMode(): Promise<boolean>;
  /** 现在有没有可用的连接（没连上时不问审查、不发进度）。 */
  connected(): boolean;
  send(frame: OutboundFrame): Promise<void>;
  /** 对话开始 / 结束等用户确认（确认窗开着的这段时间）。 */
  awaitingUser?(conversation: string, on: boolean): void;
}

function noteOf(kind: ApprovalKind, r: ConfirmResult): ApprovalNote {
  if (r.result === 'allow') {
    return { kind, by: r.by, outcome: r.by === 'user' && r.scope === 'always' ? 'allow_always' : 'allow' };
  }

  if (r.result === 'self') {
    return { kind, by: 'user', outcome: 'self' };
  }

  return { kind, by: 'user', outcome: r.why === 'user' ? 'deny' : r.why };
}

export interface ConfirmRequest {
  kind: ApprovalKind;
  site: string;
  /** 发给 Chat 审查的材料（契约 3.3 表格，密码框只有字段名、没有值）。 */
  reviewDetail: Record<string, unknown>;
  /** 小窗里显示的内容（与审查材料相同，脚本另有全文）。 */
  promptDetail: Record<string, unknown>;
}

export class Gate {
  constructor(private readonly deps: GateDeps) {}

  async confirm(ctx: GateContext, req: ConfirmRequest): Promise<ConfirmResult> {
    ctx.pauseDeadline();
    const started = Date.now();
    try {
      const result = await this.run(ctx, req, started);
      ctx.noteApproval(noteOf(req.kind, result));
      return result;
    } finally {
      ctx.authWait.consume(Date.now() - started);
      ctx.resumeDeadline();
    }
  }

  private async run(ctx: GateContext, req: ConfirmRequest, started: number): Promise<ConfirmResult> {
    let reason: string | undefined;

    if (this.deps.connected() && await this.deps.autoMode()) {
      const verdict = await this.askReview(ctx, req);
      if (verdict.decision === 'allow') {
        return { result: 'allow', by: 'review', scope: 'conversation' };
      }

      if (verdict.decision === 'block') {
        reason = verdict.reason ?? '';
      }
    }

    if (ctx.signal.aborted) {
      return { result: 'deny', why: 'aborted' };
    }

    // 审查已经用掉的时间也算在等用户的时限里。
    const remaining = ctx.authWait.remainingMs() - (Date.now() - started);
    if (remaining <= 0) {
      return { result: 'deny', why: 'timeout' };
    }

    await this.progress(ctx.requestId, 'awaiting_user', req.kind);
    const spec = {
      kind: req.kind,
      site: req.site,
      detail: req.promptDetail,
      timeoutMs: remaining,
      signal: ctx.signal,
      ...(ctx.conversationTitle ? { conversationTitle: ctx.conversationTitle } : {}),
      ...(reason !== undefined ? { reason } : {}),
    };
    this.deps.awaitingUser?.(ctx.conversation, true);
    let asked: Awaited<ReturnType<PromptManager['ask']>>;
    try {
      asked = await this.deps.prompts.ask(spec);
    } finally {
      this.deps.awaitingUser?.(ctx.conversation, false);
    }

    const { id, outcome } = asked;
    await this.progress(ctx.requestId, 'working');

    return this.interpret(req.kind, id, outcome);
  }

  private async askReview(ctx: GateContext, req: ConfirmRequest): Promise<{ decision: string; reason?: string }> {
    const { approvalId, verdict } = this.deps.registry.expect(ctx.requestId, req.kind, APPROVAL_REPLY_TIMEOUT_MS);
    const onAbort = () => this.deps.registry.abandon(approvalId);
    ctx.signal.addEventListener('abort', onAbort, { once: true });

    try {
      await this.deps.send({
        type: 'approval_request',
        request_id: ctx.requestId,
        approval_id: approvalId,
        kind: req.kind,
        site: req.site,
        detail: req.reviewDetail,
      });
    } catch {
      this.deps.registry.abandon(approvalId);
    }

    try {
      return await verdict;
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
    }
  }

  private interpret(kind: ApprovalKind, promptId: string, outcome: PromptOutcome): ConfirmResult {
    switch (outcome) {
      case 'allow_once':
        void this.deps.prompts.dismiss(promptId);
        return kind === 'site' ? { result: 'allow', by: 'user', scope: 'conversation' } : { result: 'deny', why: 'user' };
      case 'allow_always':
        void this.deps.prompts.dismiss(promptId);
        return kind === 'site' ? { result: 'allow', by: 'user', scope: 'always' } : { result: 'deny', why: 'user' };
      case 'allow':
        void this.deps.prompts.dismiss(promptId);
        return kind === 'site' ? { result: 'deny', why: 'user' } : { result: 'allow', by: 'user', scope: 'conversation' };
      case 'self':
        // 小窗留着：调用方把焦点放到字段上，再用 PromptManager.waitSelfInput 等用户点「完成」。
        return kind === 'password' ? { result: 'self', promptId } : { result: 'deny', why: 'user' };
      case 'timeout':
        return { result: 'deny', why: 'timeout' };
      case 'aborted':
        return { result: 'deny', why: 'aborted' };
      default:
        void this.deps.prompts.dismiss(promptId);
        return { result: 'deny', why: 'user' };
    }
  }

  private async progress(requestId: string, stage: 'awaiting_user' | 'working', kind?: ApprovalKind): Promise<void> {
    if (!this.deps.connected()) {
      return;
    }

    try {
      await this.deps.send(kind ? { type: 'progress', request_id: requestId, stage, kind } : { type: 'progress', request_id: requestId, stage });
    } catch {
      // 进度只影响 Chat 侧的等待与卡片显示；发不出去不影响确认本身。
    }
  }
}
