// 插件后台（service worker）：把连接、调度、审批、标签、附着装配起来，处理插件自己页面的消息。

import { runRequest } from './actions';
import { STOPPED_MESSAGE } from './actions/context';
import type { Services } from './actions/context';
import { Gate } from './approval/gate';
import { PromptManager } from './approval/prompts';
import { ApprovalRegistry } from './approval/registry';
import { DownloadWatcher } from './browser/downloads';
import { SessionManager } from './browser/sessions';
import { TabRegistry } from './browser/tabs';
import { IDLE_DETACH_MS, PLATFORM_ORIGIN } from './config';
import { ConnectionManager } from './connection/manager';
import type { ConnectionStatus } from './connection/manager';
import { AccountWatch } from './connection/account';
import { watchSessionCookie } from './connection/cookie-watch';
import { FakeServer, FakeTransport } from './connection/fake-transport';
import { FetchTransport } from './connection/fetch-transport';
import type { Transport } from './connection/transport';
import { Identity } from './identity';
import type { Notices } from './actions/context';
import type { PageMessage, PopupState } from './messages';
import { SiteStore } from './policy/sites';
import { siteOf } from './policy/url';
import type { ResultFrame } from './protocol/frames';
import { Scheduler } from './scheduler';
import { localKV, sessionKV } from './storage';

const local = localKV();
const session = sessionKV();

const AUTO_MODE_KEY = 'settings.autoMode';
const INTRO_KEY = 'settings.introSeen';
const STOPPED_KEY = 'state.stopped';

/** 断线期间攒下的结果最多留多久（Chat 侧早已超时的就不补发了）。 */
const OUTBOX_TTL_MS = 2 * 60_000;

const identity = new Identity(local);
const sites = new SiteStore(local, session);
const tabRegistry = new TabRegistry(session, undefined, (c) => chrome.i18n.getMessage('tabGroupTitle', [c.slice(0, 4)]) || `AI · ${c.slice(0, 4)}`);
const prompts = new PromptManager();
const registry = new ApprovalRegistry();

/** 动作之外发生、要在对话的下一个结果里告诉模型的事。浏览器关掉就没了（不进存储：只是给模型的提醒）。 */
const pendingNotices = new Map<string, string[]>();
const notices: Notices = {
  add(conversation, text) {
    const list = pendingNotices.get(conversation) ?? [];
    if (list.length < 10) {
      list.push(text);
    }

    pendingNotices.set(conversation, list);
  },
  take(conversation) {
    const list = pendingNotices.get(conversation) ?? [];
    pendingNotices.delete(conversation);
    return list;
  },
};

/** 正在执行动作的 AI 标签。 */
const acting = new Set<number>();

const downloads = new DownloadWatcher({
  ownedBy: (tabId) => tabRegistry.ownedBy(tabId),
  aiTabFor: async (referrer) => {
    const tabs = await chrome.tabs.query({});
    const same = tabs.filter((t) => t.url === referrer && t.id !== undefined);
    if (same.length === 0) {
      return null;
    }

    for (const t of same) {
      if ((await tabRegistry.ownedBy(t.id as number)) === null) {
        return null;
      }
    }

    return same[0]?.id ?? null;
  },
  stray: (conversation, d) => {
    const site = siteOf(d.referrer) ?? siteOf(d.url) ?? 'the page';
    notices.add(conversation, `Outside your browser actions, ${site} started downloading "${d.filename}" in your tab; it was cancelled and not saved. If you need the file, start the download again with a browser action.`);
  },
});

let stopped = false;
let lastStatus: ConnectionStatus = { state: 'offline' };
const outbox: Array<{ frame: ResultFrame; at: number; generation: number }> = [];

void session.get<boolean>(STOPPED_KEY).then((v) => {
  stopped = stopped || v === true;
});

declare const __TEST_HOOKS__: boolean;
declare const __FAKE_TRANSPORT__: boolean;

/**
 * 连接用真实传输（fetch 双向通道，契约第 2 节）。端到端测试的假传输构建（--fake-transport）换成内存假传输，
 * 测试代码扮演 Chat。直接用构建期常量判断：其他构建里这个分支连同 FakeServer / FakeTransport 一起被删掉
 * （scripts/build.mjs 构建后会检查）。
 */
