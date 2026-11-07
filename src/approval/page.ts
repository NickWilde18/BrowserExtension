// 确认小窗页面：请求来源与详情按纯文本展示；关闭与 Esc 交给后台按拒绝收尾，不触发全局停止。

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
  const row = document.createElement('div');
  row.className = 'detail-row';
  const name = document.createElement('span');
  name.className = 'detail-label';
  name.textContent = label;
  const text = document.createElement('div');
  text.className = 'detail-value';
  text.dir = 'auto';
  text.textContent = value;
  row.append(name, text);
  return row;
}

/** 文件名与大小分行，不让长文件名把动作按钮挤出窗口。 */
function fileItem(name: string, size: unknown, contentType?: string): HTMLLIElement {
  const li = document.createElement('li');
  const filename = document.createElement('span');
  filename.className = 'filename';
  filename.dir = 'auto';
  filename.textContent = name;
  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = [humanSize(size), contentType].filter(Boolean).join(' · ');
  li.append(filename, meta);
  return li;
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
    return [['deny', 'deny'], ['done', 'done']];
  }

  switch (view.kind) {
    case 'site':
      return [['deny', 'deny'], ['allow_always', 'allowAlways'], ['allow_once', 'allowOnce']];
    case 'password':
      return [['deny', 'deny'], ['self', 'selfType'], ['allow', 'allow']];
    default:
      return [['deny', 'deny'], ['allow', 'allow']];
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
      ul.className = 'files';
      ul.setAttribute('aria-label', t('approvalFiles'));
      for (const f of (d.files as Array<{ name?: string; size?: number }> | undefined) ?? []) {
        ul.append(fileItem(String(f.name ?? ''), f.size));
      }

      box.append(ul);
      break;
    }
    case 'download': {
      const heading = document.createElement('h2');
      heading.textContent = t('approvalFile');
      const ul = document.createElement('ul');
      ul.className = 'files';
      ul.setAttribute('aria-label', t('approvalFile'));
      ul.append(fileItem(String(d.filename ?? ''), d.size, String(d.content_type ?? '')));
      box.append(heading, ul);
      break;
    }
    case 'script': {
      const heading = document.createElement('h2');
      heading.textContent = t('approvalScript');
      const pre = document.createElement('pre');
      pre.textContent = String(d.source ?? '');
      // 长脚本须能靠键盘完整读完，不能只让鼠标滚动。
      pre.tabIndex = 0;
      pre.setAttribute('role', 'region');
      pre.setAttribute('aria-label', t('approvalScript'));
      box.append(heading, pre);
      break;
    }
    default:
  }

  box.hidden = box.childElementCount === 0;
}

let countdownTimer: ReturnType<typeof setInterval> | null = null;
let answering = false;

function render(view: PromptView): void {
  answering = false;
  const [titleKey, bodyKey] = TITLES[view.kind] ?? ['approvalTitleSite', 'approvalSiteBody'];
  const title = t(view.stage === 'self_wait' ? 'approvalTitleSelf' : titleKey);
  $('title').textContent = title;
  document.title = `${title} · ${t('extName')}`;
  const body = $('body');
  body.textContent = t(view.stage === 'self_wait' ? 'selfTypeBody' : bodyKey);
  body.className = view.kind === 'script' && view.stage === 'choose' ? 'description warning' : 'description';
  $('site').textContent = view.site;
  $('conversationRow').hidden = !view.conversationTitle?.trim();
  $('conversation').textContent = view.conversationTitle ?? '';
  renderDetail(view);

  $('review').hidden = view.reason === undefined;
  $('reviewReason').textContent = view.reason ?? '';

  const buttons = $('buttons');
  buttons.replaceChildren();
  for (const [answer, label] of buttonsFor(view)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t(label);
    if (answer === 'allow' || answer === 'allow_once' || answer === 'done') {
      b.className = 'primary';
    }

    b.addEventListener('click', () => {
      void answerWith(view, answer);
    });
    buttons.append(b);
  }

  // 新窗口的 Enter 不应意外放行；Tab 可以到所有允许选项、关闭入口与长脚本。
  buttons.querySelector('button')?.focus({ preventScroll: true });
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
  }

  const tick = () => {
    const left = Math.max(0, Math.ceil((view.expiresAt - Date.now()) / 1000));
    $('countdown').textContent = t('approvalCountdown', [String(left)]);
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
  void fitWindow();
}

function gone(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }

  $('title').textContent = t('approvalGone');
  document.title = `${t('approvalGone')} · ${t('extName')}`;
  for (const el of ['body', 'context', 'detail', 'buttons', 'countdown', 'closeHint', 'review']) {
    $(el).hidden = true;
  }

  $('close').focus();
  void fitWindow();
}

async function answerWith(view: PromptView, answer: PromptAnswer): Promise<void> {
  if (answering) {
    return;
  }

  answering = true;
  for (const button of $('buttons').querySelectorAll('button')) {
    button.disabled = true;
  }

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

let fitting = false;
let fitAgain = false;

/** 按自然内容高度调整独立窗口；把原生标题栏和调试提示条算进去，超出屏幕的内容留在中间滚动。 */
async function fitWindow(): Promise<void> {
  if (fitting) {
    fitAgain = true;
    return;
  }

  fitting = true;
  try {
    const win = await chrome.windows.getCurrent();
    // 直接在普通标签里打开页面时，不调整用户的浏览器主窗口。
    if (win.type !== 'popup' || win.id === undefined) {
      return;
    }

    const main = document.querySelector('main')!;
    const content = $('content');
    const naturalHeight = main.getBoundingClientRect().height + content.scrollHeight - content.clientHeight;
    const frameHeight = Math.max(0, (win.height ?? outerHeight) - innerHeight);
    const height = Math.min(screen.availHeight, Math.ceil(naturalHeight + frameHeight));
    if (Math.abs((win.height ?? outerHeight) - height) > 2) {
      await chrome.windows.update(win.id, { height });
    }
  } catch {
    // 用户可能已经关闭窗口；尺寸调整失败不影响当前确认的答复。
  } finally {
    fitting = false;
    if (fitAgain) {
      fitAgain = false;
      void fitWindow();
    }
  }
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

document.documentElement.lang = chrome.i18n.getUILanguage();
document.title = t('extName');
for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
  el.textContent = t(el.dataset.i18n ?? '');
}

$('close').setAttribute('aria-label', t('approvalCloseLabel'));
$('close').title = t('approvalCloseLabel');
$('close').addEventListener('click', () => window.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    window.close();
  }
});

// 包含宽度变化后的折行及「我自己输入」的阶段变化，不靠固定内容行数估算高度。
new ResizeObserver(() => { void fitWindow(); }).observe($('content'));
void load();
