// 对话 ↔ AI 标签的登记（计划 4.5「AI 能碰的标签页」）。
//
// AI 只碰两类标签：它为本对话自己开的；用户在弹窗里点了「共享此页」的。
// 可用时使用原生 AI 组，拖出即撤权；不可用时按登记管理普通标签，关闭即移除。
// 用户拖进组里的标签不算（没有点共享）。
// 登记存在 storage.session（后台被回收后再起来还在），浏览器关掉就没了。

import type { KV } from '../storage';
import { abortError } from '../actions/context';
import { Revocations } from '../policy/revocations';

/** 分组只是展示能力，创建与命名共用此等待预算。每次创建重新尝试，不缓存浏览器能力。 */
const GROUP_WAIT_MS = 1000;

function abortable<T>(job: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(abortError(signal));
    job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
  });
}

const KEY = 'tabs.conversations';
const LAST_KEY = 'tabs.lastConversation';
const PENDING_SHARE_KEY = 'tabs.pendingShare';
const LAST_TITLE_KEY = 'tabs.lastConversationTitle';

/** 「共享此页」会给谁（与 share() 同一口径）：最近用过浏览器的对话（带标题，可能为空），或下一个用浏览器的对话。 */
export type ShareTarget = { kind: 'next' } | { kind: 'recent'; title: string };

export interface ConversationTabs {
  groupId: number | null;
  /** 同一对话可以同时有原生组标签与回退的普通标签；旧登记缺省为空。 */
  ungrouped?: number[];
  windowId: number | null;
  /** AI 自己开的标签（按打开顺序）。 */
  tabs: number[];
  /** 用户共享进来的标签。 */
  shared: number[];
  active: number | null;
  lastUsed: number;
}

/** 浏览器标签与标签组操作，抽出来给单测换成假的。 */
export interface TabOps {
  create(windowId: number | null): Promise<{ tabId: number; windowId: number }>;
  group(tabId: number, groupId: number | null, windowId: number): Promise<number>;
  titleGroup(groupId: number, title: string): Promise<void>;
  close(tabId: number): Promise<void>;
  ungroup(tabId: number): Promise<void>;
  exists(tabId: number): Promise<boolean>;
}

/** AI 新开的标签放到后台，不抢用户正在看的标签（截图与操作对后台标签同样有效，见 README 实测）。 */
const OPEN_IN_BACKGROUND = true;

export const chromeTabOps: TabOps = {
  async create(windowId) {
    let win = windowId;
    if (win !== null) {
      try {
        await chrome.windows.get(win);
      } catch {
        win = null;
      }
    }

    if (win === null) {
      try {
        const last = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
        win = last.id ?? null;
      } catch {
        win = null;
      }
    }

    if (win === null) {
      const created = await chrome.windows.create({ url: 'about:blank', focused: false });
      const tab = created?.tabs?.[0];
      if (created?.id === undefined || tab?.id === undefined) {
        throw new Error('window not created');
      }

      return { tabId: tab.id, windowId: created.id };
    }

    const tab = await chrome.tabs.create({ windowId: win, url: 'about:blank', active: !OPEN_IN_BACKGROUND });
    if (tab.id === undefined) {
      throw new Error('tab not created');
    }

    return { tabId: tab.id, windowId: win };
  },
  async group(tabId, groupId, windowId) {
    if (groupId !== null) {
      try {
        return await chrome.tabs.group({ groupId, tabIds: [tabId] });
      } catch {
        // 组没了或在别的窗口：新建一个。
      }
    }

    return chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
  },
  async titleGroup(groupId, title) {
    await chrome.tabGroups.update(groupId, { title, color: 'purple', collapsed: false });
  },
  async close(tabId) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      // 已经关了。
    }
  },
  async ungroup(tabId) {
    try {
      await chrome.tabs.ungroup(tabId);
    } catch {
      // 标签没了或本来就不在组里。
    }
  },
  async exists(tabId) {
    try {
      await chrome.tabs.get(tabId);
      return true;
    } catch {
      return false;
    }
  },
};

