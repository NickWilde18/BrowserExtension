// 插件弹窗（设计状态集07）：连接、当前页面、站点授权归属、逐对话继续与全局停止、高级设置。
// 所有来自页面/对话的标题和站点均按纯文本显示。页头和停止入口固定，中间独立滚动。
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
let view = 'home';
let editingName = false;
let busy = false;
let serverStage: 'draft' | 'permission' | 'confirm' = 'draft';
let serverDraftDirty = false;
let candidate: URL | null = null;
let permissionEpoch = '';
let controlledSignature = '';
let siteSignature = '';

function show(next: string): void {
  view = next;
  for (const name of ['home', 'settings', 'about']) $(`${name}View`).hidden = name !== next;
  document.querySelector('main')!.scrollTop = 0;
  if (next === 'settings' && latest) $('currentOrigin').textContent = latest.serverOrigin;
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
  $('controlledSection').hidden = st.controlledConversations.length === 0;
  $('controlledConversations').replaceChildren(...st.controlledConversations.map((entry) => {
    const item = document.createElement('li');
    const title = document.createElement('span');
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
  $('siteFilter').hidden = groups.length <= 5;
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
    remove.className = 'link';
    remove.textContent = t('revoke');
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
  $('state').textContent = t(st.signingIn ? 'signingIn' : stateKey);
  $('accountRow').hidden = !available || !st.account;
  $('account').textContent = available ? st.account ?? '' : '';
  $('connectionMarker').className = st.connection === 'connecting' ? 'spinner' : `dot${available ? '' : ' warn'}`;
  $('connectedBody').hidden = !available;
  $('openPlatform').hidden = available && st.shareTarget.kind !== 'next';
  $('reconnect').hidden = !['replaced', 'error', 'offline'].includes(st.connection);
  $('login').hidden = st.connection !== 'waiting_login';
  // 登录中仍可点：授权页被导航走或关不掉时，用户能中止这次并重新开始，不必等超时。
  button('login').disabled = st.serverSwitching || !st.serverPermissionGranted;
  button('login').textContent = t(st.signingIn ? 'restartLogin' : 'login');
  $('logout').hidden = st.connection === 'waiting_login';
  button('logout').disabled = st.serverSwitching;
  $('executionHint').hidden = !readOnly && st.supportedActions.length > 0;
  $('executionHint').textContent = t(readOnly ? 'readOnlyHint' : 'noActionsHint');
  $('stoppedRow').hidden = !st.stopped;
  $('stopRow').hidden = st.stopped;
  button('stop').disabled = !available || st.serverSwitching;
  button('resume').disabled = !available || st.serverSwitching;
  renderControlled(st);
  renderSites(st);
  $('browserName').textContent = st.displayName;
  if (!editingName) ($('displayName') as HTMLInputElement).value = st.displayName;
  $('pageDomain').textContent = st.pageSite ? new URL(st.pageSite).host : t('unsupportedPage');
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
}

for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) el.textContent = t(el.dataset.i18n ?? '');
document.documentElement.lang = chrome.i18n.getUILanguage();
$('siteFilter').setAttribute('aria-label', t('sitesFilter'));
($('siteFilter') as HTMLInputElement).placeholder = t('sitesFilter');
$('openPlatform').addEventListener('click', openPlatform);
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
$('openSettings').addEventListener('click', () => show('settings'));
$('about').addEventListener('click', () => show('about'));
for (const el of document.querySelectorAll('[data-back]')) el.addEventListener('click', () => show('home'));
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
