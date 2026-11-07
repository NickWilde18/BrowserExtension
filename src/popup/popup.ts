// 插件弹窗：连接状态、当前账号、显示名、Auto Mode 开关、共享此页、停止 / 恢复、已授权站点、首次连接说明。

import type { PageMessage, PopupState } from '../messages';

const t = (key: string, subs?: string[]): string => chrome.i18n.getMessage(key, subs) || key;

function send<T>(msg: PageMessage): Promise<T> {
  return chrome.runtime.sendMessage(msg) as Promise<T>;
}

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`missing #${id}`);
  }

  return el;
}

function applyI18n(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = t(el.dataset.i18n ?? '');
  }
}

const RECONNECTABLE = new Set(['replaced', 'error', 'offline', 'waiting_login']);

type ServerState = Pick<PopupState,
  'serverOrigin' | 'serverEpoch' | 'serverSwitching' | 'serverPermissionGranted'>;
let latestServerState: ServerState | null = null;
let latestControlState: Pick<PopupState, 'controlOrigin' | 'controlTabId' | 'serverEpoch'> | null = null;
let serverDraftDirty = false;
let serverSaving = false;
let serverFeedback: { key: string; error: boolean } | null = null;
let controlledSignature = '';

function renderControlledConversations(st: PopupState): void {
  const signature = JSON.stringify([st.serverEpoch, st.controlledConversations, st.serverSwitching]);
  if (signature === controlledSignature) return;
  controlledSignature = signature;
  $('controlledSection').hidden = st.controlledConversations.length === 0;
  const items = st.controlledConversations.map((entry) => {
    const item = document.createElement('li');
    const title = document.createElement('span');
    title.textContent = entry.title;
    item.append(title);
    if (entry.mode === 'user') {
      const button = document.createElement('button');
      button.textContent = t('controlResume');
      button.disabled = st.serverSwitching;
      button.addEventListener('click', async () => {
        button.disabled = true;
        try {
          const result = await send<{ ok: boolean }>({ type: 'popup:resumeConversation', conversation: entry.conversation, epoch: st.serverEpoch });
          if (!result?.ok) throw new Error('unavailable');
          await render();
        } catch {
          button.disabled = false;
          const note = document.createElement('span');
          note.textContent = t('controlUnavailable');
          item.append(note);
        }
      });
      item.append(button);
    } else {
      const mode = document.createElement('span');
      mode.textContent = t(entry.mode === 'observing' ? 'controlObserve' : 'controlTaking');
      item.append(mode);
    }
    return item;
  });
  $('controlledConversations').replaceChildren(...items);
}

