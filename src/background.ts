// 插件后台：每个服务器使用独立运行期；浏览器事件始终交给当前运行期。
import { TabRegistry } from './browser/tabs';
import { IDLE_DETACH_MS, PLATFORM_ORIGIN } from './config';
import { FakeServer, FakeTransport } from './connection/fake-transport';
import { FetchTransport } from './connection/fetch-transport';
import { ServerSettings, serverHostPermission } from './connection/server-settings';
import { Identity } from './identity';
import type { PageMessage, PopupState } from './messages';
import { SiteStore } from './policy/sites';
import { siteOf } from './policy/url';
import { ControlBar } from './controlbar/controller';
import { BrowserRuntime } from './runtime';
import { localKV, sessionKV } from './storage';

const local = localKV();
const session = sessionKV();
const INTRO_KEY = 'settings.introSeen';
const STOPPED_KEY = 'state.stopped';
const identity = new Identity(local);
let stopped = false;
const stoppedReady = session.get<boolean>(STOPPED_KEY).then((v) => { stopped = stopped || v === true; });

declare const __TEST_HOOKS__: boolean;
declare const __FAKE_TRANSPORT__: boolean;
const fakeServer = __FAKE_TRANSPORT__ ? new FakeServer() : null;
const detachLog: Array<{ tabId: number | null; reason: string; at: number }> = [];

let controlBar: ControlBar | null = null;
const settings = new ServerSettings({
  local, defaultOrigin: PLATFORM_ORIGIN,
  hasPermission: (origin) => chrome.permissions.contains({ origins: [serverHostPermission(origin)] }),
  create: (origin) => {
    let bar: ControlBar;
    const runtime = new BrowserRuntime({
      origin, local, session, identity,
      transport: (target, credential) => __FAKE_TRANSPORT__ ? new FakeTransport(fakeServer as FakeServer) : new FetchTransport(target, credential),
      stopped: () => stopped,
      onUserStop: () => { void stop(); },
      onControlChanged: (conversation) => { void bar.refresh(conversation).catch(() => undefined); },
      onAccountReset: () => bar.clear(),
      onDispose: () => bar.dispose(),
      detachLog: __TEST_HOOKS__ ? detachLog : undefined,
    });
    bar = new ControlBar(runtime);
    controlBar = bar;
    void bar.restore().catch(() => undefined);
    return runtime;
  },
  clear: async () => {
    // 旧运行期的写入已封闭且排空。使用未封闭存储清理，保留网页与物理安装身份。
    await new SiteStore(local, session).clear();
    await new TabRegistry(session).forgetAll();
    await local.remove('state.account');
    await session.remove('control.conversations');
  },
});

async function stop(): Promise<void> {
  stopped = true;
  await session.set(STOPPED_KEY, true);
  await settings.runtime?.stop();
}

async function resume(): Promise<void> {
  stopped = false;
  await session.set(STOPPED_KEY, false);
}

