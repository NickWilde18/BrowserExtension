import { afterEach, describe, expect, it, vi } from 'vitest';
import { ControlBar } from '../../src/controlbar/controller';
import type { BrowserRuntime } from '../../src/runtime';

afterEach(() => vi.unstubAllGlobals());
function setup() {
  const api = {
    runtime: { id: 'extension' },
    tabs: { get: vi.fn(async () => ({ id: 10, url: 'https://example.test/page' })), sendMessage: vi.fn(async (_id: number, _message: unknown, _options?: unknown) => {}) },
    permissions: { contains: vi.fn(async () => true) },
    scripting: { executeScript: vi.fn(async () => [{ frameId: 0, documentId: 'document-1' }]) },
  };
  vi.stubGlobal('chrome', api);
  const controls = { view: vi.fn(() => ({ mode: 'assistant', title: '测试', action: null })), takeOver: vi.fn(async () => {}), resume: vi.fn(async () => {}) };
  const tabs = { conversationOf: vi.fn(async (): Promise<string | null> => 'A') };
  const runtime = { epoch: 'epoch-1', tabs, controls } as unknown as BrowserRuntime;
  const bar = new ControlBar(runtime);
  return { bar, api, tabs, controls };
}

describe('网页控制消息边界', () => {
  it('仅向有权限的归属页顶层注入，逐项校验身份、frame、document、epoch和令牌', async () => {
    const { bar, api, controls } = setup();
    await bar.ensure(10);
    expect(api.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 10, frameIds: [0] }, files: ['controlbar.js'] });
    const render = vi.mocked(api.tabs.sendMessage).mock.calls[0]![1] as any;
    const message = { type: 'panel:takeover', epoch: render.epoch, token: render.token };
    const sender = { id: 'extension', tab: { id: 10 }, frameId: 0, documentId: 'document-1' } as chrome.runtime.MessageSender;
    for (const forged of [
      { ...sender, id: 'other' }, { ...sender, frameId: 1 }, { ...sender, documentId: 'old-document' },
      { ...sender, tab: { id: 20 } },
    ]) expect(await bar.handle(message, forged as chrome.runtime.MessageSender)).toEqual({ ok: false });
    expect(await bar.handle({ ...message, epoch: 'old-epoch' }, sender)).toEqual({ ok: false });
    expect(await bar.handle({ ...message, token: 'forged' }, sender)).toEqual({ ok: false });
    expect(controls.takeOver).not.toHaveBeenCalled();
    expect(await bar.handle(message, sender)).toMatchObject({ ok: true });
    expect(controls.takeOver).toHaveBeenCalledWith('A');
  });

  it('撤销页归属或来源权限后拒绝旧面板消息', async () => {
    const { bar, api, tabs, controls } = setup();
    await bar.ensure(10);
    const render = vi.mocked(api.tabs.sendMessage).mock.calls[0]![1] as any;
    const sender = { id: 'extension', tab: { id: 10 }, frameId: 0, documentId: 'document-1' } as chrome.runtime.MessageSender;
    const message = { ...render, type: 'panel:takeover' };
    tabs.conversationOf.mockResolvedValue(null);
    expect(await bar.handle(message, sender)).toEqual({ ok: false });
    tabs.conversationOf.mockResolvedValue('A');
    api.permissions.contains.mockResolvedValue(false);
    expect(await bar.handle(message, sender)).toEqual({ ok: false });
    expect(controls.takeOver).not.toHaveBeenCalled();
  });

  it('无权限或未登记的用户页不注入；切服后的迟到注入不渲染', async () => {
    const { bar, api, tabs } = setup();
    api.permissions.contains.mockResolvedValue(false);
    await bar.ensure(10);
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    api.permissions.contains.mockResolvedValue(true);
    tabs.conversationOf.mockResolvedValue(null);
    await bar.ensure(10);
    expect(api.scripting.executeScript).not.toHaveBeenCalled();
    tabs.conversationOf.mockResolvedValue('A');
    let complete!: (rows: Array<{ frameId: number; documentId: string }>) => void;
    api.scripting.executeScript.mockImplementation(() => new Promise((r) => { complete = r; }));
    const injecting = bar.ensure(10);
    await vi.waitFor(() => expect(api.scripting.executeScript).toHaveBeenCalled());
    await bar.dispose();
    complete([{ frameId: 0, documentId: 'document-1' }]);
    await injecting;
    expect(api.tabs.sendMessage).not.toHaveBeenCalled();
  });
});