const fakeServer = __FAKE_TRANSPORT__ ? new FakeServer() : null;
const transportFactory = (): Transport => (__FAKE_TRANSPORT__
  ? new FakeTransport(fakeServer as FakeServer)
  : new FetchTransport(PLATFORM_ORIGIN));

/** 换了平台账号时中止的请求的说明。 */
const ACCOUNT_SWITCHED_MESSAGE = 'The browser switched to a different platform account, so this browser action was stopped.';

/**
 * 换过几次平台账号。每个请求记下收到时是第几次：换了账号之后，上一个账号的请求的结果（可能带着上一个用户的页面）
 * 不发给新账号的连接。
 */
let accountGeneration = 0;
const requestGeneration = new Map<string, number>();

const accounts = new AccountWatch(local, () => forgetPreviousAccount());

const manager = new ConnectionManager({
  transportFactory,
  hello: () => identity.hello(),
  // 换了平台账号：先清上一个账号的对话状态，新连接才可用（补充约定 4）。
  beforeReady: async (account) => {
    await accounts.connected(account);
  },
  onFrame: (frame) => {
    switch (frame.type) {
      case 'request':
        requestGeneration.set(frame.request_id, accountGeneration);
        scheduler.submit(frame);
        break;
      // 取消与审批按 request_id（审批再加 approval_id）认，不管从哪一条连接来：轮换、重连之后，旧连接上开始的
      // 请求的取消与审批从新连接发来（补充约定 1）。
      case 'cancel':
        scheduler.cancel(frame.request_id);
        break;
      case 'approval':
        registry.receive(frame);
        break;
      case 'release': {
        const generation = accountGeneration;
        void scheduler.finishTurn(frame.conversation, frame.turn_id,
          () => sessions.release(frame.conversation, frame.turn_id)).then(() => {
          if (generation === accountGeneration) {
            // 服务端保留未确认的释放，断线后会补投；不把上一账号的确认发给新账号。
            return manager.send({ type: 'released', turn_id: frame.turn_id, conversation: frame.conversation });
          }
        }).catch(() => undefined);
        break;
      }
      default:
    }
  },
  onStatus: (status) => {
    lastStatus = status;
    if (status.state === 'connected') {
      flushOutbox();
    }
  },
  keepAlive: () => {
    void chrome.runtime.getPlatformInfo();
  },
});

// 平台会话 Cookie 变了（同一台浏览器上退出登录、重新登录、换人登录）：断开重连，让网关按此刻的会话重新校验（计划第 9 节
// 第 17 条）。只看事件是不是平台站点的 HttpOnly Cookie，不读值（cookie-watch.ts）。在顶层注册，休眠的后台会被它唤醒。
watchSessionCookie({
  platformHost: new URL(PLATFORM_ORIGIN).hostname,
  addListener: (listener) => chrome.cookies.onChanged.addListener(listener),
  onSessionCookieChanged: () => manager.sessionChanged(),
});

const gate = new Gate({
  registry,
  prompts,
  autoMode: async () => (await local.get<boolean>(AUTO_MODE_KEY)) ?? true,
  connected: () => manager.connected,
  send: (frame) => manager.send(frame),
});

/** 测试构建里记下调试附着的断开（实测「提示条上点取消」给出的原因）。 */
const detachLog: Array<{ tabId: number | null; reason: string; at: number }> = [];

const sessions = new SessionManager(() => {
  if (__TEST_HOOKS__) {
    detachLog.push({ tabId: null, reason: 'canceled_by_user', at: Date.now() });
  }

  void stop();
}, (tabId) => {
  // 只清附着会话（SessionManager 已经做了），不动标签登记：标签被浏览器丢弃时附着也会以 target_closed
  // 断开，但标签还在、只是换了 id（onReplaced）。真关掉的标签由 tabs.onRemoved 从登记里删。
  if (__TEST_HOOKS__) {
    detachLog.push({ tabId, reason: 'target_closed', at: Date.now() });
  }
});

const services: Services = {
  tabs: tabRegistry,
  sessions,
  sites,
  gate,
  prompts,
  downloads,
  transport: () => manager.transport,
  maxFileBytes: () => manager.maxFileBytes,
  stopped: () => stopped,
  acting,
  notices,
};

const scheduler = new Scheduler((request, signal) => runRequest(services, request, signal), emitResult);

