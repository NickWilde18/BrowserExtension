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

  const key = `state${st.connection.charAt(0).toUpperCase()}${st.connection.slice(1)}`;
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
void render();
setInterval(() => {
  void render();
}, 2000);
