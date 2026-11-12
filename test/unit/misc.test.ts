import { describe, expect, it } from 'vitest';

import { filenameFromDisposition, sanitizeFilename } from '../../src/actions/context';
import { imageSize } from '../../src/actions/read';
import { parseChord } from '../../src/browser/keys';
import { AccountWatch } from '../../src/connection/account';
import { TabRegistry } from '../../src/browser/tabs';
import type { TabOps } from '../../src/browser/tabs';
import { Identity, MemoryKeyStore, defaultDisplayName, normalizeDisplayName } from '../../src/identity';
import { ActionError } from '../../src/protocol/errors';
import { MemoryKV } from '../../src/storage';

describe('按键解析', () => {
  it('单键、组合键、别名', () => {
    expect(parseChord('Enter')).toMatchObject({ modifiers: 0, key: { key: 'Enter', keyCode: 13 } });
    expect(parseChord('Control+A')).toMatchObject({ modifiers: 2, key: { key: 'a', code: 'KeyA' } });
    expect(parseChord('Control+Shift+a')).toMatchObject({ modifiers: 10, key: { key: 'A', code: 'KeyA' } });
    expect(parseChord('Ctrl+Esc')).toMatchObject({ modifiers: 2, key: { key: 'Escape' } });
    expect(parseChord('+')).toMatchObject({ modifiers: 0, key: { key: '+', code: 'Equal' } });
    expect(parseChord('Control++')).toMatchObject({ modifiers: 2, key: { key: '+' } });
    expect(parseChord('中')).toMatchObject({ key: { key: '中', code: '', text: '中' } });
    for (const bad of ['Hyper+Q', 'Control+', 'NotAKey', '']) {
      expect(() => parseChord(bad), bad).toThrow(ActionError);
    }
  });
});

describe('显示名', () => {
  it('去掉控制字符、零宽与双向控制符，限 64 个字符', () => {
    expect(normalizeDisplayName('  Edge · Windows  ')).toBe('Edge · Windows');
    expect(normalizeDisplayName('a​b‮c\u0007')).toBe('abc');
    expect(normalizeDisplayName('​ \u0000')).toBeNull();
    expect(normalizeDisplayName('x'.repeat(100))).toHaveLength(64);
  });

  it('默认显示名按浏览器与系统', () => {
    expect(defaultDisplayName('Mozilla/5.0 ... Chrome/150 Safari/537 Edg/150', [], 'win')).toBe('Edge · Windows');
    expect(defaultDisplayName('', ['Google Chrome', 'Chromium'], 'mac')).toBe('Chrome · macOS');
    expect(defaultDisplayName('', ['Chromium'], 'linux')).toBe('Chromium · Linux');
    expect(defaultDisplayName('', [], 'cros')).toBe('Browser · ChromeOS');
  });
});

describe('安装 id', () => {
  const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  it('首次生成规范形态的 UUID（小写带连字符），之后不变', async () => {
    const id = new Identity(new MemoryKV(), new MemoryKeyStore());
    const first = await id.installId();
    expect(first).toMatch(CANONICAL);
    expect(await id.installId()).toBe(first);
  });

  it('存储里的不是规范形态（Chat 会对 frames / uploads / files 回 400）：换一个新的', async () => {
    for (const bad of ['66666666-7777-4888-9999-AAAAAAAAAAAA', '{66666666-7777-4888-9999-aaaaaaaaaaaa}', 'not-a-uuid', 42]) {
      const kv = new MemoryKV();
      await kv.set('identity.installId', bad);
      const id = await new Identity(kv, new MemoryKeyStore()).installId();
      expect(id, String(bad)).toMatch(CANONICAL);
      expect(await kv.get('identity.installId')).toBe(id);
    }
  });
});

