import { afterEach, describe, expect, it, vi } from 'vitest';
afterEach(() => vi.useRealTimers());
import { TabRegistry, type TabOps } from '../../src/browser/tabs';
import { MemoryKV } from '../../src/storage';

function ops(): TabOps {
  return {
    create: vi.fn(async () => ({ tabId: 10, windowId: 1 })),
    group: vi.fn(async () => 501), titleGroup: vi.fn(async () => {}),
    close: vi.fn(async () => {}), ungroup: vi.fn(async () => {}), exists: vi.fn(async () => true),
  };
}

describe('创建登记的异步交错', () => {
  it('取消落在写存储期间，立即移除临时登记，写完也不恢复', async () => {
    const kv = new MemoryKV();
    const original = kv.set.bind(kv);
    let complete!: () => void;
    kv.set = vi.fn(async (key, value) => {
      await original(key, value);
      if (!complete) await new Promise<void>((r) => { complete = r; });
    });
    const browser = ops();
    const reg = new TabRegistry(kv, browser);
    const ctrl = new AbortController();
    const created = reg.createTab('A', ctrl.signal);
    const outcome = created.then(() => 'resolved', () => 'rejected');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    ctrl.abort();
    complete();
    expect(await outcome).toBe('rejected');
    expect(await reg.list('A')).toEqual([]);
    expect(await new TabRegistry(kv, browser).list('A')).toEqual([]);
    expect(browser.close).toHaveBeenCalledWith(10);
  });

  it.each(['removed', 'replaced'] as const)('%s 早于 create 回调时不登记失效 ID', async (event) => {
    const browser = ops();
    let complete!: (tab: { tabId: number; windowId: number }) => void;
    browser.create = vi.fn(() => new Promise<{ tabId: number; windowId: number }>((r) => { complete = r; }));
    browser.group = vi.fn(async () => { throw new Error('tab gone'); });
    const reg = new TabRegistry(new MemoryKV(), browser);
    const created = reg.createTab('A');
    const outcome = created.then(() => 'resolved', () => 'rejected');
    await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
    if (event === 'removed') await reg.onTabRemoved(10);
    else await reg.onTabReplaced(20, 10);
    complete({ tabId: 10, windowId: 1 });
    expect(await outcome).toBe('rejected');
    expect(await reg.list('A')).toEqual([]);
    if (event === 'replaced') expect(browser.close).toHaveBeenCalledWith(20);
  });

  it('回退页已替换 ID 后，迟到分组清理新 ID，不碰旧 ID', async () => {
    vi.useFakeTimers();
    const browser = ops();
    let complete!: (id: number) => void;
    browser.group = vi.fn(() => new Promise<number>((r) => { complete = r; }));
    const reg = new TabRegistry(new MemoryKV(), browser);
    const created = reg.createTab('A');
    await vi.advanceTimersByTimeAsync(1100);
    await created;
    await reg.onTabReplaced(20, 10);
    vi.mocked(browser.ungroup).mockClear();
    complete(501);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.ungroup).toHaveBeenCalledWith(20);
    expect(browser.ungroup).not.toHaveBeenCalledWith(10);
    expect(await reg.list('A')).toEqual([20]);
  });

  it('分组成功、命名失败、解组失败时仍保留拖出撤权', async () => {
    const browser = ops();
    browser.titleGroup = vi.fn(async () => { throw new Error('title unavailable'); });
    browser.ungroup = vi.fn(async () => { throw new Error('ungroup unavailable'); });
    const reg = new TabRegistry(new MemoryKV(), browser);
    const tab = await reg.createTab('A');
    expect(await reg.onTabGroupChanged(tab, -1)).toBe('A');
    expect(await reg.isAccessible('A', tab)).toBe(false);
  });
});
