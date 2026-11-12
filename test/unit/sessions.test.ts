import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/browser/cdp', () => ({ installCdp: vi.fn() }));
vi.mock('../../src/browser/tab-session', () => ({ TabSession: { attach: vi.fn() } }));

import { SessionManager } from '../../src/browser/sessions';
import { TabSession } from '../../src/browser/tab-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function session(tabId: number) {
  const s = { tabId, detached: false, detach: vi.fn(async () => { s.detached = true; }) };
  return s as unknown as TabSession;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const attach = vi.mocked(TabSession.attach);

beforeEach(() => vi.clearAllMocks());

describe('回合附着', () => {
  it('旧轮释放不影响新轮或另一对话，轮内复用同一附着', async () => {
    attach.mockImplementation(async (id) => session(id));
    const sessions = new SessionManager(vi.fn(), vi.fn());
    const old = { conversation: 'A', turn_id: 'old' };
    const next = { conversation: 'A', turn_id: 'new' };
    const other = { conversation: 'B', turn_id: 'other' };
    const a = await sessions.get(1, old);
    expect(await sessions.get(1, old)).toBe(a);
    expect(await sessions.get(1, next)).toBe(a);
    const b = await sessions.get(2, other);
    expect(attach).toHaveBeenCalledTimes(2);

    await sessions.release('A', 'old');
    await sessions.release('A', 'old');
    expect(a.detach).not.toHaveBeenCalled();
    expect(b.detach).not.toHaveBeenCalled();
    await sessions.release('A', 'new');
    expect(a.detach).toHaveBeenCalledTimes(1);
    expect(sessions.attachedCount).toBe(1);
    await sessions.release('B', 'other');
    expect(sessions.attachedCount).toBe(0);
  });

  it('释放接住尚未完成的附着，新轮等旧附着断开后再接管', async () => {
    const attaching = deferred<TabSession>();
    const detaching = deferred<void>();
    const first = session(1);
    vi.mocked(first.detach).mockImplementation(async () => {
      first.detached = true;
      await detaching.promise;
    });
    const second = session(1);
    attach.mockReturnValueOnce(attaching.promise).mockResolvedValueOnce(second);
    const sessions = new SessionManager(vi.fn(), vi.fn());
    const ctrl = new AbortController();
    const oldGet = sessions.get(1, { conversation: 'A', turn_id: 'old' }, ctrl.signal);
    const aborted = expect(oldGet).rejects.toThrow('ended');
    ctrl.abort(new Error('ended'));
    const released = sessions.release('A', 'old');
    const nextGet = sessions.get(1, { conversation: 'A', turn_id: 'new' });
    attaching.resolve(first);
    await aborted;
    await flush();
    expect(first.detach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledTimes(1);
    detaching.resolve();
    await released;
    expect(await nextGet).toBe(second);
    expect(attach).toHaveBeenCalledTimes(2);
    expect(sessions.attachedCount).toBe(1);
  });

  it('旧服务没有回合标识时仍由空闲回收负责；已取消动作不重新附着', async () => {
    attach.mockImplementation(async (id) => session(id));
    const sessions = new SessionManager(vi.fn(), vi.fn());
    const legacy = await sessions.get(1, { conversation: 'A' });
    await sessions.get(1, { conversation: 'A', turn_id: 'new' });
    await sessions.release('A', 'new');
    expect(legacy.detach).not.toHaveBeenCalled();
    const ctrl = new AbortController();
    ctrl.abort(new Error('ended'));
    await expect(sessions.get(2, { conversation: 'A', turn_id: 'new' }, ctrl.signal)).rejects.toThrow('ended');
    expect(attach).toHaveBeenCalledTimes(1);
    expect(await sessions.detachAll()).toBe(1);
  });
});
