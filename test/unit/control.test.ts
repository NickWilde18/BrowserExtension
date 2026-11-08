import { describe, expect, it, vi } from 'vitest';
import { ConversationControl } from '../../src/browser/control';
import { MemoryKV } from '../../src/storage';
import type { RequestFrame, ResultFrame } from '../../src/protocol/frames';

const request = (action: RequestFrame['action'] = 'read', conversation = 'A'): RequestFrame => ({
  type: 'request', request_id: crypto.randomUUID(), action, args: {}, conversation,
  conversation_title: '测试任务', deadline_ms: 30000, auth_wait_ms: 60000,
});
const ok = (r: RequestFrame): ResultFrame => ({ type: 'result', request_id: r.request_id, outcome: 'ok' });

describe('显式对话接管', () => {
  it('释放确认前保持接管中并阻止本对话，其他对话不受影响', async () => {
    let released!: () => void;
    const stop = vi.fn(() => new Promise<void>((resolve) => { released = resolve; }));
    const control = new ConversationControl(new MemoryKV(), stop, () => {});
    await control.ready;
    const taking = control.takeOver('A');
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('A'));
    expect(control.view('A').mode).toBe('taking_over');
    await expect(control.begin(request('click'), true)).rejects.toMatchObject({ code: 'user_stopped' });
    await expect(control.begin(request('read', 'B'), true)).resolves.toBe(0);
    released();
    await taking;
    expect(control.view('A').mode).toBe('user');
  });

  it('等确认是对话级计数：最后一个确认结束才撤销；只在显示变化时通知刷新；多余的撤销不变负数', async () => {
    const changed = vi.fn();
    const control = new ConversationControl(new MemoryKV(), async () => {}, changed);
    await control.ready;
    expect(control.view('A').waiting).toBe(false);
    control.awaitingUser('A', true);
    control.awaitingUser('A', true);
    expect(control.view('A').waiting).toBe(true);
    expect(control.view('B').waiting).toBe(false);
    control.awaitingUser('A', false);
    expect(control.view('A').waiting).toBe(true);
    control.awaitingUser('A', false);
    control.awaitingUser('A', false);
    expect(control.view('A').waiting).toBe(false);
    control.awaitingUser('A', true);
    expect(control.view('A').waiting).toBe(true);
    expect(changed.mock.calls).toEqual([['A'], ['A'], ['A']]);
  });

  it('恢复后必须先成功读取；迟到旧读取不能解除新的接管', async () => {
    const control = new ConversationControl(new MemoryKV(), async () => {}, () => {});
    await control.takeOver('A');
    await control.resume('A');
    await expect(control.begin(request('click'), true)).rejects.toMatchObject({ code: 'action_failed' });
    const read = request();
    const version = await control.begin(read, true);
    await control.takeOver('A');
    await control.finish(read, ok(read), version);
    expect(control.view('A').mode).toBe('user');
    await control.resume('A');
    const fresh = request();
    await control.finish(fresh, ok(fresh), await control.begin(fresh, true));
    await expect(control.begin(request('click'), true)).resolves.toBeTypeOf('number');
  });

  it('后台恢复接管中状态时先完成释放，已接管和待观察状态跨后台重建保留', async () => {
    const kv = new MemoryKV();
    await kv.set('control.conversations', { A: 'taking_over', B: 'observing' });
    let released!: () => void;
    const stop = vi.fn(() => new Promise<void>((r) => { released = r; }));
    const control = new ConversationControl(kv, stop, () => {});
    await vi.waitFor(() => expect(stop).toHaveBeenCalledWith('A'));
    expect(control.view('A').mode).toBe('taking_over');
    released();
    await control.ready;
    expect(control.view('A').mode).toBe('user');
    expect(control.view('B').mode).toBe('observing');
    const restarted = new ConversationControl(kv, async () => {}, () => {});
    await restarted.ready;
    await expect(restarted.begin(request('read'), true)).rejects.toMatchObject({ code: 'user_stopped' });
    await expect(restarted.begin(request('click', 'B'), true)).rejects.toMatchObject({ code: 'action_failed' });
  });

  it('后台在释放中回收，持久状态不得提前声称已经释放', async () => {
    const kv = new MemoryKV();
    let released!: () => void;
    const control = new ConversationControl(kv, () => new Promise<void>((r) => { released = r; }), () => {});
    const taking = control.takeOver('A');
    await vi.waitFor(async () => expect(await kv.get('control.conversations')).toBeDefined());
    expect(await kv.get('control.conversations')).toEqual({ A: 'taking_over' });
    released();
    await taking;
    expect(await kv.get('control.conversations')).toEqual({ A: 'user' });
  });
});
