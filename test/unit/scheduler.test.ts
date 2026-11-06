import { describe, expect, it } from 'vitest';

import type { RequestFrame, ResultFrame } from '../../src/protocol/frames';
import { Scheduler } from '../../src/scheduler';

let n = 0;
function req(conversation: string, action: RequestFrame['action'] = 'read'): RequestFrame {
  n++;
  return {
    type: 'request',
    request_id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
    action,
    args: {},
    conversation,
    conversation_title: '',
    deadline_ms: 1000,
    auth_wait_ms: 1000,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ok = (r: RequestFrame): ResultFrame => ({ type: 'result', request_id: r.request_id, outcome: 'ok' });
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('Scheduler', () => {
  it('同一对话串行、不同对话并行', async () => {
    const running: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>();
    const s = new Scheduler(async (r) => {
      running.push(r.request_id);
      const d = deferred();
      gates.set(r.request_id, d);
      await d.promise;
      return ok(r);
    }, () => undefined);

    const a1 = req('A');
    const a2 = req('A');
    const b1 = req('B');
    s.submit(a1);
    s.submit(a2);
    s.submit(b1);
    await flush();
    expect(running).toEqual([a1.request_id, b1.request_id]);

    gates.get(a1.request_id)?.resolve();
    await flush();
    await flush();
    expect(running).toEqual([a1.request_id, b1.request_id, a2.request_id]);
  });

  it('排队超过 8 个回 busy；同一 request_id 只处理一次；每个请求恰好一个结果', async () => {
    const results: ResultFrame[] = [];
    const d = deferred();
    const s = new Scheduler(async (r) => {
      await d.promise;
      return ok(r);
    }, (r) => results.push(r));

    const first = req('A');
    s.submit(first);
    const queued = Array.from({ length: 8 }, () => req('A'));
    for (const r of queued) {
      s.submit(r);
    }

    const ninth = req('A');
    s.submit(ninth);
    s.submit(ninth);
    s.submit(first);
    await flush();
    expect(results).toEqual([expect.objectContaining({ request_id: ninth.request_id, code: 'busy' })]);

    d.resolve();
    for (let i = 0; i < 30; i++) {
      await flush();
    }

    expect(results).toHaveLength(10);
    const ids = results.map((r) => r.request_id);
    expect(new Set(ids).size).toBe(10);
  });

  it('cancel：排队的直接回结果，正在跑的收到中止', async () => {
    const results: ResultFrame[] = [];
    let seenSignal: AbortSignal | null = null;
    const s = new Scheduler((r, signal) => {
      seenSignal = signal;
      return new Promise<ResultFrame>((resolve) => {
        signal.addEventListener('abort', () => resolve({ type: 'result', request_id: r.request_id, outcome: 'error', code: 'timeout' }));
      });
    }, (r) => results.push(r));

    const running = req('A');
    const waiting = req('A');
    s.submit(running);
    s.submit(waiting);
    await flush();

    s.cancel(waiting.request_id);
    expect(results).toEqual([expect.objectContaining({ request_id: waiting.request_id, code: 'timeout' })]);

    s.cancel(running.request_id);
    await flush();
    expect((seenSignal as AbortSignal | null)?.aborted).toBe(true);
    expect(((seenSignal as unknown as AbortSignal).reason as { code: string }).code).toBe('timeout');
    expect(results.map((r) => r.request_id)).toEqual([waiting.request_id, running.request_id]);
  });

  it('stopAll：正在跑的中止为 user_stopped，排队的都回 user_stopped', async () => {
    const results: ResultFrame[] = [];
    const s = new Scheduler((r, signal) => new Promise<ResultFrame>((resolve) => {
      signal.addEventListener('abort', () => resolve({ type: 'result', request_id: r.request_id, outcome: 'error', code: (signal.reason as { code: 'user_stopped' }).code }));
    }), (r) => results.push(r));

    s.submit(req('A'));
    s.submit(req('A'));
    s.submit(req('B'));
    await flush();
    s.stopAll('stopped');
    await flush();
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.code === 'user_stopped')).toBe(true);
  });

  it('abortAll（换了平台账号，补充约定 4）：正在跑的按给定原因中止，排队的都回这个原因', async () => {
    const results: ResultFrame[] = [];
    const s = new Scheduler((r, signal) => new Promise<ResultFrame>((resolve) => {
      signal.addEventListener('abort', () => {
        const reason = signal.reason as { code: 'timeout'; message: string };
        resolve({ type: 'result', request_id: r.request_id, outcome: 'error', code: reason.code, message: reason.message });
      });
    }), (r) => results.push(r));

    s.submit(req('A'));
    s.submit(req('A'));
    s.submit(req('B'));
    await flush();
    s.abortAll({ code: 'timeout', message: 'switched account' });
    await flush();
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.code === 'timeout' && r.message === 'switched account')).toBe(true);
    expect(s.pending).toBe(0);
  });

  it('执行器抛异常也回一个结果（action_failed），不把异常文本交出去', async () => {
    const results: ResultFrame[] = [];
    const s = new Scheduler(async () => {
      throw new Error('internal detail');
    }, (r) => results.push(r));
    s.submit(req('A'));
    await flush();
    await flush();
    expect(results).toEqual([expect.objectContaining({ outcome: 'error', code: 'action_failed' })]);
    expect(JSON.stringify(results)).not.toContain('internal detail');
  });
});