function emitResult(frame: ResultFrame): void {
  const generation = requestGeneration.get(frame.request_id) ?? accountGeneration;
  requestGeneration.delete(frame.request_id);
  sendResult(frame, generation);
}

function sendResult(frame: ResultFrame, generation: number): void {
  if (generation !== accountGeneration) {
    // 上一个账号的请求：结果不发给新账号的连接（Chat 那边按超时收尾）。
    return;
  }

  manager.send(frame).catch(() => {
    outbox.push({ frame, at: Date.now(), generation });
  });
}

function flushOutbox(): void {
  const now = Date.now();
  const pending = outbox.splice(0).filter((o) => now - o.at < OUTBOX_TTL_MS);
  for (const o of pending) {
    sendResult(o.frame, o.generation);
  }
}

/**
 * 换了平台账号（补充约定 4）：清掉上一个账号的对话状态——排队和在跑的请求、待补发的结果、给模型的提醒、站点授权、
 * 对话到标签组的对应与「将共享给」——并断开调试附着。AI 标签本身不关（只解散标签组）。
 */
async function forgetPreviousAccount(): Promise<void> {
  accountGeneration++;
  outbox.splice(0);
  scheduler.abortAll({ code: 'timeout', message: ACCOUNT_SWITCHED_MESSAGE });
  pendingNotices.clear();
  await sites.clear();
  await tabRegistry.forgetAll();
  await sessions.detachAll();
}

/** 叫停：提示条上的「取消」、弹窗里的「停止」。断开全部附着，正在跑和排队的请求回 user_stopped。 */
async function stop(): Promise<void> {
  stopped = true;
  await session.set(STOPPED_KEY, true);
  scheduler.stopAll(STOPPED_MESSAGE);
  await sessions.detachAll();
}

async function resume(): Promise<void> {
  stopped = false;
  await session.set(STOPPED_KEY, false);
}

// ---- 浏览器事件 ----

// 兜底：AI 动作期间还是从 AI 标签冒出了新标签（页面脚本绕过了新开标签的守卫），立即关掉，并告诉模型。
// 关得再快也挡不住它已经发出的请求，主防线是 newtab-guard.ts 把导航留在本标签。
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.id === undefined || tab.openerTabId === undefined || !acting.has(tab.openerTabId)) {
    return;
  }

  const newTab = tab.id;
  void tabRegistry.ownedBy(tab.openerTabId).then((conversation) => {
    void chrome.tabs.remove(newTab).catch(() => undefined);
    if (conversation !== null) {
      notices.add(conversation, 'The page opened a new browser tab during your action; it was closed. Links that open a new tab are followed in your current tab instead.');
    }
  });
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void tabRegistry.onTabRemoved(tabId);
  void sessions.detach(tabId);
});

// 标签切到前台就有了真实尺寸：撤掉给 0×0 后台标签临时定的视口。
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void sessions.peek(tabId)?.clearViewportOverride();
});

chrome.tabs.onReplaced.addListener((added, removed) => {
  void sessions.detach(removed);
  void tabRegistry.onTabReplaced(added, removed);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.groupId === undefined) {
    return;
  }

  void tabRegistry.onTabGroupChanged(tabId, changeInfo.groupId).then((lost) => {
    if (lost !== null) {
      void sessions.detach(tabId);
    }
  });
});

chrome.windows.onRemoved.addListener((windowId) => prompts.windowClosed(windowId));

// 空闲的对话断开附着：顶部提示条随之消失；标签与标签组留着。
setInterval(() => {
  if (scheduler.pending > 0) {
    return;
  }

  void tabRegistry.idle(Date.now(), IDLE_DETACH_MS).then(async (idle) => {
    for (const c of idle) {
      for (const tabId of c.tabs) {
        await sessions.detach(tabId);
      }
    }
  });
}, 60_000);

// ---- 插件自己页面的消息 ----

