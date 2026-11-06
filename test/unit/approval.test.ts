import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Gate } from '../../src/approval/gate';
import type { GateContext } from '../../src/approval/gate';
import { PromptManager } from '../../src/approval/prompts';
import type { WindowOps } from '../../src/approval/prompts';
import { ApprovalRegistry } from '../../src/approval/registry';
import type { OutboundFrame } from '../../src/protocol/frames';

const RID = '11111111-2222-4333-8444-555555555555';

describe('ApprovalRegistry：放行只认自己连接上、自己发出的请求', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('对得上的 approval 交出结论', async () => {
    const reg = new ApprovalRegistry();
    const { approvalId, verdict } = reg.expect(RID, 'script', 3, 15_000);
    reg.receive({ type: 'approval', request_id: RID, approval_id: approvalId, kind: 'script', decision: 'allow' }, 3);
    await expect(verdict).resolves.toEqual({ decision: 'allow' });
  });

  it.each([
    ['request_id 不对', { request_id: '99999999-2222-4333-8444-555555555555' }, 3],
    ['不是这条连接', {}, 4],
    ['kind 与发出时不同', { kind: 'site' }, 3],
    ['kind 不在五类里', { kind: 'cookies' }, 3],
    ['decision 不认识', { decision: 'yes' }, 3],
  ])('%s → ask_user', async (_name, patch, epoch) => {
    const reg = new ApprovalRegistry();
    const { approvalId, verdict } = reg.expect(RID, 'script', 3, 15_000);
    reg.receive({ type: 'approval', request_id: RID, approval_id: approvalId, kind: 'script', decision: 'allow', ...patch } as never, epoch);
    await expect(verdict).resolves.toEqual({ decision: 'ask_user' });
  });

  it('不认识的 approval_id 忽略；15 秒没回按 ask_user；连接断开按 ask_user', async () => {
    const reg = new ApprovalRegistry();
    const a = reg.expect(RID, 'site', 1, 15_000);
    reg.receive({ type: 'approval', request_id: RID, approval_id: 'a999-zzz', kind: 'site', decision: 'allow' }, 1);
    vi.advanceTimersByTime(15_000);
    await expect(a.verdict).resolves.toEqual({ decision: 'ask_user' });

    const b = reg.expect(RID, 'site', 2, 15_000);
    reg.dropEpoch(2);
    await expect(b.verdict).resolves.toEqual({ decision: 'ask_user' });
    // 之后再来的放行不算数。
    reg.receive({ type: 'approval', request_id: RID, approval_id: b.approvalId, kind: 'site', decision: 'allow' }, 2);
  });

  it('block 带理由', async () => {
    const reg = new ApprovalRegistry();
    const { approvalId, verdict } = reg.expect(RID, 'upload', 1, 15_000);
    reg.receive({ type: 'approval', request_id: RID, approval_id: approvalId, kind: 'upload', decision: 'block', reason: 'unknown site' }, 1);
    await expect(verdict).resolves.toEqual({ decision: 'block', reason: 'unknown site' });
  });
});

/** 假的窗口操作：记下开了哪些小窗，测试代码替用户点。 */
class FakeWindows implements WindowOps {
  opened: Array<{ id: string; windowId: number }> = [];
  closed: number[] = [];
  private next = 100;

  async open(url: string): Promise<number> {
    const id = new URL(url, 'chrome-extension://x/').searchParams.get('id') ?? '';
    const windowId = this.next++;
    this.opened.push({ id, windowId });
    return windowId;
  }

  async close(windowId: number): Promise<void> {
    this.closed.push(windowId);
  }

  pageUrl(id: string): string {
    return `approval.html?id=${id}`;
  }
}

function gateCtx(authMs = 60_000): GateContext & { pauses: number; resumes: number } {
  let left = authMs;
  const ctx = {
    requestId: RID,
    signal: new AbortController().signal,
    authWait: { remainingMs: () => left, consume: (ms: number) => { left -= ms; } },
    pauses: 0,
    resumes: 0,
    pauseDeadline() {
      ctx.pauses++;
    },
    resumeDeadline() {
      ctx.resumes++;
    },
  };
  return ctx;
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !cond(); i++) {
    await new Promise((r) => setTimeout(r, 1));
  }
}

