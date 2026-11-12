// 对话级显式接管。只保存稳定对话 ID 与控制模式，不保存网页内容或 URL。
import type { KV } from '../storage';
import type { ActionName, RequestFrame, ResultFrame } from '../protocol/frames';
import { ActionError } from '../protocol/errors';

export type ControlMode = 'assistant' | 'taking_over' | 'user' | 'observing';
export interface ControlView {
  mode: ControlMode;
  title: string;
  action: ActionName | null;
  /** 这段对话有确认窗开着、在等用户：控制条显示「等待你确认」，引导去确认窗，不在网页里重复授权。 */
  waiting: boolean;
}
interface Entry { mode: ControlMode; title: string; action: ActionName | null; version: number; requestId?: string }
const KEY = 'control.conversations';

export class ConversationControl {
  readonly ready: Promise<void>;
  private readonly entries = new Map<string, Entry>();
  /** 每段对话开着的确认窗个数（同一对话的多个请求可能同时在等）。只在内存：后台重启时确认窗也随之作废。 */
  private readonly awaiting = new Map<string, number>();
  private readonly taking = new Map<string, Promise<void>>();
  private writing: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(private readonly kv: KV, private readonly stop: (conversation: string) => Promise<void>,
    private readonly changed: (conversation: string) => void) {
    this.ready = this.load();
  }

  view(conversation: string): ControlView {
    const e = this.entry(conversation);
    return { mode: e.mode, title: e.title, action: e.action, waiting: (this.awaiting.get(conversation) ?? 0) > 0 };
  }

  /** 确认门在弹出 / 收起确认窗时调用；只在「有没有在等」变化时通知刷新控制条。 */
  awaitingUser(conversation: string, on: boolean): void {
    const before = this.awaiting.get(conversation) ?? 0;
    const after = on ? before + 1 : Math.max(0, before - 1);
    if (after === 0) this.awaiting.delete(conversation);
    else this.awaiting.set(conversation, after);
    if ((before > 0) !== (after > 0) && !this.disposed) this.changed(conversation);
  }

  list(): Array<{ conversation: string; title: string; mode: ControlMode }> {
    return [...this.entries].filter(([, e]) => e.mode !== 'assistant')
      .map(([conversation, e]) => ({ conversation, title: e.title || conversation.slice(0, 8), mode: e.mode }));
  }

  async begin(request: RequestFrame, hasTab: boolean): Promise<number> {
    await this.ready;
    const e = this.entry(request.conversation);
    if (this.disposed || e.mode === 'user' || e.mode === 'taking_over') {
      throw new ActionError('user_stopped', "The user has taken over this conversation's browser tabs. Ask the user to click 'Let the assistant continue' on the page or in the extension popup; do not retry.");
    }
    if (e.mode === 'observing') {
      const observation = request.action === 'read' || (request.action === 'tabs' && request.args.op === 'list');
      const freshPage = !hasTab && (request.action === 'open' || (request.action === 'tabs' && request.args.op === 'new'));
      if (!observation && !freshPage) throw new ActionError('action_failed', 'Read the current page again before continuing after user control. Do not replay a cancelled action; its result may be unknown.');
    }
    e.title = request.conversation_title;
    e.action = request.action;
    e.requestId = request.request_id;
    this.changed(request.conversation);
    return e.version;
  }

  async finish(request: RequestFrame, result: ResultFrame, version: number): Promise<void> {
    const e = this.entry(request.conversation);
    if (this.disposed || e.version !== version) return;
    if (e.requestId === request.request_id) e.action = null;
    if (e.mode === 'observing' && request.action === 'read' && result.outcome === 'ok') {
      e.mode = 'assistant';
      try { await this.save(); } catch (error) {
        if (e.version === version) e.mode = 'observing';
        throw error;
      }
    }
    this.changed(request.conversation);
  }

  async takeOver(conversation: string): Promise<void> {
    await this.ready;
    if (this.disposed) throw new Error('stale_epoch');
    const existing = this.taking.get(conversation);
    if (existing) return existing;
    const e = this.entry(conversation);
    if (e.mode === 'user') return;
    e.mode = 'taking_over';
    e.version++;
    this.changed(conversation);
    const stopping = this.stop(conversation);
    const job = Promise.all([this.save(), stopping]).then(async () => {
      if (this.disposed) throw new Error('stale_epoch');
      e.mode = 'user';
      e.action = null;
      await this.save();
      this.changed(conversation);
    }).finally(() => this.taking.delete(conversation));
    this.taking.set(conversation, job);
    return job;
  }

  async resume(conversation: string): Promise<void> {
    await this.ready;
    const e = this.entry(conversation);
    if (this.disposed || e.mode !== 'user') throw new Error('not_taken_over');
    e.mode = 'observing';
    const version = ++e.version;
    e.action = null;
    try { await this.save(); } catch (error) { if (e.version === version) e.mode = 'user'; throw error; }
    this.changed(conversation);
  }

  async clear(): Promise<void> {
    await this.ready;
    for (const entry of this.entries.values()) entry.version++;
    this.entries.clear();
    await this.save();
  }

  dispose(): void { this.disposed = true; }

  private entry(conversation: string): Entry {
    let entry = this.entries.get(conversation);
    if (!entry) {
      entry = { mode: 'assistant', title: '', action: null, version: 0 };
      this.entries.set(conversation, entry);
    }
    return entry;
  }

  private async load(): Promise<void> {
    const saved = await this.kv.get<Record<string, ControlMode>>(KEY) ?? {};
    for (const [id, mode] of Object.entries(saved)) {
      if (mode === 'user' || mode === 'observing' || mode === 'taking_over') this.entry(id).mode = mode;
    }
    for (const [id, entry] of this.entries) {
      if (entry.mode !== 'taking_over') continue;
      await this.stop(id);
      if (this.disposed) return;
      entry.mode = 'user';
      await this.save();
      this.changed(id);
    }
  }

  private save(): Promise<void> {
    const saved: Record<string, ControlMode> = {};
    for (const [id, e] of this.entries) {
      if (e.mode !== 'assistant') saved[id] = e.mode;
    }
    const write = this.writing.catch(() => undefined).then(() => this.kv.set(KEY, saved));
    this.writing = write;
    return write;
  }
}
