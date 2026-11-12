// 插件弹窗（第二版，Tark#528 拍板 rev 531 的结构 A）：已连接时按「当前页 / 站点 / 对话 / 设置」分标签，
// 设置是一列入口，点进带面包屑返回的二级页；未连接时是一页登录 / 状态说明，底部一行小字链接进同样的二级页。
// 所有来自页面/对话的标题和站点均按纯文本显示。页头、标签和底部「停止 / 恢复操作网页」固定，中间独立滚动。
import type { PageMessage, PopupState } from '../messages';
import { PLATFORM_ORIGIN } from '../config';

const t = (key: string, subs?: string[]): string => chrome.i18n.getMessage(key, subs) || key;
const send = <T>(msg: PageMessage): Promise<T> => chrome.runtime.sendMessage(msg) as Promise<T>;
function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
const button = (id: string) => $(id) as HTMLButtonElement;
let latest: PopupState | null = null;
type Tab = 'page' | 'sites' | 'conv' | 'settings';
type Sub = 'browser' | 'privacy' | 'settings' | 'about';
let tab: Tab = 'page';
/** 当前打开的二级页；null 表示在标签页（已连接）或登录页（未连接）。 */
let sub: Sub | null = null;
let editingName = false;
let busy = false;
let serverStage: 'draft' | 'permission' | 'confirm' = 'draft';
let serverDraftDirty = false;
let candidate: URL | null = null;
let permissionEpoch = '';
let controlledSignature = '';
let siteSignature = '';

const SUBS: Sub[] = ['browser', 'privacy', 'settings', 'about'];
const TABS: Tab[] = ['page', 'sites', 'conv', 'settings'];

