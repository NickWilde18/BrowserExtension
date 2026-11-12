import type { BrowserRuntime } from '../runtime';
import { serverHostPermission } from '../connection/server-settings';
import type { PanelCommand, PanelReply } from './protocol';

interface Binding { tabId: number; documentId: string; conversation: string; token: string; epoch: string }

export class ControlBar {
  private readonly bindings = new Map<number, Binding>();
  private readonly injecting = new Map<number, Promise<void>>();
  private disposed = false;

  constructor(private readonly runtime: BrowserRuntime) {}

  async restore(): Promise<void> {
    await this.runtime.controls.ready;
    for (const tab of await chrome.tabs.query({})) if (tab.id !== undefined) await this.ensure(tab.id);
  }

  async refresh(conversation: string): Promise<void> {
    const tabs = new Set([...await this.runtime.tabs.list(conversation), ...this.bindings.keys()]);
    for (const id of tabs) await this.ensure(id);
  }

  async ensure(tabId: number, expand = false): Promise<void> {
    if (this.disposed || !chrome.scripting?.executeScript) return;
    const pending = this.injecting.get(tabId);
    if (pending) { await pending; return; }
    const job = this.inject(tabId, expand).catch(() => { this.bindings.delete(tabId); })
      .finally(() => this.injecting.delete(tabId));
    this.injecting.set(tabId, job);
    await job;
  }

  private async inject(tabId: number, expand: boolean): Promise<void> {
    const conversation = await this.runtime.tabs.conversationOf(tabId);
    const tab = await chrome.tabs.get(tabId);
    if (!conversation || !tab.url || !/^https?:\/\//.test(tab.url)
      || !await chrome.permissions.contains({ origins: [serverHostPermission(tab.url)] })) {
      await this.remove(tabId);
      return;
    }
    if (this.disposed) return;
    let binding = this.bindings.get(tabId);
    if (!binding) {
      const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['controlbar.js'] });
      const top = results.find((r) => r.frameId === 0);
      if (!top?.documentId || this.disposed) return;
      if (await this.runtime.tabs.conversationOf(tabId) !== conversation) return;
      binding = { tabId, documentId: top.documentId, conversation, token: crypto.randomUUID(), epoch: this.runtime.epoch };
      this.bindings.set(tabId, binding);
    }
    if (binding.conversation !== conversation) { await this.remove(tabId); return; }
    if (this.disposed) return;
    await chrome.tabs.sendMessage(tabId, {
      type: 'panel:render', epoch: binding.epoch, token: binding.token,
      view: this.runtime.controls.view(conversation), expand,
    }, { documentId: binding.documentId, frameId: 0 });
  }

  async remove(tabId: number): Promise<void> {
    const binding = this.bindings.get(tabId);
    this.bindings.delete(tabId);
    if (binding) await chrome.tabs.sendMessage(tabId, {
      type: 'panel:remove', epoch: binding.epoch, token: binding.token,
    }, { documentId: binding.documentId, frameId: 0 }).catch(() => undefined);
  }

  async clear(): Promise<void> {
    await Promise.all([...this.bindings.keys()].map((id) => this.remove(id)));
  }

  has(tabId: number): boolean { return !this.disposed && this.bindings.has(tabId); }

  async dispose(): Promise<void> {
    this.disposed = true;
    await this.clear();
  }

  async handle(raw: unknown, sender: chrome.runtime.MessageSender): Promise<PanelReply> {
    if (!raw || typeof raw !== 'object') return { ok: false };
    const message = raw as PanelCommand;
    if (message.type !== 'panel:takeover' && message.type !== 'panel:resume') return { ok: false };
    const id = sender.tab?.id;
    const binding = id === undefined ? undefined : this.bindings.get(id);
    const valid = () => !this.disposed && binding !== undefined && this.bindings.get(binding.tabId) === binding
      && sender.id === chrome.runtime.id && sender.frameId === 0 && sender.documentId === binding.documentId
      && message.epoch === this.runtime.epoch && message.epoch === binding.epoch && message.token === binding.token;
    if (!valid() || !binding) return { ok: false };
    try {
      const tab = await chrome.tabs.get(binding.tabId);
      if (!tab.url || !/^https?:\/\//.test(tab.url)) return { ok: false };
      if (!await chrome.permissions.contains({ origins: [serverHostPermission(tab.url)] })) return { ok: false };
      if (await this.runtime.tabs.conversationOf(binding.tabId) !== binding.conversation || !valid()) return { ok: false };
      if (message.type === 'panel:takeover') await this.runtime.controls.takeOver(binding.conversation);
      else await this.runtime.controls.resume(binding.conversation);
      if (!valid()) return { ok: false };
      return { ok: true, view: this.runtime.controls.view(binding.conversation) };
    } catch { return { ok: false }; }
  }
}