function fromOwnPage(sender: chrome.runtime.MessageSender, page: 'popup.html' | 'approval.html'): boolean {
  return sender.id === chrome.runtime.id && typeof sender.url === 'string' && sender.url.startsWith(chrome.runtime.getURL(page));
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function popupState(): Promise<PopupState> {
  const tab = await activeTab();
  const url = tab?.url ?? '';
  const site = siteOf(url);
  const usedBy = tab?.id !== undefined ? await tabRegistry.conversationOf(tab.id) : null;
  const shared = tab?.id !== undefined ? await tabRegistry.isShared(tab.id) : false;
  const grants = await sites.list();
  const conversationSites = [...new Set(Object.values(grants.conversation).flat())].filter((s) => !grants.always.includes(s));

  const state: PopupState = {
    connection: lastStatus.state,
    displayName: await identity.displayName(),
    autoMode: (await local.get<boolean>(AUTO_MODE_KEY)) ?? true,
    stopped,
    introSeen: (await local.get<boolean>(INTRO_KEY)) === true,
    sites: { always: grants.always, conversation: conversationSites },
    canShare: site !== null && usedBy === null,
    shared,
    shareTarget: await tabRegistry.shareTarget(),
    activeConversations: await tabRegistry.conversationCount(),
  };

  if (lastStatus.account !== undefined) {
    state.account = lastStatus.account;
  }

  if (lastStatus.lastError !== undefined) {
    state.lastError = lastStatus.lastError;
  }

  return state;
}

async function handlePopup(msg: PageMessage): Promise<unknown> {
  switch (msg.type) {
    case 'popup:state':
      return popupState();
    case 'popup:setDisplayName': {
      const ok = await identity.setDisplayName(String(msg.name ?? ''));
      if (ok) {
        manager.reconnectNow();
      }

      return { ok };
    }
    case 'popup:setAutoMode':
      await local.set(AUTO_MODE_KEY, msg.on === true);
      return { ok: true };
    case 'popup:stop':
      await stop();
      return { ok: true };
    case 'popup:resume':
      await resume();
      return { ok: true };
    case 'popup:share': {
      const tab = await activeTab();
      const site = siteOf(tab?.url ?? '');
      if (tab?.id === undefined || site === null) {
        return { ok: false };
      }

      const conversation = await tabRegistry.share(tab.id);
      if (conversation !== null) {
        await sites.grant(conversation, site, 'conversation');
      }

      return { ok: true, pending: conversation === null };
    }
    case 'popup:unshare': {
      const tab = await activeTab();
      if (tab?.id !== undefined) {
        await tabRegistry.unshare(tab.id);
        await sessions.detach(tab.id);
      }

      return { ok: true };
    }
    case 'popup:revokeSite':
      await sites.revoke(String(msg.site ?? ''));
      return { ok: true };
    case 'popup:reconnect':
      manager.reconnectNow();
      return { ok: true };
    case 'popup:dismissIntro':
      await local.set(INTRO_KEY, true);
      return { ok: true };
    default:
      return null;
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as PageMessage;
  if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') {
    return false;
  }

  if (msg.type === 'prompt:get' || msg.type === 'prompt:answer') {
    if (!fromOwnPage(sender, 'approval.html')) {
      return false;
    }

    const windowId = sender.tab?.windowId;
    if (msg.type === 'prompt:get') {
      sendResponse(prompts.view(String(msg.id), windowId));
    } else {
      sendResponse({ ok: prompts.answer(String(msg.id), windowId, msg.answer) });
    }

    return false;
  }

  if (!msg.type.startsWith('popup:') || !fromOwnPage(sender, 'popup.html')) {
    return false;
  }

  handlePopup(msg).then(sendResponse, () => sendResponse(null));
  return true;
});

// ---- 启动 ----

manager.start();

if (__TEST_HOOKS__) {
  (globalThis as Record<string, unknown>).__bxTest = {
    /** 假传输构建里扮演 Chat 的内存服务端；真实传输的测试构建里为 null（Chat 由仿 Chat 服务扮演）。 */
    server: fakeServer,
    status: () => manager.status,
    reconnect: () => manager.reconnectNow(),
    popupState,
    stop,
    resume,
    sites,
    tabs: tabRegistry,
    setAutoMode: (on: boolean) => local.set(AUTO_MODE_KEY, on),
    detachLog,
    attachedCount: () => sessions.attachedCount,
    /** 对已附着的标签发调试命令（实测用：模拟页面被冻结等）。 */
    cdp: (tabId: number, method: string, params: Record<string, unknown> = {}) => sessions.peek(tabId)?.cdp.send(method, params),
  };
}