/** 按连接状态、当前标签和二级页决定显示哪一块；只改可见性，不发消息。 */
function layout(): void {
  const connected = latest?.connection === 'connected';
  $('tabs').hidden = !connected;
  $('footer').hidden = !connected;
  $('gateView').hidden = connected || sub !== null;
  for (const name of TABS) {
    const selected = connected && name === tab;
    const el = $(`tab-${name}`);
    el.setAttribute('aria-selected', String(selected));
    el.tabIndex = selected ? 0 : -1;
    $(`${name}Panel`).hidden = !selected || sub !== null;
  }
  // 已连接时二级页都挂在「设置」标签下，标签高亮留在「设置」；未连接时从登录页的小字链接进来。
  if (connected && sub !== null) {
    for (const name of TABS) $(`tab-${name}`).setAttribute('aria-selected', String(name === 'settings'));
  }
  for (const name of SUBS) $(`${name}View`).hidden = name !== sub;
  for (const el of document.querySelectorAll<HTMLElement>('.crumb-parent')) el.textContent = t(connected ? 'tabSettings' : 'back');
}
function selectTab(next: Tab): void {
  tab = next;
  sub = null;
  document.querySelector('main')!.scrollTop = 0;
  layout();
}
function openSub(next: Sub): void {
  sub = next;
  if (latest?.connection === 'connected') tab = 'settings';
  document.querySelector('main')!.scrollTop = 0;
  if (next === 'settings' && latest) $('currentOrigin').textContent = latest.serverOrigin;
  layout();
}
function closeSub(): void {
  sub = null;
  if (editingName) cancelName();
  document.querySelector('main')!.scrollTop = 0;
  layout();
}
function openPlatform(): void {
  if (latest) void chrome.tabs.create({ url: latest.serverOrigin });
}
function feedback(key: string, error = false): void {
  const el = $('serverError');
  el.textContent = t(key);
  el.hidden = false;
  el.dataset.error = String(error);
}
function resetServerStage(): void {
  serverStage = 'draft';
  candidate = null;
  $('switchConfirmation').hidden = true;
  $('cancelSwitch').hidden = true;
  $('serverError').hidden = true;
  button('saveServer').textContent = t('settingsNext');
}
function normalizeServerOrigin(value: string): URL | null {
  const raw = value.trim();
  if (!/^https?:\/\/[^/?#\\\s@]+\/?$/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    return ['http:', 'https:'].includes(url.protocol) && url.hostname !== '' && url.username === ''
      && url.pathname === '/' && url.search === '' && url.hash === '' ? url : null;
  } catch { return null; }
}
function updateServerSettings(): void {
  const input = $('serverOrigin') as HTMLInputElement;
  if (latest && !serverDraftDirty && !busy && document.activeElement !== input) input.value = latest.serverOrigin;
  $('currentOrigin').textContent = latest?.serverOrigin ?? '';
  input.disabled = busy || serverStage !== 'draft' || latest?.serverSwitching === true;
  button('saveServer').disabled = !latest || busy || latest.serverSwitching;
  button('restoreDefault').disabled = busy;
  $('serverPermissionHint').hidden = serverStage !== 'permission';
}
async function advanceServer(): Promise<void> {
  if (!latest || busy || latest.serverSwitching) return;
  const input = $('serverOrigin') as HTMLInputElement;
  if (serverStage === 'draft') {
    candidate = normalizeServerOrigin(input.value);
    input.setAttribute('aria-invalid', String(!candidate));
    if (!candidate) { feedback('serverInvalidOrigin', true); return; }
    permissionEpoch = latest.serverEpoch;
    serverStage = 'permission';
    button('saveServer').textContent = t('settingsContinue');
    $('cancelSwitch').hidden = false;
    $('serverError').hidden = true;
    updateServerSettings();
    return;
  }
  if (!candidate) return;
  if (serverStage === 'permission') {
    // 此处直接从真实点击申请，不在申请前异步取 state，以保留浏览器要求的用户手势。
    busy = true;
    updateServerSettings();
    try {
      const granted = await chrome.permissions.request({ origins: [`${candidate.protocol}//${candidate.hostname}/*`] });
      if (!granted) { feedback('serverPermissionDenied', true); return; }
      serverStage = 'confirm';
      $('switchConfirmation').hidden = false;
      button('saveServer').textContent = t('settingsConfirm');
    } catch { feedback('serverPermissionDenied', true); }
    finally { busy = false; updateServerSettings(); }
    return;
  }
  busy = true;
  feedback('serverSwitching');
  button('cancelSwitch').disabled = true;
  updateServerSettings();
  try {
    const result = await send<{ ok: boolean; error?: string }>({ type: 'popup:setServer', origin: candidate.origin, epoch: permissionEpoch });
    if (result?.ok) {
      serverDraftDirty = false;
      resetServerStage();
      feedback('serverSaved');
    } else if (result?.error === 'rolled_back') {
      resetServerStage();
      serverDraftDirty = false;
      feedback('serverRolledBack', true);
    } else feedback('serverSaveFailed', true);
  } catch { feedback('serverSaveFailed', true); }
  finally {
    busy = false;
    button('cancelSwitch').disabled = false;
    await render();
    updateServerSettings();
  }
}

function renderControlled(st: PopupState): void {
  const signature = JSON.stringify([st.serverEpoch, st.controlledConversations, st.serverSwitching, st.stopped]);
  if (signature === controlledSignature) return;
  controlledSignature = signature;
  const count = st.controlledConversations.length;
  $('controlledCount').hidden = count === 0;
  $('controlledCount').textContent = String(count);
  $('controlledNone').hidden = count !== 0;
  $('controlledConversations').hidden = count === 0;
  $('controlledConversations').replaceChildren(...st.controlledConversations.map((entry) => {
    const item = document.createElement('li');
    item.className = 'row';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = entry.title || t('controlUntitled');
    title.title = title.textContent;
    item.append(title);
    if (entry.mode === 'user') {
      const resume = document.createElement('button');
      resume.textContent = t('controlResume');
      resume.disabled = st.stopped || st.serverSwitching;
      resume.addEventListener('click', async () => {
        resume.disabled = true;
        try {
          const result = await send<{ ok: boolean }>({ type: 'popup:resumeConversation', conversation: entry.conversation, epoch: st.serverEpoch });
          if (!result?.ok) throw new Error('unavailable');
          await render();
        } catch {
          resume.disabled = st.stopped;
          const note = document.createElement('span');
          note.textContent = t('controlUnavailable');
          item.append(note);
        }
      });
      item.append(resume);
    } else {
      const mode = document.createElement('span');
      mode.textContent = t(entry.mode === 'observing' ? 'controlObserve' : 'controlTaking');
      item.append(mode);
    }
    return item;
  }));
}
function filterSites(): void {
  const value = ($('siteFilter') as HTMLInputElement).value.toLowerCase();
  for (const li of $('sites').querySelectorAll<HTMLElement>('[data-site]')) li.hidden = !li.dataset.site!.toLowerCase().includes(value);
}
function renderSites(st: PopupState): void {
  const groups = st.siteGroups;
  const signature = JSON.stringify([st.serverEpoch, groups]);
  if (signature === siteSignature) return;
  siteSignature = signature;
  $('siteCount').textContent = String(groups.length);
  $('sitesNone').hidden = groups.length !== 0;
  $('siteSearch').hidden = groups.length <= 5;
  $('sites').hidden = groups.length === 0;
  $('sites').setAttribute('aria-label', t('sites'));
  $('sites').replaceChildren(...groups.map((group) => {
    const li = document.createElement('li');
    li.className = 'site-group';
    li.dataset.site = group.site;
    const heading = document.createElement('div');
    heading.className = 'site-heading';
    const name = document.createElement('span');
    name.className = 'site';
    // 只展示站点主机，长域名自然换行。
    try { name.textContent = new URL(group.site).host; } catch { name.textContent = group.site; }
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'icon';
    remove.title = t('revoke');
    remove.innerHTML = '<svg class="i"><use href="#i-trash"/></svg>';
    remove.setAttribute('aria-label', `${t('revoke')} ${name.textContent}`);
    remove.addEventListener('click', async () => {
      remove.disabled = true;
      try { await send({ type: 'popup:revokeSite', site: group.site }); await render(); }
      finally { remove.disabled = false; }
    });
    heading.append(name, remove);
    li.append(heading);
    for (const grant of group.grants) {
      const row = document.createElement('div');
      row.className = 'grant-row';
      const badge = document.createElement('span');
      badge.className = grant.scope === 'always' ? 'scope persistent' : 'scope';
      badge.textContent = t(grant.scope === 'always' ? 'sitesAlways' : grant.scope === 'current' ? 'sitesCurrent' : 'sitesOther');
      const owner = document.createElement('div');
      owner.className = 'grant-owner';
      owner.textContent = grant.scope === 'always' ? t('sitesAllConversations') : grant.title || t('controlUntitled');
      row.append(badge, owner);
      li.append(row);
    }
    return li;
  }));
  filterSites();
}

async function render(): Promise<void> {
  const st = await send<PopupState | null>({ type: 'popup:state' });
  if (!st) return;
  latest = st;
  const available = st.connection === 'connected';
  const readOnly = st.supportedActions.length === 1 && st.supportedActions[0] === 'read';
  const stateKey = st.connection === 'error' && st.lastError === 'forbidden'
    ? 'stateForbidden' : `state${st.connection.charAt(0).toUpperCase()}${st.connection.slice(1)}`;
  // 页头胶囊只放短状态；完整说明在登录页正文（#state）。
  const pill = available ? (st.stopped ? ['pillStopped', 'danger'] : ['pillConnected', 'ok'])
    : st.signingIn ? ['pillWaiting', 'warn']
      : st.connection === 'waiting_login' ? ['pillSignedOut', 'none']
        : st.connection === 'connecting' ? ['pillConnecting', 'warn'] : ['pillOffline', 'danger'];
  $('statusPill').textContent = t(pill[0]!);
  $('statusPill').className = `pill ${pill[1]}`;
  const login = st.connection === 'waiting_login';
  $('gateTitle').textContent = t(st.signingIn ? 'signingInTitle' : login ? 'loginTitle' : st.connection === 'connecting' ? 'stateConnecting' : 'pillOffline');
  $('state').textContent = st.connection === 'connecting' ? '' : t(st.signingIn ? 'signingIn' : stateKey);
  const busyGate = st.signingIn || st.connection === 'connecting';
  $('gateSpinner').hidden = !busyGate;
  $('gateCrest').hidden = busyGate;
  $('accountRow').hidden = !available || !st.account;
  $('account').textContent = available ? st.account ?? '' : '';
  $('openPlatform').hidden = !available || st.shareTarget.kind !== 'next';
  $('reconnect').hidden = !['replaced', 'error', 'offline'].includes(st.connection);
  $('login').hidden = !login;
  // 登录中仍可点：授权页被导航走或关不掉时，用户能中止这次并重新开始，不必等超时。
  button('login').disabled = st.serverSwitching || !st.serverPermissionGranted;
  button('login').textContent = t(st.signingIn ? 'restartLogin' : 'login');
  button('login').className = st.signingIn ? 'wide' : 'primary wide';
  $('logout').hidden = login;
  button('logout').disabled = st.serverSwitching;
  $('executionHint').hidden = !readOnly && st.supportedActions.length > 0;
  $('executionHint').textContent = t(readOnly ? 'readOnlyHint' : 'noActionsHint');
  $('stoppedBanner').hidden = !st.stopped;
  $('resume').hidden = !st.stopped;
  $('stop').hidden = st.stopped;
  button('stop').disabled = !available || st.serverSwitching;
  button('resume').disabled = !available || st.serverSwitching;
  renderControlled(st);
  renderSites(st);
  $('browserName').textContent = st.displayName;
  $('browserNameFull').textContent = st.displayName;
  if (!editingName) ($('displayName') as HTMLInputElement).value = st.displayName;
  $('pageDomain').textContent = st.pageSite ? new URL(st.pageSite).host : t('unsupportedPage');
  $('pageInitial').textContent = st.pageSite ? new URL(st.pageSite).hostname.charAt(0).toUpperCase() : '·';
  $('pageExplanation').textContent = t(st.pageSite === null ? 'unsupportedPageHint' : st.pageOwner ? (st.pageOwner.assistantOpened ? 'assistantPageHint' : 'sharedPageHint') : st.shareTarget.kind === 'next' ? 'noConversationHint' : 'shareHint');
  $('share').hidden = st.pageOwner !== null || st.shareTarget.kind === 'next';
  button('share').disabled = !st.canShare || st.stopped || !available;
  $('shareTarget').hidden = $('share').hidden || !st.canShare;
  $('shareTarget').textContent = st.shareTarget.kind === 'recent' && st.shareTarget.title
    ? t('shareTargetTitled', [st.shareTarget.title]) : t('shareTargetRecent');
  $('sharedRow').hidden = st.pageOwner === null;
  $('sharedOwner').textContent = st.pageOwner?.title || t('controlUntitled');
  button('unshare').disabled = st.stopped;
  $('showControls').hidden = st.controlTabId === null;
  button('showControls').disabled = st.serverSwitching;
  $('controlsHint').hidden = st.controlTabId === null;
  updateServerSettings();
  layout();
}

for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n ?? '');
document.documentElement.lang = chrome.i18n.getUILanguage();
$('siteFilter').setAttribute('aria-label', t('sitesFilter'));
($('siteFilter') as HTMLInputElement).placeholder = t('sitesFilter');
$('openPlatform').addEventListener('click', openPlatform);
$('gateOpenPlatform').addEventListener('click', openPlatform);
for (const el of document.querySelectorAll<HTMLElement>('[data-tab]')) el.addEventListener('click', () => selectTab(el.dataset.tab as Tab));
// 标签条的方向键切换（WAI-ARIA tabs）。
$('tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const next = TABS[(TABS.indexOf(tab) + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
  selectTab(next);
  $(`tab-${next}`).focus();
});
for (const el of document.querySelectorAll<HTMLElement>('[data-open]')) el.addEventListener('click', () => openSub(el.dataset.open as Sub));
for (const [id, type, error] of [['login', 'popup:login', 'loginFailed'], ['logout', 'popup:logout', 'logoutFailed']] as const) {
  $(id).addEventListener('click', async () => {
    button(id).disabled = true;
    $('authError').hidden = true;
    try {
      const result = await send<{ ok: boolean }>({ type: id === 'login' && latest?.signingIn ? 'popup:restartLogin' : type });
      if (!result?.ok) throw new Error('authentication_failed');
    } catch { $('authError').textContent = t(error); $('authError').hidden = false; }
    finally { await render(); }
  });
}
for (const el of document.querySelectorAll('[data-back]')) el.addEventListener('click', closeSub);
$('siteFilter').addEventListener('input', filterSites);
$('serverOrigin').addEventListener('input', () => { serverDraftDirty = true; resetServerStage(); });
$('saveServer').addEventListener('click', () => { void advanceServer(); });
$('cancelSwitch').addEventListener('click', () => { resetServerStage(); updateServerSettings(); });
$('restoreDefault').addEventListener('click', () => {
  ($('serverOrigin') as HTMLInputElement).value = PLATFORM_ORIGIN;
  serverDraftDirty = true;
  resetServerStage();
  void advanceServer();
});
$('rename').addEventListener('click', () => {
  editingName = true;
  $('nameSummary').hidden = true;
  $('nameForm').hidden = false;
  ($('displayName') as HTMLInputElement).focus();
});
function cancelName(): void {
  editingName = false;
  $('nameForm').hidden = true;
  $('nameSummary').hidden = false;
  $('nameError').hidden = true;
}
$('nameForm').addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); cancelName(); } });
$('nameForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('displayName') as HTMLInputElement;
  if (!input.value.trim()) { $('nameError').hidden = false; input.setAttribute('aria-invalid', 'true'); return; }
  button('saveName').disabled = true;
  try {
    const result = await send<{ ok: boolean }>({ type: 'popup:setDisplayName', name: input.value });
    if (result?.ok) { cancelName(); input.removeAttribute('aria-invalid'); await render(); }
    else $('nameError').hidden = false;
  } finally { button('saveName').disabled = false; }
});
for (const [id, type] of [['stop', 'popup:stop'], ['resume', 'popup:resume'], ['share', 'popup:share'], ['unshare', 'popup:unshare'], ['reconnect', 'popup:reconnect']] as const) {
  $(id).addEventListener('click', async () => {
    button(id).disabled = true;
    try { await send({ type }); await render(); } finally { button(id).disabled = false; }
  });
}
$('showControls').addEventListener('click', async () => {
  const state = latest;
  if (!state?.controlOrigin || state.controlTabId === null) return;
  const origin = new URL(state.controlOrigin);
  $('controlsError').hidden = true;
  try {
    const allowed = await chrome.permissions.request({ origins: [`${origin.protocol}//${origin.hostname}/*`] });
    if (!allowed) throw new Error('permission');
    const result = await send<{ ok: boolean }>({ type: 'popup:showControls', tabId: state.controlTabId, epoch: state.serverEpoch });
    if (!result?.ok) throw new Error('unavailable');
  } catch { $('controlsError').textContent = t('controlUnavailable'); $('controlsError').hidden = false; }
});
void render();
setInterval(() => { void render(); }, 2000);