describe('Gate：先问审查、再问用户', () => {
  function setup(opts: { autoMode: boolean; epoch: number; reply?: 'allow' | 'block' | 'ask_user' | null }) {
    const sentFrames: OutboundFrame[] = [];
    const registry = new ApprovalRegistry();
    const windows = new FakeWindows();
    const prompts = new PromptManager(windows);
    const gate = new Gate({
      registry,
      prompts,
      autoMode: async () => opts.autoMode,
      epoch: () => opts.epoch,
      send: async (f) => {
        sentFrames.push(f);
        if (f.type === 'approval_request' && opts.reply) {
          queueMicrotask(() => registry.receive({ type: 'approval', request_id: f.request_id, approval_id: f.approval_id, kind: f.kind, decision: opts.reply as 'allow', reason: 'r1' }, opts.epoch));
        }
      },
    });
    return { gate, prompts, windows, sentFrames };
  }

  it('审查放行：不弹小窗、不发进度，计时暂停又恢复', async () => {
    const { gate, windows, sentFrames } = setup({ autoMode: true, epoch: 1, reply: 'allow' });
    const ctx = gateCtx();
    const r = await gate.confirm(ctx, { kind: 'site', site: 'https://a.test', reviewDetail: {}, promptDetail: {} });
    expect(r).toEqual({ result: 'allow', by: 'review', scope: 'conversation' });
    expect(windows.opened).toHaveLength(0);
    expect(sentFrames.map((f) => f.type)).toEqual(['approval_request']);
    expect([ctx.pauses, ctx.resumes]).toEqual([1, 1]);
  });

  it('审查拦下：小窗带理由，用户定；前后发 awaiting_user / working', async () => {
    const { gate, prompts, windows, sentFrames } = setup({ autoMode: true, epoch: 1, reply: 'block' });
    const p = gate.confirm(gateCtx(), { kind: 'script', site: 'https://a.test', reviewDetail: { source: 'x' }, promptDetail: { source: 'x' } });
    await until(() => windows.opened.length > 0);
    const w = windows.opened[0]!;
    expect(prompts.view(w.id, w.windowId)?.reason).toBe('r1');
    // 别的窗口交不了答复。
    expect(prompts.answer(w.id, w.windowId + 1, 'allow')).toBe(false);
    // 当前阶段不允许的答复不收。
    expect(prompts.answer(w.id, w.windowId, 'allow_always')).toBe(false);
    expect(prompts.answer(w.id, w.windowId, 'allow')).toBe(true);
    await expect(p).resolves.toMatchObject({ result: 'allow', by: 'user' });
    expect(sentFrames.map((f) => (f.type === 'progress' ? `progress:${f.stage}` : f.type)))
      .toEqual(['approval_request', 'progress:awaiting_user', 'progress:working']);
  });

  it('开关关掉或没连上：不发审批请求，直接问用户；站点的两种允许映射到范围', async () => {
    const off = setup({ autoMode: false, epoch: 1, reply: 'allow' });
    const p1 = off.gate.confirm(gateCtx(), { kind: 'site', site: 'https://a.test', reviewDetail: {}, promptDetail: {} });
    await until(() => off.windows.opened.length > 0);
    off.prompts.answer(off.windows.opened[0]!.id, off.windows.opened[0]!.windowId, 'allow_always');
    await expect(p1).resolves.toMatchObject({ result: 'allow', scope: 'always' });
    expect(off.sentFrames.some((f) => f.type === 'approval_request')).toBe(false);

    const offline = setup({ autoMode: true, epoch: 0, reply: 'allow' });
    const p2 = offline.gate.confirm(gateCtx(), { kind: 'site', site: 'https://a.test', reviewDetail: {}, promptDetail: {} });
    await until(() => offline.windows.opened.length > 0);
    offline.prompts.answer(offline.windows.opened[0]!.id, offline.windows.opened[0]!.windowId, 'allow_once');
    await expect(p2).resolves.toMatchObject({ result: 'allow', scope: 'conversation' });
    expect(offline.sentFrames).toHaveLength(0);
  });

  it('等用户超时、用户关掉小窗都按拒绝', async () => {
    const { gate, prompts, windows } = setup({ autoMode: false, epoch: 1 });
    await expect(gate.confirm(gateCtx(30), { kind: 'upload', site: 's', reviewDetail: {}, promptDetail: {} }))
      .resolves.toEqual({ result: 'deny', why: 'timeout' });

    const p = gate.confirm(gateCtx(), { kind: 'download', site: 's', reviewDetail: {}, promptDetail: {} });
    await until(() => windows.opened.length > 1);
    prompts.windowClosed(windows.opened[1]!.windowId);
    await expect(p).resolves.toEqual({ result: 'deny', why: 'user' });
  });

  it('密码框「我自己输入」：小窗留着，切到完成阶段', async () => {
    const { gate, prompts, windows } = setup({ autoMode: false, epoch: 1 });
    const p = gate.confirm(gateCtx(), { kind: 'password', site: 's', reviewDetail: { field: 'pw' }, promptDetail: { field: 'pw' } });
    await until(() => windows.opened.length > 0);
    const w = windows.opened[0]!;
    prompts.answer(w.id, w.windowId, 'self');
    const r = await p;
    expect(r).toEqual({ result: 'self', promptId: w.id });
    expect(windows.closed).toHaveLength(0);

    const done = prompts.waitSelfInput(w.id, 5000);
    await until(() => prompts.view(w.id, w.windowId)?.stage === 'self_wait');
    expect(prompts.answer(w.id, w.windowId, 'done')).toBe(true);
    await expect(done).resolves.toBe('done');
    expect(windows.closed).toEqual([w.windowId]);
  });
});
