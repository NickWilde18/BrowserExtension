import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActionContext } from '../../src/actions/context';
import type { Services } from '../../src/actions/context';
import { readDocument } from '../../src/browser/dom-read';
import { TabRegistry } from '../../src/browser/tabs';
import type { TabOps } from '../../src/browser/tabs';
import { SiteStore } from '../../src/policy/sites';
import { MemoryKV } from '../../src/storage';
import type { RequestFrame } from '../../src/protocol/frames';
import type { ReadArgs } from '../../src/protocol/args';

const conversation = '20000000-0000-4000-8000-000000000001';
const origin = 'https://fixture.invalid';
const readArgs: ReadArgs = { boxes: false };
const request: RequestFrame = {
  type: 'request', request_id: '10000000-0000-4000-8000-000000000001', conversation,
  conversation_title: '', action: 'read', args: {}, deadline_ms: 5000, auth_wait_ms: 5000,
};

afterEach(() => vi.unstubAllGlobals());

async function fixture() {
  const tabs = new TabRegistry(new MemoryKV(), { exists: async () => true } as unknown as TabOps);
  const sites = new SiteStore(new MemoryKV(), new MemoryKV());
  await tabs.touch(conversation);
  await tabs.share(7);
  await sites.grant(conversation, origin, 'conversation');
  let nativePermission = true;
  let beginRead!: () => void;
  const started = new Promise<void>((resolve) => { beginRead = resolve; });
  let finishRead!: () => void;
  const reading = new Promise<void>((resolve) => { finishRead = resolve; });
  let executions = 0;
  type RemovedListener = (p: { origins?: string[] }) => void;
  const removedListeners = new Set<RemovedListener>();
  const outer = new AbortController();
  vi.stubGlobal('chrome', {
    tabs: { get: async () => ({ id: 7, url: origin + '/page' }) },
    permissions: {
      contains: async () => nativePermission,
      onRemoved: {
        addListener: (l: RemovedListener) => removedListeners.add(l),
        removeListener: (l: RemovedListener) => removedListeners.delete(l),
      },
    },
    scripting: { executeScript: async (options: { args?: unknown[] }) => {
      // 带参数的是读取本身；只有第一次读取挂起，便于测重授后的新请求。其余调用（安装检查、文档令牌）返回同一令牌。
      if (!options.args) return [{ frameId: 0, result: 'synthetic-document-proof' }];
      executions++;
      if (executions === 1) {
        beginRead();
        await reading;
      }
      return [{ frameId: 0, result: { snapshot: '合成页面内容', token: 'synthetic-document-proof',
        page: { url: origin + '/page', title: '合成页面', origin } } }];
    } },
  });
  const ctx = new ActionContext(request, { tabs, sites } as Services, outer.signal);
  return {
    ctx, tabs, sites, started, finishRead, outer, removedListeners,
    revokeNative: () => { nativePermission = false; },
    // 模拟浏览器原生权限被用户移除：先改权限状态，再派发移除事件。
    removeNative: (origins: string[], revoke = true) => {
      if (revoke) nativePermission = false;
      for (const l of [...removedListeners]) l({ origins });
    },
  };
}

