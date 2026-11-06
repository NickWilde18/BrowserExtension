// 对话 ↔ AI 标签的登记（计划 4.5「AI 能碰的标签页」）。
//
// AI 只碰两类标签：它自己开的、放在本对话 AI 标签组里的；用户在弹窗里点了「共享此页」的。
// 用户把标签拖出 AI 标签组，AI 就碰不到了；用户拖进组里的标签不算（没有点共享）。
// 登记存在 storage.session（后台被回收后再起来还在），浏览器关掉就没了。

import type { KV } from '../storage';

const KEY = 'tabs.conversations';
const LAST_KEY = 'tabs.lastConversation';
const PENDING_SHARE_KEY = 'tabs.pendingShare';
const LAST_TITLE_KEY = 'tabs.lastConversationTitle';

/** 「共享此页」会给谁（与 share() 同一口径）：最近用过浏览器的对话（带标题，可能为空），或下一个用浏览器的对话。 */
export type ShareTarget = { kind: 'next' } | { kind: 'recent'; title: string };

export interface ConversationTabs {
  groupId: number | null;
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
  private cache: Record<string, ConversationTabs> | null = null;

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

  /** 新开一个 AI 标签（about:blank），放进本对话的 AI 标签组，设为当前。 */
  async createTab(conversation: string): Promise<number> {
    const all = await this.all();
    const c = all[conversation] ?? this.blank();
    const { tabId, windowId } = await this.ops.create(c.windowId);
    const groupId = await this.ops.group(tabId, c.groupId, windowId);
    if (groupId !== c.groupId) {
      await this.ops.titleGroup(groupId, this.groupTitle(conversation));
    }

    c.groupId = groupId;
    c.windowId = windowId;
    c.tabs.push(tabId);
    c.active = tabId;
    c.lastUsed = Date.now();
    all[conversation] = c;
    await this.save();
    return tabId;
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

    this.removeTab(c, tabId);
    await this.save();
    return closed;
  }

  /**
   * 结束本对话的浏览器操作（browser_close）：AI 开的标签关掉（keepTabs 时只解散标签组、留给用户看），
   * 共享页只撤销共享。返回关掉的标签数；调用方负责断开附着。
   */
  async release(conversation: string, keepTabs: boolean): Promise<{ tabs: number[]; closed: number }> {
    const all = await this.all();
    const c = all[conversation];
    if (!c) {
      return { tabs: [], closed: 0 };
    }

    const tabs = [...c.tabs, ...c.shared];
    // 先删登记再动标签：解散标签组会触发 onUpdated(groupId)，那时登记里还有这个对话的话，
    // 会被当成「用户把标签拖出了 AI 组」处理。
    delete all[conversation];
    await this.save();

    let closed = 0;
    for (const tabId of c.tabs) {
      if (keepTabs) {
        await this.ops.ungroup(tabId);
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
      await this.save();
      return last;
    }

    await this.kv.set(PENDING_SHARE_KEY, tabId);
    return null;
  }

  async unshare(tabId: number): Promise<void> {
    const all = await this.all();
    for (const c of Object.values(all)) {
      c.shared = c.shared.filter((t) => t !== tabId);
      if (c.active === tabId) {
        c.active = c.tabs.at(-1) ?? null;
      }
    }

    if ((await this.kv.get<number>(PENDING_SHARE_KEY)) === tabId) {
      await this.kv.remove(PENDING_SHARE_KEY);
    }

    await this.save();
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
    const conversations = Object.values(await this.all());
    // 先清登记再解散组：解散触发的 onUpdated(groupId) 不会被当成「拖出 AI 组」。
    this.cache = {};
    await this.save();
    await this.kv.remove(LAST_KEY);
    await this.kv.remove(LAST_TITLE_KEY);
    await this.kv.remove(PENDING_SHARE_KEY);

    for (const c of conversations) {
      for (const tabId of c.tabs) {
        await this.ops.ungroup(tabId);
      }
    }

    return conversations.flatMap((c) => [...c.tabs, ...c.shared]);
  }

  /** 标签关掉了。 */
  async onTabRemoved(tabId: number): Promise<void> {
    const all = await this.all();
    let changed = false;
    for (const c of Object.values(all)) {
      if (c.tabs.includes(tabId) || c.shared.includes(tabId)) {
        this.removeTab(c, tabId);
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
    const all = await this.all();
    let changed = false;
    for (const c of Object.values(all)) {
      const swap = (ids: number[]) => ids.map((t) => (t === removed ? added : t));
      if (c.tabs.includes(removed) || c.shared.includes(removed)) {
        c.tabs = swap(c.tabs);
        c.shared = swap(c.shared);
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
    const all = await this.all();
    for (const [id, c] of Object.entries(all)) {
      if (c.tabs.includes(tabId) && c.groupId !== null && groupId !== c.groupId) {
        this.removeTab(c, tabId);
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

  private removeTab(c: ConversationTabs, tabId: number): void {
    c.tabs = c.tabs.filter((t) => t !== tabId);
    c.shared = c.shared.filter((t) => t !== tabId);
    if (c.active === tabId) {
      c.active = c.tabs.at(-1) ?? c.shared.at(-1) ?? null;
    }
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
      await this.kv.set(KEY, this.cache);
    }
  }
}
