// 请求调度（契约 3.2）：
// - 同一对话的请求串行执行，不同对话之间并行；
// - 一个对话排队超过 MAX_QUEUED_PER_CONVERSATION 个时直接回 busy；
// - 同一个 request_id 再次到达时忽略（Chat 不会重发：点击、提交都不是幂等的）；
// - 每个 request_id 恰好回一次 result（cancel 掉的、被叫停的也回，Chat 丢弃）。

import { MAX_QUEUED_PER_CONVERSATION } from './config';
import type { ErrorCode } from './protocol/errors';
import type { RequestFrame, ResultFrame } from './protocol/frames';

/** 中止一个请求的原因，作为 AbortSignal.reason 传给执行器。 */
export interface AbortReason {
  code: Extract<ErrorCode, 'timeout' | 'user_stopped'>;
  message: string;
}

export type Executor = (request: RequestFrame, signal: AbortSignal) => Promise<ResultFrame>;

interface Lane {
  running: { request: RequestFrame; ctrl: AbortController } | null;
  queue: RequestFrame[];
}

/** 记住见过的 request_id 的个数上限（去重用）。 */
const SEEN_LIMIT = 2000;

export class Scheduler {
  private readonly lanes = new Map<string, Lane>();
  private readonly seen = new Set<string>();
  private readonly answered = new Set<string>();

  constructor(
    private readonly execute: Executor,
    private readonly emit: (result: ResultFrame) => void,
    private readonly maxQueued = MAX_QUEUED_PER_CONVERSATION,
  ) {}

  submit(request: RequestFrame): void {
    if (this.seen.has(request.request_id)) {
      return;
    }

    this.remember(request.request_id);

    const lane = this.lane(request.conversation);
    if (lane.running && lane.queue.length >= this.maxQueued) {
      this.answer({
        type: 'result',
        request_id: request.request_id,
        outcome: 'error',
        code: 'busy',
        message: 'Too many browser actions are waiting in this conversation; wait for them to finish.',
      });
      return;
    }

    lane.queue.push(request);
    this.pump(request.conversation);
  }

  /** Chat 取消一个请求：还在排队的直接回结果，正在跑的中止。 */
  cancel(requestId: string): void {
    for (const [conversation, lane] of this.lanes) {
      if (lane.running?.request.request_id === requestId) {
        lane.running.ctrl.abort({ code: 'timeout', message: 'The platform cancelled this action.' } satisfies AbortReason);
        return;
      }

      const i = lane.queue.findIndex((r) => r.request_id === requestId);
      if (i >= 0) {
        lane.queue.splice(i, 1);
        this.answer({
          type: 'result',
          request_id: requestId,
          outcome: 'error',
          code: 'timeout',
          message: 'The platform cancelled this action before it ran.',
        });
        this.dropIfIdle(conversation);
        return;
      }
    }
  }

  /** 用户叫停（提示条上的「取消」、弹窗里的「停止」）：正在跑的中止，排队的全部回 user_stopped。 */
  stopAll(message: string): void {
    this.abortAll({ code: 'user_stopped', message });
  }

  /** 全部中止（用户叫停、换了平台账号）：正在跑的按 reason 中止，排队的都按 reason 回结果。 */
  abortAll(reason: AbortReason): void {
    for (const [conversation, lane] of this.lanes) {
      lane.running?.ctrl.abort(reason);

      for (const r of lane.queue.splice(0)) {
        this.answer({ type: 'result', request_id: r.request_id, outcome: 'error', code: reason.code, message: reason.message });
      }

      this.dropIfIdle(conversation);
    }
  }

  /** 正在跑或排队的请求数（弹窗显示、空闲判断用）。 */
  get pending(): number {
    let n = 0;
    for (const lane of this.lanes.values()) {
      n += lane.queue.length + (lane.running ? 1 : 0);
    }

    return n;
  }

  private pump(conversation: string): void {
    const lane = this.lanes.get(conversation);
    if (!lane || lane.running) {
      return;
    }

    const request = lane.queue.shift();
    if (!request) {
      this.dropIfIdle(conversation);
      return;
    }

    const ctrl = new AbortController();
    lane.running = { request, ctrl };

    void this.run(request, ctrl).finally(() => {
      lane.running = null;
      this.pump(conversation);
    });
  }

  private async run(request: RequestFrame, ctrl: AbortController): Promise<void> {
    let result: ResultFrame;
    try {
      result = await this.execute(request, ctrl.signal);
    } catch {
      result = {
        type: 'result',
        request_id: request.request_id,
        outcome: 'error',
        code: 'action_failed',
        message: 'The browser could not complete this action.',
      };
    }

    this.answer({ ...result, request_id: request.request_id });
  }

  private answer(result: ResultFrame): void {
    if (this.answered.has(result.request_id)) {
      return;
    }

    this.answered.add(result.request_id);
    if (this.answered.size > SEEN_LIMIT) {
      const oldest = this.answered.values().next().value;
      if (oldest !== undefined) {
        this.answered.delete(oldest);
      }
    }

    this.emit(result);
  }

  private remember(requestId: string): void {
    this.seen.add(requestId);
    if (this.seen.size > SEEN_LIMIT) {
      const oldest = this.seen.values().next().value;
      if (oldest !== undefined) {
        this.seen.delete(oldest);
      }
    }
  }

  private lane(conversation: string): Lane {
    let lane = this.lanes.get(conversation);
    if (!lane) {
      lane = { running: null, queue: [] };
      this.lanes.set(conversation, lane);
    }

    return lane;
  }

  private dropIfIdle(conversation: string): void {
    const lane = this.lanes.get(conversation);
    if (lane && !lane.running && lane.queue.length === 0) {
      this.lanes.delete(conversation);
    }
  }
}