describe('文件名与图片尺寸', () => {
  it('Content-Disposition 取文件名，去掉路径', () => {
    expect(filenameFromDisposition('attachment; filename="report.txt"')).toBe('report.txt');
    expect(filenameFromDisposition("attachment; filename*=UTF-8''%E6%8A%A5%E5%91%8A.pdf")).toBe('报告.pdf');
    expect(filenameFromDisposition('attachment; filename="../../etc/passwd"')).toBe('.._.._etc_passwd');
    expect(filenameFromDisposition('inline')).toBe('');
    expect(sanitizeFilename('')).toBe('file');
  });

  it('PNG 头里读宽高', () => {
    const png = new Uint8Array(32);
    png.set([0x89, 0x50, 0x4e, 0x47], 0);
    new DataView(png.buffer).setUint32(16, 1200);
    new DataView(png.buffer).setUint32(20, 800);
    expect(imageSize(png)).toEqual({ width: 1200, height: 800 });
  });
});

class FakeTabs implements TabOps {
  next = 10;
  groups = new Map<number, number>();
  closed: number[] = [];
  ungrouped: number[] = [];
  log: string[] = [];

  async create(): Promise<{ tabId: number; windowId: number }> {
    return { tabId: this.next++, windowId: 1 };
  }

  async group(tabId: number, groupId: number | null): Promise<number> {
    const g = groupId ?? 500 + tabId;
    this.groups.set(tabId, g);
    return g;
  }

  async titleGroup(): Promise<void> {}

  async close(tabId: number): Promise<void> {
    this.closed.push(tabId);
  }

  async ungroup(tabId: number): Promise<void> {
    this.log.push(`ungroup ${tabId}`);
    this.ungrouped.push(tabId);
  }

  async exists(): Promise<boolean> {
    return true;
  }
}

describe('TabRegistry', () => {
  it('每个对话一个 AI 标签组；新标签进同一个组', async () => {
    const ops = new FakeTabs();
    const reg = new TabRegistry(new MemoryKV(), ops);
    const t1 = await reg.createTab('c1');
    const t2 = await reg.createTab('c1');
    const t3 = await reg.createTab('c2');
    expect(ops.groups.get(t1)).toBe(ops.groups.get(t2));
    expect(ops.groups.get(t3)).not.toBe(ops.groups.get(t1));
    expect(await reg.list('c1')).toEqual([t1, t2]);
    expect(await reg.active('c1')).toBe(t2);
  });

  it('标签被拖出 AI 组就不再归这个对话；关掉的标签从登记里去掉', async () => {
    const ops = new FakeTabs();
    const reg = new TabRegistry(new MemoryKV(), ops);
    const t1 = await reg.createTab('c1');
    const t2 = await reg.createTab('c1');
    expect(await reg.onTabGroupChanged(t1, -1)).toBe('c1');
    expect(await reg.isAccessible('c1', t1)).toBe(false);
    await reg.onTabRemoved(t2);
    expect(await reg.list('c1')).toEqual([]);
    expect(await reg.active('c1')).toBeNull();
  });

  it('release 先删登记再解散组：解散触发的换组事件不会被当成拖出', async () => {
    const ops = new FakeTabs();
    const reg = new TabRegistry(new MemoryKV(), ops);
    const t1 = await reg.createTab('c1');
    ops.ungroup = async (tabId: number) => {
      // 模拟浏览器在解散组时同步派发 onUpdated(groupId=-1)。
      expect(await reg.onTabGroupChanged(tabId, -1)).toBeNull();
      ops.ungrouped.push(tabId);
    };
    const r = await reg.release('c1', true);
    expect(r).toEqual({ tabs: [t1], closed: 0 });
    expect(ops.ungrouped).toEqual([t1]);
  });

  it('共享此页：有最近对话就给它；没有时等下一个发请求的对话', async () => {
    const ops = new FakeTabs();
    const reg = new TabRegistry(new MemoryKV(), ops);
    expect(await reg.share(77)).toBeNull();
    expect(await reg.touch('c1')).toBe(77);
    expect(await reg.isShared(77)).toBe(true);
    expect(await reg.active('c1')).toBe(77);

    expect(await reg.share(88)).toBe('c1');
    // 共享页关掉只撤销共享，不关标签。
    expect(await reg.closeTab('c1', 88)).toBe(false);
    expect(ops.closed).toEqual([]);
  });

  it('对话先请求读取但没有当前页时，随后共享的页成为当前页', async () => {
    const reg = new TabRegistry(new MemoryKV(), new FakeTabs());
    await reg.touch('c1');
    expect(await reg.active('c1')).toBeNull();
    expect(await reg.share(77)).toBe('c1');
    expect(await reg.active('c1')).toBe(77);
  });

  it('「将共享给」：最近用过浏览器的对话及其标题（可为空）；没有时是下一个对话', async () => {
    const reg = new TabRegistry(new MemoryKV(), new FakeTabs());
    expect(await reg.shareTarget()).toEqual({ kind: 'next' });
    await reg.touch('c1', '选课 <b>帮忙</b>');
    expect(await reg.shareTarget()).toEqual({ kind: 'recent', title: '选课 <b>帮忙</b>' });
    await reg.touch('c2', '');
    expect(await reg.shareTarget()).toEqual({ kind: 'recent', title: '' });
    // 对话结束（browser_close）后，共享给下一个对话：与 share() 同一口径。
    await reg.release('c2', false);
    expect(await reg.shareTarget()).toEqual({ kind: 'next' });
  });

  it('换了平台账号（补充约定 4）：忘掉全部对话，AI 标签不关、只解散组，共享目标与待共享都清掉', async () => {
    const ops = new FakeTabs();
    const reg = new TabRegistry(new MemoryKV(), ops);
    const t1 = await reg.createTab('c1');
    await reg.touch('c1', '上一个账号的对话');
    expect(await reg.share(77)).toBe('c1');

    ops.ungroup = async (tabId: number) => {
      // 解散组时浏览器派发的换组事件：登记已经清掉，不再归任何对话。
      expect(await reg.onTabGroupChanged(tabId, -1)).toBeNull();
      ops.ungrouped.push(tabId);
    };
    expect(await reg.forgetAll()).toEqual([t1, 77]);
    expect(ops.ungrouped).toEqual([t1]);
    expect(ops.closed).toEqual([]);
    expect(await reg.list('c1')).toEqual([]);
    expect(await reg.isShared(77)).toBe(false);
    expect(await reg.shareTarget()).toEqual({ kind: 'next' });

    // 上一个账号点了「共享此页」还没交出去的，也不交给新账号的对话。
    const fresh = new TabRegistry(new MemoryKV(), new FakeTabs());
    expect(await fresh.share(88)).toBeNull();
    await fresh.forgetAll();
    expect(await fresh.touch('c9', 'x')).toBeNull();
  });
});

