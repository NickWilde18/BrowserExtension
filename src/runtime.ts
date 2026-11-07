// 一个活动服务器的运行期。切换时销毁整个对象，旧任务只持有旧对象，不会取得新连接。
import { runRequest } from './actions';
import { STOPPED_MESSAGE, type Notices, type Services } from './actions/context';
import { Gate } from './approval/gate';
import { PromptManager } from './approval/prompts';
import { ApprovalRegistry } from './approval/registry';
import { DownloadWatcher } from './browser/downloads';
import { ConversationControl } from './browser/control';
import { Cdp } from './browser/cdp';
import { toActionError } from './protocol/errors';
import { SessionManager } from './browser/sessions';
import { TabRegistry } from './browser/tabs';
import { AccountWatch } from './connection/account';
import { ConnectionManager } from './connection/manager';
import { ScopedKV } from './connection/scoped-storage';
import type { Transport } from './connection/transport';
import type { Identity } from './identity';
import { SiteStore } from './policy/sites';
import { siteOf } from './policy/url';
import type { ResultFrame } from './protocol/frames';
import { Scheduler } from './scheduler';
import type { KV } from './storage';

const OUTBOX_TTL_MS = 2 * 60_000;
const ACCOUNT_SWITCHED = 'The browser switched to a different platform account, so this browser action was stopped.';
const SERVER_SWITCHED = 'The user changed the browser connection server, so this action was stopped.';

export interface RuntimeOptions {
  origin: string;
  local: KV;
  session: KV;
  identity: Identity;
  transport(origin: string): Transport;
  stopped(): boolean;
  onUserStop(): void;
  onControlChanged?(conversation: string): void;
  onAccountReset?(): Promise<void>;
  onDispose?(): Promise<void>;
  detachLog?: Array<{ tabId: number | null; reason: string; at: number }>;
}

export class BrowserRuntime {
  readonly epoch = crypto.randomUUID();
  readonly sites: SiteStore;
  readonly tabs: TabRegistry;
  readonly prompts = new PromptManager();
  readonly approvals = new ApprovalRegistry();
  readonly acting = new Set<number>();
  readonly sessions: SessionManager;
  readonly downloads: DownloadWatcher;
  readonly manager: ConnectionManager;
  readonly scheduler: Scheduler;
  readonly notices: Notices;
  readonly controls: ConversationControl;
  private readonly local: ScopedKV;
  private readonly session: ScopedKV;
  private readonly pendingNotices = new Map<string, string[]>();
  private readonly requestGeneration = new Map<string, number>();
  private readonly outbox: Array<{ frame: ResultFrame; at: number; generation: number }> = [];
  private generation = 0;
  private disposed = false;
  private disposal: Promise<void> | null = null;