function normalizeServerOrigin(value: string): URL | null {
  // 只接收来源地址；不默默剥掉路径或凭据，也不让 URL 的宽松解析接收反斜杠等输入。
  const candidate = value.trim();
  if (!/^https?:\/\/[^/?#\\\s@]+\/?$/i.test(candidate)) {
    return null;
  }

  try {
    const url = new URL(candidate);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.hostname !== '' && url.username === ''
      && url.pathname === '/' && url.search === '' && url.hash === '' ? url : null;
  } catch {
    return null;
  }
}

function updateServerSettings(): void {
  if (!($('advanced') as HTMLDetailsElement).open) {
    return;
  }

  const input = $('serverOrigin') as HTMLInputElement;
  const snapshot = latestServerState;
  if (snapshot && !serverDraftDirty && !serverSaving && document.activeElement !== input) {
    input.value = snapshot.serverOrigin;
  }

  const switching = snapshot?.serverSwitching === true;
  input.disabled = serverSaving || switching;
  ($('saveServer') as HTMLButtonElement).disabled = !snapshot || serverSaving || switching;
  $('serverPermissionHint').hidden = !snapshot || snapshot.serverPermissionGranted;
  const feedback = serverSaving ? serverFeedback
    : switching ? { key: 'serverSwitching', error: false } : serverFeedback;
  const status = $('serverError');
  status.hidden = !feedback;
  status.textContent = feedback ? t(feedback.key) : '';
  status.dataset.error = String(feedback?.error === true);
  input.setAttribute('aria-invalid', String(feedback?.key === 'serverInvalidOrigin'));
}

function wireServerSettings(): void {
  $('advanced').addEventListener('toggle', () => {
    if (($('advanced') as HTMLDetailsElement).open) {
      updateServerSettings();
      void render();
    }
  });

  $('serverOrigin').addEventListener('input', () => {
    serverDraftDirty = true;
    serverFeedback = null;
    updateServerSettings();
  });

  $('saveServer').addEventListener('click', async () => {
    if (serverSaving || latestServerState?.serverSwitching) {
      return;
    }

    const input = $('serverOrigin') as HTMLInputElement;
    const url = normalizeServerOrigin(input.value);
    if (!url) {
      serverFeedback = { key: 'serverInvalidOrigin', error: true };
      updateServerSettings();
      return;
    }

    // epoch 使用最近 render 的快照。权限请求前不能异步取 state，以免丢失用户手势。
    const snapshot = latestServerState;
    if (!snapshot) {
      serverFeedback = { key: 'serverStateUnavailable', error: true };
      updateServerSettings();
      return;
    }

    serverSaving = true;
    serverFeedback = { key: 'serverRequestingPermission', error: false };
    updateServerSettings();
    try {
      const granted = await chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
      if (!granted) {
        serverFeedback = { key: 'serverPermissionDenied', error: true };
        return;
      }

      serverFeedback = { key: 'serverSwitching', error: false };
      updateServerSettings();
      const result = await send<{ ok: boolean; error?: string }>({
        type: 'popup:setServer', origin: url.origin, epoch: snapshot.serverEpoch,
      });
      if (result?.ok) {
        serverDraftDirty = false;
        input.value = url.origin;
        serverFeedback = { key: 'serverSaved', error: false };
      } else {
        serverFeedback = { key: 'serverSaveFailed', error: true };
      }
    } catch {
      // 不直接展示后台错误，避免把连接内部信息带到界面上。
      serverFeedback = { key: 'serverSaveFailed', error: true };
    } finally {
      serverSaving = false;
      updateServerSettings();
      void render();
    }
  });
}

function siteItem(site: string, scope: string): HTMLLIElement {
  const li = document.createElement('li');
  const text = document.createElement('span');
  const name = document.createElement('span');
  name.className = 'site';
  name.textContent = site;
  const label = document.createElement('span');
  label.className = 'scope';
  label.textContent = ` · ${scope}`;
  text.append(name, label);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = t('revoke');
  btn.addEventListener('click', () => {
    void send({ type: 'popup:revokeSite', site }).then(render);
  });

  li.append(text, btn);
  return li;
}

async function render(): Promise<void> {
  const st = await send<PopupState | null>({ type: 'popup:state' });
  if (!st) {
    return;
  }

  renderControlledConversations(st);
  latestControlState = { controlOrigin: st.controlOrigin, controlTabId: st.controlTabId, serverEpoch: st.serverEpoch };
  $('showControls').hidden = st.controlTabId === null;
  ($('showControls') as HTMLButtonElement).disabled = st.serverSwitching;
  $('controlsHint').hidden = st.controlTabId === null;
  latestServerState = {
    serverOrigin: st.serverOrigin,
    serverEpoch: st.serverEpoch,
    serverSwitching: st.serverSwitching,
    serverPermissionGranted: st.serverPermissionGranted,
  };
  updateServerSettings();

  // 插件没在平台登记（stream 上的 403）时停住不重试，提示和「稍后会重试」的 error 分开。
  const key = st.connection === 'error' && st.lastError === 'origin_not_allowed'
    ? 'stateOrigin_not_allowed'
    : `state${st.connection.charAt(0).toUpperCase()}${st.connection.slice(1)}`;
  $('state').textContent = t(key);
  $('accountRow').hidden = !st.account;
  $('account').textContent = st.account ?? '';
  $('reconnect').hidden = !RECONNECTABLE.has(st.connection);

  $('intro').hidden = st.introSeen;
  $('stoppedRow').hidden = !st.stopped;
  $('stop').hidden = st.stopped;

  const name = $('displayName') as HTMLInputElement;
  if (document.activeElement !== name) {
    name.value = st.displayName;
  }

  ($('autoMode') as HTMLInputElement).checked = st.autoMode;

  $('share').hidden = !st.canShare || st.shared;
  // 「将共享给」跟着按钮显示。对话标题来自平台，按纯文本放（textContent），不当 HTML。
  const target = $('shareTarget');
  target.hidden = $('share').hidden;
  target.textContent = st.shareTarget.kind === 'next'
    ? t('shareTargetNext')
    : st.shareTarget.title === '' ? t('shareTargetRecent') : t('shareTargetTitled', [st.shareTarget.title]);
  $('sharedRow').hidden = !st.shared;
  $('shareNote').hidden = !st.canShare && !st.shared;

  const list = $('sites');
  list.replaceChildren(
    ...st.sites.always.map((s) => siteItem(s, t('sitesAlways'))),
    ...st.sites.conversation.map((s) => siteItem(s, t('sitesConversation'))),
  );
  $('sitesNone').hidden = st.sites.always.length + st.sites.conversation.length > 0;
}

function wire(): void {
  $('showControls').addEventListener('click', async () => {
    const state = latestControlState;
    if (!state?.controlOrigin || state.controlTabId === null) return;
    const origin = new URL(state.controlOrigin);
    $('controlsError').hidden = true;
    try {
      // 不先 await 查询页面，以保留用户点击带来的权限申请手势。
      const allowed = await chrome.permissions.request({ origins: [`${origin.protocol}//${origin.hostname}/*`] });
      if (!allowed) {
        $('controlsError').textContent = t('controlPermissionDenied');
        $('controlsError').hidden = false;
        return;
      }
      const result = await send<{ ok: boolean }>({ type: 'popup:showControls', tabId: state.controlTabId, epoch: state.serverEpoch });
      if (!result?.ok) throw new Error('unavailable');
    } catch {
      $('controlsError').textContent = t('controlUnavailable');
      $('controlsError').hidden = false;
    }
  });
  $('introOk').addEventListener('click', () => {
    void send({ type: 'popup:dismissIntro' }).then(render);
  });

  $('saveName').addEventListener('click', () => {
    const input = $('displayName') as HTMLInputElement;
    void send<{ ok: boolean }>({ type: 'popup:setDisplayName', name: input.value }).then((r) => {
      if (r?.ok) {
        ($('saveName') as HTMLButtonElement).textContent = t('saved');
        setTimeout(() => {
          ($('saveName') as HTMLButtonElement).textContent = t('save');
        }, 1500);
      }

      input.blur();
      return render();
    });
  });

  $('autoMode').addEventListener('change', (e) => {
    void send({ type: 'popup:setAutoMode', on: (e.target as HTMLInputElement).checked }).then(render);
  });

  $('stop').addEventListener('click', () => {
    void send({ type: 'popup:stop' }).then(render);
  });

  $('resume').addEventListener('click', () => {
    void send({ type: 'popup:resume' }).then(render);
  });

  $('share').addEventListener('click', () => {
    void send<{ ok: boolean; pending?: boolean }>({ type: 'popup:share' }).then((r) => {
      if (r?.pending) {
        $('shareNote').textContent = t('sharePending');
      }

      return render();
    });
  });

  $('unshare').addEventListener('click', () => {
    void send({ type: 'popup:unshare' }).then(render);
  });

  $('reconnect').addEventListener('click', () => {
    void send({ type: 'popup:reconnect' }).then(render);
  });
}

applyI18n();
wire();
wireServerSettings();
void render();
setInterval(() => {
  void render();
}, 2000);