describe('AccountWatch：平台账号变了先清上一个账号的状态（补充约定 4）', () => {
  it('第一次连上只记下；同一账号不清；换了账号先清再记；记在本地存储，后台重启后照样比较', async () => {
    const kv = new MemoryKV();
    const cleared: Array<[string, string]> = [];
    const clear = async (previous: string, current: string) => {
      cleared.push([previous, current]);
    };
    const w = new AccountWatch(kv, clear);
    expect(await w.connected('one@example.test')).toBe(false);
    expect(await w.connected('one@example.test')).toBe(false);
    expect(await w.connected('two@example.test')).toBe(true);
    expect(cleared).toEqual([['one@example.test', 'two@example.test']]);

    const restarted = new AccountWatch(kv, clear);
    expect(await restarted.connected('two@example.test')).toBe(false);
    expect(await restarted.connected('one@example.test')).toBe(true);
    expect(cleared).toEqual([['one@example.test', 'two@example.test'], ['two@example.test', 'one@example.test']]);
  });

  it('清理失败时不记新账号：下一次连上再清', async () => {
    const kv = new MemoryKV();
    let fail = true;
    const calls: string[] = [];
    const w = new AccountWatch(kv, async (_previous, current) => {
      calls.push(current);
      if (fail) {
        throw new Error('storage');
      }
    });
    await w.connected('one@example.test');
    await expect(w.connected('two@example.test')).rejects.toThrow('storage');
    fail = false;
    expect(await w.connected('two@example.test')).toBe(true);
    expect(calls).toEqual(['two@example.test', 'two@example.test']);
  });
});