describe('只读期间撤销授权', () => {
  it('授权未改变时允许返回读取内容', async () => {
    const f = await fixture();
    try {
      const result = readDocument(f.ctx, readArgs);
      await f.started;
      f.finishRead();
      await expect(result).resolves.toMatchObject({ payload: { snapshot: '合成页面内容' } });
    } finally { f.ctx.dispose(); }
  });

  for (const kind of ['share', 'site'] as const) {
    it(`撤销${kind}后立即重授也不能恢复旧读取`, async () => {
      const f = await fixture();
      try {
        const result = readDocument(f.ctx, readArgs);
        await f.started;
        if (kind === 'share') {
          await f.tabs.unshare(7);
          await f.tabs.share(7);
        } else {
          await f.sites.revoke(origin);
          await f.sites.grant(conversation, origin, 'conversation');
        }
        f.finishRead();
        await expect(result).rejects.toMatchObject({ code: kind === 'share' ? 'no_tab' : 'user_denied' });
      } finally { f.ctx.dispose(); }
    });
  }

  for (const kind of ['share', 'site'] as const) {
    it(`撤销无关${kind}不得影响当前读取`, async () => {
      const f = await fixture();
      try {
        await f.tabs.touch('other-conversation');
        await f.tabs.share(8);
        await f.tabs.touch(conversation);
        const result = readDocument(f.ctx, readArgs);
        await f.started;
        if (kind === 'share') await f.tabs.unshare(8);
        else await f.sites.revoke('https://other.invalid');
        f.finishRead();
        await expect(result).resolves.toMatchObject({ payload: { snapshot: '合成页面内容' } });
      } finally { f.ctx.dispose(); }
    });
  }

  for (const kind of ['share', 'site', 'native'] as const) {
    it(`读取尚未返回时撤销${kind}不得回传已读取内容`, async () => {
      const f = await fixture();
      try {
        const result = readDocument(f.ctx, readArgs);
        // 在真实读取边界挂起后撤销，保证测的是在途结果，不是入口拒绝。
        await f.started;
        if (kind === 'share') await f.tabs.unshare(7);
        else if (kind === 'site') await f.sites.revoke(origin);
        else f.revokeNative();
        f.finishRead();
        await expect(result).rejects.toMatchObject({ code: kind === 'share' ? 'no_tab' : kind === 'site' ? 'user_denied' : 'unsupported_page' });
      } finally { f.ctx.dispose(); }
    });
  }

  // 不调用 finishRead：浏览器调用一直挂着，撤销必须让读取自己尽快返回，而不是等页面结果。
  const prompt = { timeout: 1000 };
  const entryPoints: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void, string]> = [
    ['取消共享', (f) => f.tabs.unshare(7), 'no_tab'],
    ['关闭本对话的标签', (f) => f.tabs.closeTab(conversation, 7).then(() => undefined), 'no_tab'],
    ['结束本对话的浏览器操作', (f) => f.tabs.release(conversation, true).then(() => undefined), 'no_tab'],
    ['浏览器关闭标签', (f) => f.tabs.onTabRemoved(7), 'no_tab'],
    ['切换账号忘掉全部标签', (f) => f.tabs.forgetAll().then(() => undefined), 'no_tab'],
    ['撤销站点', (f) => f.sites.revoke(origin), 'user_denied'],
    ['清除全部站点授权', (f) => f.sites.clear(), 'user_denied'],
    ['移除原生站点权限', (f) => f.removeNative(['https://fixture.invalid/*']), 'unsupported_page'],
  ];
  for (const [name, revoke, code] of entryPoints) {
    it(`${name}后挂起的读取立即返回`, prompt, async () => {
      const f = await fixture();
      try {
        const result = readDocument(f.ctx, readArgs);
        await f.started;
        await revoke(f);
        await expect(result).rejects.toMatchObject({ code });
        // 迟到的页面结果被丢弃，不产生未处理的拒绝，也不改变已返回的错误。
        f.finishRead();
        await Promise.resolve();
        expect(f.tabs.revocations.size).toBe(0);
        expect(f.sites.revocations.size).toBe(0);
        expect(f.removedListeners.size).toBe(0);
      } finally { f.ctx.dispose(); }
    });
  }

  const unrelated: Array<[string, (f: Awaited<ReturnType<typeof fixture>>) => Promise<void> | void]> = [
    ['另一对话关闭同号标签', (f) => f.tabs.closeTab('other-conversation', 7).then(() => undefined)],
    ['结束另一对话的浏览器操作', (f) => f.tabs.release('other-conversation', true).then(() => undefined)],
    ['浏览器关闭无关标签', (f) => f.tabs.onTabRemoved(9)],
    ['移除其他站点的原生权限', (f) => f.removeNative(['https://other.invalid/*'], false)],
  ];
  for (const [name, revoke] of unrelated) {
    it(`${name}不得取消当前读取`, prompt, async () => {
      const f = await fixture();
      try {
        await f.tabs.touch('other-conversation');
        await f.tabs.touch(conversation);
        const result = readDocument(f.ctx, readArgs);
        await f.started;
        await revoke(f);
        f.finishRead();
        await expect(result).resolves.toMatchObject({ payload: { snapshot: '合成页面内容' } });
      } finally { f.ctx.dispose(); }
    });
  }

  it('用户停止时挂起的读取立即返回', prompt, async () => {
    const f = await fixture();
    try {
      const result = readDocument(f.ctx, readArgs);
      await f.started;
      f.outer.abort({ code: 'user_stopped', message: 'stopped' });
      await expect(result).rejects.toMatchObject({ code: 'user_stopped' });
      f.finishRead();
    } finally { f.ctx.dispose(); }
  });

  it('读取正常结束后释放登记', prompt, async () => {
    const f = await fixture();
    try {
      const result = readDocument(f.ctx, readArgs);
      await f.started;
      expect(f.tabs.revocations.size).toBe(1);
      expect(f.sites.revocations.size).toBe(1);
      expect(f.removedListeners.size).toBe(1);
      f.finishRead();
      await result;
      expect(f.tabs.revocations.size).toBe(0);
      expect(f.sites.revocations.size).toBe(0);
      expect(f.removedListeners.size).toBe(0);
    } finally { f.ctx.dispose(); }
  });

  it('撤销后重授的新读取照常成功', prompt, async () => {
    const f = await fixture();
    try {
      const first = readDocument(f.ctx, readArgs);
      await f.started;
      await f.sites.revoke(origin);
      await expect(first).rejects.toMatchObject({ code: 'user_denied' });
      f.finishRead();
      await f.sites.grant(conversation, origin, 'conversation');
      await expect(readDocument(f.ctx, readArgs)).resolves.toMatchObject({ payload: { snapshot: '合成页面内容' } });
    } finally { f.ctx.dispose(); }
  });
});