  constructor(readonly options: RuntimeOptions) {
    this.local = new ScopedKV(options.local);
    this.session = new ScopedKV(options.session);
    this.sites = new SiteStore(this.local, this.session);
    this.tabs = new TabRegistry(this.session, undefined,
      (c) => chrome.i18n.getMessage('tabGroupTitle', [c.slice(0, 4)]) || `AI · ${c.slice(0, 4)}`);
    this.notices = {
      add: (conversation, text) => {
        if (this.disposed) return;
        const list = this.pendingNotices.get(conversation) ?? [];
        if (list.length < 10) list.push(text);
        this.pendingNotices.set(conversation, list);
      },
      take: (conversation) => {
        const list = this.pendingNotices.get(conversation) ?? [];
        this.pendingNotices.delete(conversation);
        return list;
      },
    };
    this.downloads = new DownloadWatcher({
      ownedBy: (id) => this.tabs.ownedBy(id),
      aiTabFor: async (referrer) => {
        const same = (await chrome.tabs.query({})).filter((t) => t.url === referrer && t.id !== undefined);
        if (!same.length) return null;
        for (const tab of same) if (await this.tabs.ownedBy(tab.id!) === null) return null;
        return same[0]!.id!;
      },
      stray: (conversation, d) => {
        const site = siteOf(d.referrer) ?? siteOf(d.url) ?? 'the page';
        this.notices.add(conversation, `Outside your browser actions, ${site} started downloading "${d.filename}" in your tab; it was cancelled and not saved. If you need the file, start the download again with a browser action.`);
      },
    });
    this.sessions = new SessionManager(() => {
      options.detachLog?.push({ tabId: null, reason: 'canceled_by_user', at: Date.now() });
      if (!this.disposed) options.onUserStop();
    }, (tabId) => options.detachLog?.push({ tabId, reason: 'target_closed', at: Date.now() }));
    this.controls = new ConversationControl(this.session, async (conversation) => {
      const done = this.scheduler.abortConversation(conversation, {
        code: 'user_stopped', message: 'The user took control of this conversation. Do not retry cancelled actions automatically.',
      });
      const tabs = await this.tabs.list(conversation);
      await Promise.all([done, ...tabs.map(async (id) => {
        if (!await this.sessions.detach(id)) await new Cdp(id).detach();
      })]);
    }, (conversation) => options.onControlChanged?.(conversation));
    const accounts = new AccountWatch(this.local, () => this.forgetPreviousAccount());
    this.manager = new ConnectionManager({
      transportFactory: () => options.transport(options.origin),
      hello: () => options.identity.hello(),
      beforeReady: (account) => accounts.connected(account).then(() => undefined),
      onFrame: (frame) => {
        if (this.disposed) return;
        switch (frame.type) {
          case 'request':
            this.requestGeneration.set(frame.request_id, this.generation);
            this.scheduler.submit(frame);
            break;
          case 'cancel': this.scheduler.cancel(frame.request_id); break;
          case 'approval': this.approvals.receive(frame); break;
          case 'release': {
            const generation = this.generation;
            void this.scheduler.finishTurn(frame.conversation, frame.turn_id,
              () => this.sessions.release(frame.conversation, frame.turn_id)).then(() => {
              if (!this.disposed && generation === this.generation) {
                return this.manager.send({ type: 'released', turn_id: frame.turn_id, conversation: frame.conversation });
              }
            }).catch(() => undefined);
          }
        }
      },
      onStatus: (status) => { if (status.state === 'connected') this.flushOutbox(); },
      keepAlive: () => { void chrome.runtime.getPlatformInfo(); },
    });
    const gate = new Gate({
      registry: this.approvals, prompts: this.prompts,
      autoMode: async () => (await this.local.get<boolean>('settings.autoMode')) ?? true,
      connected: () => !this.disposed && this.manager.connected,
      send: (frame) => this.manager.send(frame),
    });
    this.scheduler = new Scheduler(async (request, signal) => {
      const generation = this.generation;
      // 文件任务只能取得本次请求所属服务器、账号的传输，重连仍属同一运行期。
      const current = () => !this.disposed && generation === this.generation;
      const services: Services = {
        tabs: this.tabs, sessions: this.sessions, sites: this.sites,
        gate, prompts: this.prompts, downloads: this.downloads,
        transport: () => current() ? this.manager.transport : null,
        maxFileBytes: () => current() ? this.manager.maxFileBytes : 0,
        stopped: () => !current() || options.stopped(),
        acting: this.acting, notices: this.notices,
      };
      try {
        const version = await this.controls.begin(request, (await this.tabs.active(request.conversation)) !== null);
        const result = await runRequest(services, request, signal);
        if (current()) await this.controls.finish(request, result, version);
        return result;
      } catch (error) {
        const e = toActionError(error);
        return { type: 'result', request_id: request.request_id, outcome: 'error', code: e.code, message: e.message };
      }
    }, (frame) => {
      const generation = this.requestGeneration.get(frame.request_id) ?? this.generation;
      this.requestGeneration.delete(frame.request_id);
      this.sendResult(frame, generation);
    });
  }

  start(): void {
    void this.controls.ready.then(() => { if (!this.disposed) this.manager.start(); }).catch(() => undefined);
  }

  async stop(): Promise<void> {
    this.scheduler.stopAll(STOPPED_MESSAGE);
    await this.sessions.detachAll();
  }

  /** 不关闭网页。同步失效，再等待全部本地资源退出；新运行期不得提前启动。 */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.controls.dispose();
    this.generation++;
    this.manager.dispose();
    this.scheduler.abortAll({ code: 'user_stopped', message: SERVER_SWITCHED });
    this.approvals.clear();
    this.downloads.dispose();
    this.pendingNotices.clear();
    this.outbox.splice(0);
    const writes = Promise.allSettled([this.local.seal(), this.session.seal()]);
    this.disposal = Promise.all([
      writes, this.sessions.detachAll(), this.tabs.forgetAll(), this.prompts.closeAll(), this.options.onDispose?.(),
    ]).then(() => { this.acting.clear(); }).catch((error) => {
      this.disposal = null;
      throw error;
    });
    return this.disposal;
  }

  private async forgetPreviousAccount(): Promise<void> {
    this.generation++;
    this.outbox.splice(0);
    this.scheduler.abortAll({ code: 'timeout', message: ACCOUNT_SWITCHED });
    this.approvals.clear();
    this.pendingNotices.clear();
    await this.sessions.detachAll();
    await this.prompts.closeAll();
    await this.sites.clear();
    await this.tabs.forgetAll();
    await this.controls.clear();
    await this.options.onAccountReset?.();
  }

  private sendResult(frame: ResultFrame, generation: number): void {
    if (this.disposed || generation !== this.generation) return;
    this.manager.send(frame).catch(() => {
      if (!this.disposed && generation === this.generation) this.outbox.push({ frame, at: Date.now(), generation });
    });
  }

  private flushOutbox(): void {
    const now = Date.now();
    for (const item of this.outbox.splice(0).filter((o) => now - o.at < OUTBOX_TTL_MS)) {
      this.sendResult(item.frame, item.generation);
    }
  }
}