export class TabRegistry {
  /** 移除标签归属时同步通知在途读取（browser/read-leases）。 */
  readonly revocations = new Revocations();
  private cache: Record<string, ConversationTabs> | null = null;
  private readonly creating = new Set<{
    conversation: string; ctrl: AbortController; tabId?: number; groupId?: number;
    lost: Map<number, number | null>; groups: Map<number, number>;
  }>();
  private saving: Promise<void> = Promise.resolve();
  /** 原生 group 可能晚于普通页登记结束；跟随该新页替换，关闭时失效。 */
  private readonly groupingTabs = new Set<{ tabId: number | null }>();

  private cancelCreating(conversation?: string): void {
    for (const pending of this.creating) {
      if (conversation === undefined || pending.conversation === conversation) pending.ctrl.abort();
    }
  }

  private async ungroup(tabId: number): Promise<void> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), GROUP_WAIT_MS);
    try {
      await abortable(Promise.resolve().then(() => this.ops.ungroup(tabId)), ctrl.signal).catch(() => undefined);
    } finally {
      clearTimeout(timer);
    }
  }

  constructor(private readonly kv: KV, private readonly ops: TabOps = chromeTabOps,
    private readonly groupTitle: (conversation: string) => string = (c) => `AI · ${c.slice(0, 4)}`) {}

  /** 这个对话现在能碰的标签：AI 自己开的在前，共享的在后。 */
  async list(conversation: string): Promise<number[]> {
    const c = (await this.all())[conversation];
    return c ? [...c.tabs, ...c.shared] : [];
  }

  async get(conversation: string): Promise<ConversationTabs | undefined> {
    return (await this.all())[conversation];
  }

  async active(conversation: string): Promise<number | null> {
    const c = (await this.all())[conversation];
    if (!c || c.active === null) {
      return null;
    }

    return [...c.tabs, ...c.shared].includes(c.active) ? c.active : null;
  }

  async isAccessible(conversation: string, tabId: number): Promise<boolean> {
    return (await this.list(conversation)).includes(tabId);
  }

  async isShared(tabId: number): Promise<boolean> {
    return Object.values(await this.all()).some((c) => c.shared.includes(tabId));
  }

  /** 哪个对话在用这个标签（AI 开的或共享的）。 */
  async conversationOf(tabId: number): Promise<string | null> {
    for (const [id, c] of Object.entries(await this.all())) {
      if (c.tabs.includes(tabId) || c.shared.includes(tabId)) {
        return id;
      }
    }

    return null;
  }

  /** 这个标签是哪个对话里 AI 自己开的（不含用户共享进来的页面）。 */
  async ownedBy(tabId: number): Promise<string | null> {
    for (const [id, c] of Object.entries(await this.all())) {
      if (c.tabs.includes(tabId)) {
        return id;
      }
    }

    return null;
  }

  /** 新开 AI 标签；原生分组不可用时按同一对话登记普通标签，不阻塞导航。 */
  async createTab(conversation: string, signal?: AbortSignal): Promise<number> {
    const pending = {
      conversation, ctrl: new AbortController(), tabId: undefined as number | undefined,
      groupId: undefined as number | undefined,
      lost: new Map<number, number | null>(), groups: new Map<number, number>(),
    };
    this.creating.add(pending);
    const canceled = signal ? AbortSignal.any([signal, pending.ctrl.signal]) : pending.ctrl.signal;
    let cancelCreated: (() => void) | undefined;
    try {
      if (canceled.aborted) throw abortError(canceled);
      const all = await this.all();
      const c = all[conversation] ?? this.blank();
      if (canceled.aborted) throw abortError(canceled);
      const creation = this.ops.create(c.windowId);
      // tabs.create 本身无法取消。迟到的新页只能清理，不能交给后续请求。
      void creation.then(({ tabId }) => {
        if (canceled.aborted) void this.ops.close(tabId).catch(() => undefined);
      }, () => undefined);
      const { tabId, windowId } = await abortable(creation, canceled);
      pending.tabId = tabId;
      let registered = false;
      cancelCreated = () => {
        // 同步撤回临时登记，后续请求不会先借用这个正在取消的标签。
        if (registered) {
          this.removeTab(conversation, c, tabId);
          void this.save().catch(() => undefined);
        }
        void this.ops.close(tabId).catch(() => undefined);
      };
      canceled.addEventListener('abort', cancelCreated, { once: true });
      if (pending.lost.has(tabId)) {
        const replacement = pending.lost.get(tabId);
        if (replacement != null) void this.ops.close(replacement).catch(() => undefined);
        pending.ctrl.abort();
      }
      if (canceled.aborted) {
        cancelCreated();
        throw abortError(canceled);
      }
      let groupId: number | null = null;
      let abandoned = false;
      const groupingTab = { tabId: tabId as number | null };
      this.groupingTabs.add(groupingTab);
      const grouping = Promise.resolve().then(() => this.ops.group(tabId, c.groupId, windowId));
      void grouping.then(() => {
        // 只解散这次创建的标签，不按 groupId 解散整个组，也不重写任何登记。
        if ((abandoned || canceled.aborted) && groupingTab.tabId !== null) void this.ungroup(groupingTab.tabId);
      }, () => undefined).finally(() => this.groupingTabs.delete(groupingTab));
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), GROUP_WAIT_MS);
      const budget = AbortSignal.any([canceled, timeout.signal]);
      try {
        groupId = await abortable(grouping, budget);
        pending.groupId = groupId;
        const observed = pending.groups.get(tabId);
        if (observed !== undefined && observed !== groupId) pending.ctrl.abort();
        if (groupId !== c.groupId && !canceled.aborted) {
          // 分组已经生效。命名失败只放弃名称，不能误标为普通页而绕过拖出撤权。
          await abortable(Promise.resolve().then(() => this.ops.titleGroup(groupId!, this.groupTitle(conversation))), budget)
            .catch(() => undefined);
        }
      } catch {
        abandoned = true;
        groupId = null;
        void this.ungroup(tabId);
      } finally {
        clearTimeout(timer);
      }
      if (canceled.aborted) {
        void this.ops.close(tabId).catch(() => undefined);
        throw abortError(canceled);
      }
      // 其他对话并发创建不会互相覆盖；同一对话由调度器串行执行。
      if (groupId !== null) c.groupId = groupId;
      else (c.ungrouped ??= []).push(tabId);
      c.windowId = windowId;
      c.tabs.push(tabId);
      c.active = tabId;
      c.lastUsed = Date.now();
      all[conversation] = c;
      registered = true;
      await this.save();
      if (canceled.aborted) {
        // 等待排在临时登记之后的撤回写入，避免后台重启重新读到已取消的页。
        await this.save();
        throw abortError(canceled);
      }
      return tabId;
    } finally {
      if (cancelCreated) canceled.removeEventListener('abort', cancelCreated);
      this.creating.delete(pending);
    }
  }

  async setActive(conversation: string, tabId: number): Promise<void> {
    const all = await this.all();
    const c = all[conversation];
    if (c && [...c.tabs, ...c.shared].includes(tabId)) {
      c.active = tabId;
      await this.save();
    }
  }

  /** 关一个 AI 标签（共享页只撤销共享、不关）。返回是否真关了。 */
  async closeTab(conversation: string, tabId: number): Promise<boolean> {
    const all = await this.all();
    const c = all[conversation];
    if (!c) {
      return false;
    }

    let closed = false;
    if (c.tabs.includes(tabId)) {
      await this.ops.close(tabId);
      closed = true;
    }

    this.removeTab(conversation, c, tabId);
    await this.save();
    return closed;
  }

  /**
   * 结束本对话的浏览器操作（browser_close）：AI 开的标签关掉（keepTabs 时只解散标签组、留给用户看），
   * 共享页只撤销共享。返回关掉的标签数；调用方负责断开附着。
   */
  async release(conversation: string, keepTabs: boolean): Promise<{ tabs: number[]; closed: number }> {
    this.cancelCreating(conversation);
    const all = await this.all();
    const c = all[conversation];
    if (!c) {
      return { tabs: [], closed: 0 };
    }

    const tabs = [...c.tabs, ...c.shared];
    // 先删登记再动标签：解散标签组会触发 onUpdated(groupId)，那时登记里还有这个对话的话，
    // 会被当成「用户把标签拖出了 AI 组」处理。
    delete all[conversation];
    this.revocations.emit({ kind: 'conversation', conversation });
    await this.save();

    let closed = 0;
    for (const tabId of c.tabs) {
      if (keepTabs) {
        await this.ungroup(tabId);
      } else {
        await this.ops.close(tabId);
        closed++;
      }
    }

    return { tabs, closed };
  }

  /** 弹窗「共享此页」：共享给最近使用浏览器的对话；还没有对话时记下，交给下一个发来请求的对话。 */
  async share(tabId: number): Promise<string | null> {
    const all = await this.all();
    for (const c of Object.values(all)) {
      if (c.tabs.includes(tabId) || c.shared.includes(tabId)) {
        return null;
      }
    }

    const last = await this.kv.get<string>(LAST_KEY);
    if (last && all[last]) {
      all[last].shared.push(tabId);
      all[last].active ??= tabId;
      await this.save();
      return last;
    }

    await this.kv.set(PENDING_SHARE_KEY, tabId);
    return null;
  }

  /** 弹窗取消页面访问：共享页或助手打开的页都只撤销归属，网页保留。 */
  async unshare(tabId: number): Promise<void> {
    const all = await this.all();
    let owned = false;
    for (const [id, c] of Object.entries(all)) {
      owned ||= c.tabs.includes(tabId);
      this.removeTab(id, c, tabId);
    }

    if ((await this.kv.get<number>(PENDING_SHARE_KEY)) === tabId) {
      await this.kv.remove(PENDING_SHARE_KEY);
    }

    await this.save();
    if (owned) await this.ungroup(tabId);
  }

  async shareTarget(): Promise<ShareTarget> {
    const last = await this.kv.get<string>(LAST_KEY);
    if (last && (await this.all())[last]) {
      return { kind: 'recent', title: (await this.kv.get<string>(LAST_TITLE_KEY)) ?? '' };
    }

    return { kind: 'next' };
  }

  /** 一个对话发来请求：记为最近使用，接上待共享的标签。返回这次接上的共享标签（调用方给它的站点记授权）。 */
  async touch(conversation: string, title = ''): Promise<number | null> {
    await this.kv.set(LAST_TITLE_KEY, title);
    const all = await this.all();
    const c = all[conversation] ?? this.blank();
    c.lastUsed = Date.now();
    all[conversation] = c;

    let adopted: number | null = null;
    const pending = await this.kv.get<number>(PENDING_SHARE_KEY);
    if (pending !== undefined) {
      await this.kv.remove(PENDING_SHARE_KEY);
      if (await this.ops.exists(pending)) {
        c.shared.push(pending);
        c.active ??= pending;
        adopted = pending;
      }
    }

    await this.kv.set(LAST_KEY, conversation);
    await this.save();
    return adopted;
  }

  /**
   * 换了平台账号（补充约定 4）：忘掉全部对话——对话到标签组的对应、「将共享给」的对话与标题、待共享的标签。AI 开的
   * 标签不关，只解散标签组（不再是 AI 标签，留给用户）；共享进来的页面本来就是用户的。返回涉及的标签（调用方断开
   * 它们的附着）。
   */
  async forgetAll(): Promise<number[]> {
    this.cancelCreating();
    const conversations = Object.values(await this.all());
    // 先清登记再解散组：解散触发的 onUpdated(groupId) 不会被当成「拖出 AI 组」。
    this.cache = {};
    this.revocations.emit({ kind: 'all' });
    await this.save();
    await this.kv.remove(LAST_KEY);
    await this.kv.remove(LAST_TITLE_KEY);
    await this.kv.remove(PENDING_SHARE_KEY);

    for (const c of conversations) {
      for (const tabId of c.tabs) {
        await this.ungroup(tabId);
      }
    }

    return conversations.flatMap((c) => [...c.tabs, ...c.shared]);
  }

  /** 标签关掉了。 */
  async onTabRemoved(tabId: number): Promise<void> {
    for (const grouping of this.groupingTabs) {
      if (grouping.tabId === tabId) {
        grouping.tabId = null;
        this.groupingTabs.delete(grouping);
      }
    }
    for (const pending of this.creating) {
      if (pending.tabId === undefined) pending.lost.set(tabId, null);
      if (pending.tabId === tabId) pending.ctrl.abort();
    }
    const all = await this.all();
    let changed = false;
    for (const [id, c] of Object.entries(all)) {
      if (c.tabs.includes(tabId) || c.shared.includes(tabId)) {
        this.removeTab(id, c, tabId);
        changed = true;
      }
    }

    if (changed) {
      await this.save();
    }
  }

  /**
   * 标签换了 id（浏览器丢弃后台标签省内存、预渲染替换时会这样，chrome.tabs.onReplaced）：登记里把旧 id
   * 换成新 id，对话照常用这个标签。
   */
  async onTabReplaced(added: number, removed: number): Promise<void> {
    for (const grouping of this.groupingTabs) {
      if (grouping.tabId === removed) grouping.tabId = added;
    }
    for (const pending of this.creating) {
      if (pending.tabId === undefined) pending.lost.set(removed, added);
      if (pending.tabId === removed) {
        pending.ctrl.abort();
        void this.ops.close(added).catch(() => undefined);
      }
    }
    const all = await this.all();
    let changed = false;
    for (const c of Object.values(all)) {
      const swap = (ids: number[]) => ids.map((t) => (t === removed ? added : t));
      if (c.tabs.includes(removed) || c.shared.includes(removed)) {
        c.tabs = swap(c.tabs);
        c.shared = swap(c.shared);
        if (c.ungrouped) c.ungrouped = swap(c.ungrouped);
        changed = true;
      }

      if (c.active === removed) {
        c.active = added;
        changed = true;
      }
    }

    if (changed) {
      await this.save();
    }
  }

  /** 标签换了组：AI 开的标签被拖出本对话的 AI 标签组，AI 就不再碰它。返回失去它的对话。 */
  async onTabGroupChanged(tabId: number, groupId: number): Promise<string | null> {
    for (const pending of this.creating) {
      if (pending.tabId === undefined || pending.tabId === tabId) pending.groups.set(tabId, groupId);
      if (pending.tabId === tabId && pending.groupId !== undefined && pending.groupId !== groupId) pending.ctrl.abort();
    }
    const all = await this.all();
    for (const [id, c] of Object.entries(all)) {
      if (c.tabs.includes(tabId) && !c.ungrouped?.includes(tabId) && c.groupId !== null && groupId !== c.groupId) {
        this.removeTab(id, c, tabId);
        await this.save();
        return id;
      }
    }

    return null;
  }

  /** 空闲超过 idleMs 的对话（断开它们的附着用）。 */
  async idle(now: number, idleMs: number): Promise<Array<{ conversation: string; tabs: number[] }>> {
    return Object.entries(await this.all())
      .filter(([, c]) => now - c.lastUsed > idleMs)
      .map(([conversation, c]) => ({ conversation, tabs: [...c.tabs, ...c.shared] }));
  }

  async conversationCount(): Promise<number> {
    return Object.values(await this.all()).filter((c) => c.tabs.length + c.shared.length > 0).length;
  }

  /** 只有标签确实属于该对话时才撤销，避免别的对话按同一编号误撤当前读取。 */
  private removeTab(conversation: string, c: ConversationTabs, tabId: number): void {
    const member = c.tabs.includes(tabId) || c.shared.includes(tabId);
    c.tabs = c.tabs.filter((t) => t !== tabId);
    if (c.ungrouped) c.ungrouped = c.ungrouped.filter((t) => t !== tabId);
    c.shared = c.shared.filter((t) => t !== tabId);
    if (c.active === tabId) {
      c.active = c.tabs.at(-1) ?? c.shared.at(-1) ?? null;
    }
    if (member) this.revocations.emit({ kind: 'tab', tabId, conversation });
  }

  private blank(): ConversationTabs {
    return { groupId: null, windowId: null, tabs: [], shared: [], active: null, lastUsed: Date.now() };
  }

  private async all(): Promise<Record<string, ConversationTabs>> {
    if (!this.cache) {
      this.cache = (await this.kv.get<Record<string, ConversationTabs>>(KEY)) ?? {};
    }

    return this.cache;
  }

  private async save(): Promise<void> {
    if (this.cache) {
      const snapshot = structuredClone(this.cache);
      const write = this.saving.catch(() => undefined).then(() => this.kv.set(KEY, snapshot));
      this.saving = write;
      await write;
    }
  }
}
