import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabRegistry, type TabOps } from '../../src/browser/tabs';
import { MemoryKV } from '../../src/storage';

function fixture(group: TabOps['group']) {
  let next = 10;
  const ops: TabOps = {
    create: vi.fn(async () => ({ tabId: next++, windowId: 1 })),
    group: vi.fn(group), titleGroup: vi.fn(async () => {}),
    close: vi.fn(async () => {}), ungroup: vi.fn(async () => {}),
    exists: vi.fn(async () => true),
  };
  return { ops, reg: new TabRegistry(new MemoryKV(), ops) };
}

afterEach(() => vi.useRealTimers());

describe('原生分组不可用时的普通标签', () => {
  it('分组拒绝时仍登记并返回自己创建的标签', async () => {
    const { reg, ops } = fixture(async () => { throw new Error('unsupported'); });
    const tab = await reg.createTab('A');
    expect(await reg.list('A')).toEqual([tab]);
    expect(await reg.active('A')).toBe(tab);
    expect((await reg.get('A'))?.groupId).toBeNull();
    expect(ops.titleGroup).not.toHaveBeenCalled();
  });

  it('分组超过等待上限时返回普通标签，迟到成功不改变归属', async () => {
    vi.useFakeTimers();
    let resolve!: (id: number) => void;
    const { reg, ops } = fixture(() => new Promise<number>((r) => { resolve = r; }));
    const created = reg.createTab('A');
    let done = false;
    void created.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1100);
    expect(done).toBe(true);
    const tab = await created;
    expect(await reg.list('A')).toEqual([tab]);
    resolve(501);
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.ungroup).toHaveBeenCalledWith(tab);
    expect(ops.titleGroup).not.toHaveBeenCalled();
    expect((await reg.get('A'))?.groupId).toBeNull();
    expect(await reg.onTabGroupChanged(tab, -1)).toBeNull();
    expect(await reg.isAccessible('A', tab)).toBe(true);
  });

  it('取消分组中的创建立即退出，迟到成功不命名、不登记', async () => {
    let resolve!: (id: number) => void;
    const { reg, ops } = fixture(() => new Promise<number>((r) => { resolve = r; }));
    const ctrl = new AbortController();
    const created = reg.createTab('A', ctrl.signal);
    const rejected = expect(created).rejects.toMatchObject({ code: 'user_stopped' });
    await vi.waitFor(() => expect(ops.group).toHaveBeenCalled());
    ctrl.abort({ code: 'user_stopped' });
    await rejected;
    resolve(501);
    await vi.waitFor(() => expect(ops.ungroup).toHaveBeenCalledWith(10));
    expect(ops.close).toHaveBeenCalledWith(10);
    expect(ops.titleGroup).not.toHaveBeenCalled();
    expect(await reg.list('A')).toEqual([]);
  });

  it.each(['release', 'forgetAll', 'removed', 'replaced'] as const)('%s 不让正在分组的标签恢复登记', async (event) => {
    let resolve!: (id: number) => void;
    const { reg, ops } = fixture(() => new Promise<number>((r) => { resolve = r; }));
    const created = reg.createTab('A');
    const rejected = expect(created).rejects.toMatchObject({ code: 'timeout' });
    await vi.waitFor(() => expect(ops.group).toHaveBeenCalled());
    if (event === 'release') await reg.release('A', true);
    if (event === 'forgetAll') await reg.forgetAll();
    if (event === 'removed') await reg.onTabRemoved(10);
    if (event === 'replaced') await reg.onTabReplaced(20, 10);
    await rejected;
    resolve(501);
    await vi.waitFor(() => expect(ops.ungroup).toHaveBeenCalledWith(10));
    expect(await reg.list('A')).toEqual([]);
    expect(ops.titleGroup).not.toHaveBeenCalled();
    if (event === 'replaced') expect(ops.close).toHaveBeenCalledWith(20);
  });

  it('取消早于 tabs.create 返回时只清理迟到的新页', async () => {
    const { reg, ops } = fixture(async () => 501);
    let resolve!: (tab: { tabId: number; windowId: number }) => void;
    ops.create = vi.fn(() => new Promise<{ tabId: number; windowId: number }>((r) => { resolve = r; }));
    const ctrl = new AbortController();
    const created = reg.createTab('A', ctrl.signal);
    const rejected = expect(created).rejects.toMatchObject({ code: 'timeout' });
    await vi.waitFor(() => expect(ops.create).toHaveBeenCalled());
    ctrl.abort();
    await rejected;
    resolve({ tabId: 10, windowId: 1 });
    await vi.waitFor(() => expect(ops.close).toHaveBeenCalledWith(10));
    expect(ops.group).not.toHaveBeenCalled();
    expect(await reg.list('A')).toEqual([]);
  });

  it('混合标签跨重启保留归属，原生组仍支持拖出撤权，关闭/替换更新普通标签登记', async () => {
    const kv = new MemoryKV();
    const { ops } = fixture(async () => 501);
    let attempt = 0;
    ops.group = vi.fn(async () => { if (++attempt === 2) throw new Error('temporary'); return 501; });
    const reg = new TabRegistry(kv, ops);
    const grouped = await reg.createTab('A');
    const plain = await reg.createTab('A');
    const next = await reg.createTab('A');
    const restarted = new TabRegistry(kv, ops);
    expect(await restarted.onTabGroupChanged(plain, -1)).toBeNull();
    expect(await restarted.onTabGroupChanged(grouped, -1)).toBe('A');
    await restarted.onTabReplaced(30, plain);
    expect(await restarted.onTabGroupChanged(30, -1)).toBeNull();
    expect(await restarted.list('A')).toEqual([30, next]);
    await restarted.onTabRemoved(30);
    expect(await restarted.list('A')).toEqual([next]);
  });

  it('普通标签会话隔离；keepTabs 保留页面，关闭仅关自己的页，forgetAll 清共享与归属', async () => {
    const { reg, ops } = fixture(async () => { throw new Error('unsupported'); });
    const a = await reg.createTab('A');
    const b = await reg.createTab('B');
    expect(await reg.isAccessible('B', a)).toBe(false);
    expect(await reg.release('A', true)).toEqual({ tabs: [a], closed: 0 });
    expect(ops.close).not.toHaveBeenCalled();
    expect(await reg.list('B')).toEqual([b]);
    expect(await reg.release('B', false)).toEqual({ tabs: [b], closed: 1 });
    expect(ops.close).toHaveBeenCalledWith(b);
    const c = await reg.createTab('C');
    await reg.touch('C');
    await reg.share(77);
    expect(await reg.forgetAll()).toEqual([c, 77]);
    expect(await reg.list('C')).toEqual([]);
    expect(await reg.isShared(77)).toBe(false);
  });

  it('tabs.create 失败不尝试分组，不留下登记', async () => {
    const { reg, ops } = fixture(async () => 501);
    ops.create = vi.fn(async () => { throw new Error('create failed'); });
    await expect(reg.createTab('A')).rejects.toThrow('create failed');
    expect(ops.group).not.toHaveBeenCalled();
    expect(await reg.list('A')).toEqual([]);
  });

  it('分组与命名共用总预算，不累计两次等待', async () => {
    vi.useFakeTimers();
    const { reg, ops } = fixture(() => new Promise((resolve) => setTimeout(() => resolve(501), 800)));
    ops.titleGroup = vi.fn(() => new Promise<void>(() => {}));
    let done = false;
    const created = reg.createTab('A').then((tab) => { done = true; return tab; });
    await vi.advanceTimersByTimeAsync(900);
    expect(done).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(done).toBe(true);
    expect(await reg.list('A')).toEqual([await created]);
  });

  it('释放A不取消B正在创建的页，迟到清理只针对A的新页', async () => {
    let resolveA!: (id: number) => void;
    let resolveB!: (id: number) => void;
    const { reg, ops } = fixture((tabId) => new Promise((r) => { if (tabId === 10) resolveA = r; else resolveB = r; }));
    await reg.touch('A');
    await reg.touch('B');
    const a = reg.createTab('A');
    const rejected = expect(a).rejects.toMatchObject({ code: 'timeout' });
    const b = reg.createTab('B');
    await vi.waitFor(() => expect(ops.group).toHaveBeenCalledTimes(2));
    await reg.release('A', true);
    await rejected;
    resolveA(501);
    resolveB(502);
    const tabB = await b;
    expect(await reg.list('B')).toEqual([tabB]);
    expect(ops.ungroup).not.toHaveBeenCalledWith(tabB);
  });

  it('组命名不返回也不会阻塞创建，保留真实分组和拖出撤权', async () => {
    vi.useFakeTimers();
    const { reg, ops } = fixture(async () => 501);
    ops.titleGroup = vi.fn(() => new Promise<void>(() => {}));
    const created = reg.createTab('A');
    let done = false;
    void created.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(1100);
    expect(done).toBe(true);
    const tab = await created;
    expect(ops.ungroup).not.toHaveBeenCalled();
    expect((await reg.get('A'))?.groupId).toBe(501);
    expect(await reg.onTabGroupChanged(tab, -1)).toBe('A');
  });
});