// ---- 浏览器事件 ----
chrome.tabs.onCreated.addListener((tab) => {
  const r = settings.runtime;
  if (!r || tab.id === undefined || tab.openerTabId === undefined || !r.acting.has(tab.openerTabId)) return;
  const newTab = tab.id;
  void r.tabs.ownedBy(tab.openerTabId).then((conversation) => {
    void chrome.tabs.remove(newTab).catch(() => undefined);
    if (conversation !== null) r.notices.add(conversation, 'The page opened a new browser tab during your action; it was closed. Links that open a new tab are followed in your current tab instead.');
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  void controlBar?.remove(tabId);
  void settings.ready.then(async () => {
    const r = settings.runtime!;
    await Promise.all([r.tabs.onTabRemoved(tabId), r.sessions.detach(tabId)]);
  });
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void settings.runtime?.sessions.peek(tabId)?.clearViewportOverride();
});
chrome.tabs.onReplaced?.addListener((added, removed) => {
  void controlBar?.remove(removed);
  void settings.ready.then(async () => {
    const r = settings.runtime!;
    await Promise.all([r.sessions.detach(removed), r.tabs.onTabReplaced(added, removed)]);
    if (settings.runtime === r) await controlBar?.ensure(added);
  });
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading' || changeInfo.url !== undefined) void controlBar?.remove(tabId);
  if (changeInfo.status === 'complete') void controlBar?.ensure(tabId);
  if (changeInfo.groupId === undefined) return;
  const r = settings.runtime;
  if (!r) return;
  void r.tabs.onTabGroupChanged(tabId, changeInfo.groupId).then((lost) => {
    if (lost !== null) {
      void r.sessions.detach(tabId);
      void controlBar?.remove(tabId);
    }
  });
});
chrome.windows.onRemoved.addListener((windowId) => settings.runtime?.prompts.windowClosed(windowId));
chrome.permissions.onRemoved.addListener(() => { void controlBar?.restore().catch(() => undefined); });

// 沿用现有空闲附着回收，不增加外部巡检或监控。
setInterval(() => {
  const r = settings.runtime;
  if (!r || r.scheduler.pending > 0) return;
  void r.tabs.idle(Date.now(), IDLE_DETACH_MS).then(async (idle) => {
    for (const c of idle) for (const tabId of c.tabs) await r.sessions.detach(tabId);
  });
}, 60_000);

function fromOwnPage(sender: chrome.runtime.MessageSender, page: 'popup.html' | 'approval.html'): boolean {
  if (sender.id !== chrome.runtime.id || typeof sender.url !== 'string') return false;
  const url = new URL(sender.url);
  const expected = new URL(chrome.runtime.getURL(page));
  return url.protocol === expected.protocol && url.host === expected.host && url.pathname === expected.pathname;
}

async function activeTab(): Promise<chrome.tabs.Tab | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

async function popupState(): Promise<PopupState> {
  await Promise.all([settings.ready, stoppedReady]);
  const r = settings.runtime!;
  const tab = await activeTab();
  const site = siteOf(tab?.url ?? '');
  const usedBy = tab?.id !== undefined ? await r.tabs.conversationOf(tab.id) : null;
  const shared = tab?.id !== undefined ? await r.tabs.isShared(tab.id) : false;
  const grants = await r.sites.list();
  const status = r.manager.status;
  const target = await r.tabs.shareTarget();
  const siteGroups: PopupState['siteGroups'] = [...new Set([...grants.always, ...Object.values(grants.conversation).flat()])].map((site) => ({
    site,
    grants: [
      ...(grants.always.includes(site) ? [{ scope: 'always' as const, title: '' }] : []),
      ...Object.entries(grants.conversation).filter(([, sites]) => sites.includes(site)).map(([conversation]) => ({
        scope: conversation === usedBy ? 'current' as const : 'conversation' as const,
        title: r.controls.view(conversation).title,
      })),
    ],
  }));
  return {
    connection: status.state,
    signingIn: r.authentication.signingIn,
    supportedActions: [...r.backend.actions],
    displayName: await identity.displayName(),
    stopped, introSeen: (await local.get<boolean>(INTRO_KEY)) === true,
    sites: { always: grants.always, conversation: [...new Set(Object.values(grants.conversation).flat())].filter((s) => !grants.always.includes(s)) },
    siteGroups, pageSite: site,
    pageOwner: usedBy ? { title: r.controls.view(usedBy).title, assistantOpened: !shared } : null,
    canShare: site !== null && usedBy === null && target.kind === 'recent' && !settings.switching,
    shared, shareTarget: target, activeConversations: await r.tabs.conversationCount(),
    serverOrigin: r.options.origin, serverEpoch: r.epoch,
    serverSwitching: settings.switching, serverPermissionGranted: settings.permissionGranted,
    controlTabId: usedBy !== null && site !== null ? tab!.id! : null,
    controlOrigin: usedBy !== null ? site : null,
    controlledConversations: r.controls.list(),
    ...(status.account !== undefined ? { account: status.account } : {}),
    ...(status.lastError !== undefined ? { lastError: status.lastError } : {}),
  };
}

async function handlePopup(msg: PageMessage): Promise<unknown> {
  await settings.ready;
  const r = settings.runtime!;
  if (settings.switching && msg.type !== 'popup:state') return { ok: false, error: 'switching' };
  if (msg.type === 'popup:state' || msg.type === 'popup:login' || msg.type === 'popup:restartLogin' || msg.type === 'popup:reconnect') {
    await settings.refreshPermission();
  }
  switch (msg.type) {
    case 'popup:state': return popupState();
    case 'popup:login':
      if (!settings.permissionGranted) return { ok: false };
      return r.authentication.login();
    case 'popup:restartLogin':
      if (!settings.permissionGranted) return { ok: false };
      return r.authentication.restart();
    case 'popup:logout': return r.logout();
    case 'popup:setServer': return settings.select(msg.origin, msg.epoch);
    case 'popup:resumeConversation': {
      if (stopped || msg.epoch !== r.epoch || typeof msg.conversation !== 'string') return { ok: false };
      await r.controls.resume(msg.conversation);
      return { ok: settings.runtime === r && !settings.switching };
    }
    case 'popup:showControls': {
      const bar = controlBar;
      if (msg.epoch !== r.epoch || !Number.isInteger(msg.tabId) || !bar) return { ok: false };
      const tab = await chrome.tabs.get(msg.tabId);
      if (!tab.url || siteOf(tab.url) === null || await r.tabs.conversationOf(msg.tabId) === null) return { ok: false };
      if (!await chrome.permissions.contains({ origins: [serverHostPermission(tab.url)] }) || settings.runtime !== r) return { ok: false };
      await bar.ensure(msg.tabId, true);
      return { ok: bar.has(msg.tabId) };
    }
    case 'popup:setDisplayName': {
      const ok = await identity.setDisplayName(String(msg.name ?? ''));
      if (ok && settings.permissionGranted) r.manager.reconnectNow();
      return { ok };
    }
    case 'popup:stop': await stop(); return { ok: true };
    case 'popup:resume': await resume(); return { ok: true };
    case 'popup:share': {
      const tab = await activeTab();
      const site = siteOf(tab?.url ?? '');
      if (tab?.id === undefined || site === null || stopped || (await r.tabs.shareTarget()).kind === 'next') return { ok: false };
      const conversation = await r.tabs.share(tab.id);
      if (conversation !== null) {
        await r.sites.grant(conversation, site, 'conversation');
        if (settings.runtime === r) await controlBar?.ensure(tab.id);
      }
      return { ok: true, pending: conversation === null };
    }
    case 'popup:unshare': {
      const tab = await activeTab();
      if (tab?.id !== undefined) {
        await r.tabs.unshare(tab.id);
        await r.sessions.detach(tab.id);
        await controlBar?.remove(tab.id);
      }
      return { ok: true };
    }
    case 'popup:revokeSite': await r.sites.revoke(String(msg.site ?? '')); return { ok: true };
    case 'popup:reconnect':
      if (!settings.permissionGranted) return { ok: false, error: 'permission_denied' };
      r.manager.reconnectNow();
      return { ok: true };
    case 'popup:dismissIntro': await local.set(INTRO_KEY, true); return { ok: true };
    default: return null;
  }
}

chrome.runtime.onMessage.addListener((raw: unknown, sender, sendResponse) => {
  const msg = raw as PageMessage;
  if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string') return false;
  if (msg.type.startsWith('panel:')) {
    if (!controlBar) { sendResponse({ ok: false }); return false; }
    controlBar.handle(raw, sender).then(sendResponse, () => sendResponse({ ok: false }));
    return true;
  }
  if (msg.type === 'prompt:get' || msg.type === 'prompt:answer') {
    if (!fromOwnPage(sender, 'approval.html')) return false;
    const windowId = sender.tab?.windowId;
    const r = settings.runtime;
    if (msg.type === 'prompt:get') sendResponse(r?.prompts.view(String(msg.id), windowId) ?? null);
    else sendResponse({ ok: r?.prompts.answer(String(msg.id), windowId, msg.answer) ?? false });
    return false;
  }
  if (!msg.type.startsWith('popup:') || !fromOwnPage(sender, 'popup.html')) return false;
  handlePopup(msg).then(sendResponse, () => sendResponse(null));
  return true;
});

// ---- 测试入口，生产构建删除整个分支 ----
if (__TEST_HOOKS__) {
  (globalThis as Record<string, unknown>).__bxTest = {
    server: fakeServer,
    status: () => settings.runtime?.manager.status ?? { state: 'offline' },
    reconnect: () => settings.runtime?.manager.reconnectNow(),
    popupState, stop, resume,
    get sites() { return settings.runtime?.sites; },
    get tabs() { return settings.runtime?.tabs; },
    detachLog,
    attachedCount: () => settings.runtime?.sessions.attachedCount ?? 0,
    identity,
    cdp: (tabId: number, method: string, params: Record<string, unknown> = {}) => settings.runtime?.sessions.peek(tabId)?.cdp.send(method, params),
  };
}
