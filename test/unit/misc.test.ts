import { describe, expect, it } from 'vitest';

import { filenameFromDisposition, sanitizeFilename } from '../../src/actions/context';
import { imageSize } from '../../src/actions/read';
import { parseChord } from '../../src/browser/keys';
import { TabRegistry } from '../../src/browser/tabs';
import type { TabOps } from '../../src/browser/tabs';
import { defaultDisplayName, normalizeDisplayName } from '../../src/identity';
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
});
