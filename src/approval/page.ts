// 确认小窗页面（approval.html）：显示站点与要确认的内容，交用户的答复。页面内容全部用 textContent 写入。

import type { PageMessage, PromptAnswer, PromptView } from '../messages';

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

const id = new URLSearchParams(location.search).get('id') ?? '';

function humanSize(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
    return t('unknownSize');
  }

  if (n < 1024) {
    return `${n} B`;
  }

  if (n < 1024 * 1024) {
    return `${(n / 1024).toFixed(1)} KB`;
  }

  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function line(label: string, value: string): HTMLElement {
  const p = document.createElement('p');
  const b = document.createElement('strong');
  b.textContent = `${label}：`;
  const v = document.createElement('span');
  v.textContent = value;
  p.append(b, v);
  return p;
}

const TITLES: Record<string, [string, string]> = {
  site: ['approvalTitleSite', 'approvalSiteBody'],
  password: ['approvalTitlePassword', 'approvalPasswordBody'],
  upload: ['approvalTitleUpload', 'approvalUploadBody'],
  download: ['approvalTitleDownload', 'approvalDownloadBody'],
  script: ['approvalTitleScript', 'approvalScriptWarning'],
};

function buttonsFor(view: PromptView): Array<[PromptAnswer, string]> {
  if (view.stage === 'self_wait') {
    return [['done', 'done'], ['deny', 'deny']];
  }

  switch (view.kind) {
    case 'site':
      return [['allow_once', 'allowOnce'], ['allow_always', 'allowAlways'], ['deny', 'deny']];
    case 'password':
      return [['allow', 'allow'], ['self', 'selfType'], ['deny', 'deny']];
    default:
      return [['allow', 'allow'], ['deny', 'deny']];
  }
}

function renderDetail(view: PromptView): void {
  const box = $('detail');
  box.replaceChildren();
  const d = view.detail;

  switch (view.kind) {
    case 'password':
      box.append(line(t('approvalField'), String(d.field ?? '')));
      break;
    case 'upload': {
      box.append(line(t('approvalField'), String(d.field ?? '')));
      const ul = document.createElement('ul');
      for (const f of (d.files as Array<{ name?: string; size?: number }> | undefined) ?? []) {
        const li = document.createElement('li');
        li.textContent = `${String(f.name ?? '')}（${humanSize(f.size)}）`;
        ul.append(li);
      }

      box.append(ul);
      break;
    }
    case 'download':
      box.append(line(t('approvalFile'), `${String(d.filename ?? '')}（${humanSize(d.size)}${d.content_type ? `，${String(d.content_type)}` : ''}）`));
      break;
    case 'script': {
      const pre = document.createElement('pre');
      pre.textContent = String(d.source ?? '');
      box.append(pre);
      break;
    }
    default:
  }
}

let countdownTimer: ReturnType<typeof setInterval> | null = null;

function render(view: PromptView): void {
  const [titleKey, bodyKey] = TITLES[view.kind] ?? ['approvalTitleSite', 'approvalSiteBody'];
  $('title').textContent = t(titleKey);
  const body = $('body');
  body.textContent = view.stage === 'self_wait' ? t('selfTypeBody') : t(bodyKey);
  body.className = view.kind === 'script' && view.stage === 'choose' ? 'warning' : '';
  $('site').textContent = view.site;
  renderDetail(view);

  $('review').hidden = view.reason === undefined;
  $('reviewReason').textContent = view.reason ?? '';

  const buttons = $('buttons');
  buttons.replaceChildren();
  for (const [answer, label] of buttonsFor(view)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t(label);
    b.addEventListener('click', () => {
      void answerWith(view, answer);
    });
    buttons.append(b);
  }

  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
  }

  const tick = () => {
    const left = Math.max(0, Math.ceil((view.expiresAt - Date.now()) / 1000));
    $('countdown').textContent = t('approvalCountdown', [String(left)]);
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function gone(): void {
  $('title').textContent = t('approvalGone');
  for (const el of ['body', 'site', 'detail', 'buttons', 'countdown']) {
    $(el).replaceChildren();
  }

  $('review').hidden = true;
}

async function answerWith(view: PromptView, answer: PromptAnswer): Promise<void> {
  const r = await send<{ ok: boolean }>({ type: 'prompt:answer', id, answer });
  if (!r?.ok) {
    gone();
    return;
  }

  if (answer === 'self') {
    // 后台把焦点放进字段后切到「完成」阶段：等阶段变了再重画。
    for (let i = 0; i < 40; i++) {
      await new Promise((res) => setTimeout(res, 150));
      const next = await send<PromptView | null>({ type: 'prompt:get', id });
      if (!next) {
        break;
      }

      if (next.stage === 'self_wait') {
        render(next);
        return;
      }
    }
  }

  window.close();
}

async function load(): Promise<void> {
  // 窗口刚建好时后台可能还没记下窗口 id：稍等重试几次。
  for (let i = 0; i < 20; i++) {
    const view = await send<PromptView | null>({ type: 'prompt:get', id });
    if (view) {
      render(view);
      return;
    }

    await new Promise((res) => setTimeout(res, 100));
  }

  gone();
}

for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
  el.textContent = t(el.dataset.i18n ?? '');
}

void load();
