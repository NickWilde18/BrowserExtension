// 确认窗页面（设计状态集 07「确认窗」）：请求来源与详情按纯文本展示；默认焦点在「拒绝」，关闭与 Esc 交给后台按拒绝
// 收尾，不触发全局停止。允许 / 拒绝 / 输入完成提交期间按钮全部禁用，后台收下答复后直接关窗，没有结果页。到时没答
// 改显示「确认已过期，请查看页面」，只留关闭——到时没答和主动拒绝分开记，也不暗示页面没有变化。

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

/** 事实块里的一项：小标签 + 加粗的值。请求所在 / 要去的站点那一项带 id="site"。 */
function fact(box: HTMLElement, labelKey: string, value: string, isSite = false): void {
  const label = document.createElement('span');
  label.className = 'label';
  label.textContent = t(labelKey);
  const strong = document.createElement('strong');
  strong.dir = 'auto';
  strong.textContent = value;
  if (isSite) strong.id = 'site';
  box.append(label, strong);
}

/** 文件名与大小分行，不让长文件名把按钮挤出窗口。只有文件名，没有本机路径。 */
function fileItem(name: string, size: unknown, contentType?: string): HTMLLIElement {
  const li = document.createElement('li');
  const filename = document.createElement('strong');
  filename.dir = 'auto';
  filename.textContent = name;
  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = [humanSize(size), contentType].filter(Boolean).join(' · ');
  li.append(filename, meta);
  return li;
}

/** 页面要从一个站点跳到另一个站点时，站点确认带着来源（只给本地显示）。 */
function fromSite(view: PromptView): string {
  return view.kind === 'site' && typeof view.detail.from === 'string' ? view.detail.from : '';
}

const TEXT: Record<string, [title: string, body: string]> = {
  site: ['approvalTitleSite', 'approvalSiteBody'],
  navigate: ['approvalTitleNavigate', 'approvalNavigateBody'],
  password: ['approvalTitlePassword', 'approvalPasswordBody'],
  upload: ['approvalTitleUpload', 'approvalUploadBody'],
  download: ['approvalTitleDownload', 'approvalDownloadBody'],
  script: ['approvalTitleScript', 'approvalScriptBody'],
};

function renderFacts(view: PromptView): void {
  const box = $('facts');
  box.replaceChildren();
  const d = view.detail;

  switch (view.kind) {
    case 'site': {
      const from = fromSite(view);
      if (from) {
        fact(box, 'approvalFrom', from);
        fact(box, 'approvalTo', view.site, true);
      } else {
        fact(box, 'approvalSite', view.site, true);
      }

      break;
    }
    case 'password':
      fact(box, 'approvalPasswordSite', view.site, true);
      if (typeof d.field === 'string' && d.field !== '') fact(box, 'approvalField', d.field);
      break;
    case 'upload': {
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = t('approvalFiles');
      const ul = document.createElement('ul');
      ul.className = 'files';
      ul.setAttribute('aria-label', t('approvalFiles'));
      for (const f of (d.files as Array<{ name?: string; size?: number }> | undefined) ?? []) {
        ul.append(fileItem(String(f.name ?? ''), f.size));
      }

      box.append(label, ul);
      fact(box, 'approvalUploadTo', view.site, true);
      break;
    }
    case 'download': {
      const label = document.createElement('span');
      label.className = 'label';
      label.textContent = t('approvalFile');
      const ul = document.createElement('ul');
      ul.className = 'files';
      ul.setAttribute('aria-label', t('approvalFile'));
      ul.append(fileItem(String(d.filename ?? ''), d.size, String(d.content_type ?? '')));
      const note = document.createElement('span');
      note.className = 'fact-note';
      note.textContent = t('approvalDownloadNote');
      box.append(label, ul, note);
      break;
    }
    case 'script':
      fact(box, 'approvalSite', view.site, true);
      break;
    default:
  }

  box.hidden = box.childElementCount === 0;
}

type Choice = { answer: PromptAnswer; label: string; style: 'primary' | 'link' | ''; busyLabel: string };

function choicesFor(view: PromptView): Choice[] {
  const deny: Choice = { answer: 'deny', label: 'deny', style: '', busyLabel: 'approvalSubmittingButton' };
  if (view.stage === 'self_wait') {
    return [{ ...deny, label: 'cancel' }, { answer: 'done', label: 'inputComplete', style: 'primary', busyLabel: 'approvalSubmittingDone' }];
  }

  switch (view.kind) {
    case 'site':
      // 站点保留两档：「允许」只授权这段对话；「总是允许此站点」放成文字按钮，更宽松的选项不更显眼。
      return [
        { answer: 'allow_always', label: 'allowAlways', style: 'link', busyLabel: 'approvalSubmittingButton' },
        deny,
        { answer: 'allow_once', label: 'allow', style: 'primary', busyLabel: 'approvalSubmittingButton' },
      ];
    case 'password':
      return [
        { answer: 'self', label: 'selfType', style: 'link', busyLabel: 'approvalSubmittingButton' },
        deny,
        { answer: 'allow', label: 'allow', style: 'primary', busyLabel: 'approvalSubmittingButton' },
      ];
    default:
      return [deny, { answer: 'allow', label: 'allow', style: 'primary', busyLabel: 'approvalSubmittingButton' }];
  }
}

let current: PromptView | null = null;
let countdownTimer: ReturnType<typeof setInterval> | null = null;
let answering = false;
/** 本阶段开始时的总秒数：进度条按它算比例。 */
let totalSeconds = 1;
let finished = false;

function stopCountdown(): void {
  if (countdownTimer !== null) {
    clearInterval(countdownTimer);
    countdownTimer = null;
  }
}

/** 收起请求内容，只留一个「关闭」：到时没答、确认已经结束时用。 */
function ending(titleKey: string, bodyKey: string | null): void {
  finished = true;
  ($('close') as HTMLButtonElement).disabled = false;
  stopCountdown();
  $('title').textContent = t(titleKey);
  document.title = `${t(titleKey)} · ${t('brandName')}`;
  $('body').textContent = bodyKey ? t(bodyKey) : '';
  $('body').hidden = bodyKey === null;
  for (const el of ['facts', 'scriptBox', 'review', 'clock', 'pending', 'kbdNote']) {
    $(el).hidden = true;
  }

  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = t('approvalClose');
  close.addEventListener('click', () => window.close());
  $('buttons').className = 'actions single';
  $('buttons').replaceChildren(close);
  $('close').setAttribute('aria-label', t('approvalCloseWindow'));
  $('close').title = t('approvalCloseWindow');
  close.focus({ preventScroll: true });
  void fitWindow();
}

function expired(): void {
  ending('approvalExpiredTitle', 'approvalExpiredBody');
}

function gone(): void {
  ending('approvalGone', null);
}

function render(view: PromptView): void {
  if (view.stage === 'expired') {
    current = view;
    expired();
    return;
  }

  const stageChanged = current?.id !== view.id || current.stage !== view.stage;
  current = view;
  answering = false;
  finished = false;
  ($('close') as HTMLButtonElement).disabled = false;

  const navigate = fromSite(view) !== '';
  const [titleKey, bodyKey] = TEXT[navigate ? 'navigate' : view.kind] ?? TEXT.site!;
  const title = t(view.stage === 'self_wait' ? 'approvalTitleSelf' : titleKey);
  $('title').textContent = title;
  document.title = `${title} · ${t('brandName')}`;
  $('body').hidden = false;
  $('body').textContent = t(view.stage === 'self_wait' ? 'selfTypeBody' : bodyKey);

  $('conversationRow').hidden = !view.conversationTitle?.trim();
  $('conversation').textContent = view.conversationTitle ?? '';
  $('conversation').title = view.conversationTitle ?? '';

  if (view.stage === 'self_wait') {
    $('facts').replaceChildren();
    fact($('facts'), 'approvalSite', view.site, true);
    $('facts').hidden = false;
  } else {
    renderFacts(view);
  }

  // 脚本默认收起，展开后等宽字体、独立滚动；长脚本能用键盘读完。
  const script = view.kind === 'script' && view.stage === 'choose';
  $('scriptBox').hidden = !script;
  if (script) {
    const pre = $('script');
    pre.textContent = String(view.detail.source ?? '');
    pre.tabIndex = 0;
    pre.setAttribute('role', 'region');
    pre.setAttribute('aria-label', t('approvalScript'));
  }

  $('review').hidden = view.reason === undefined;
  $('reviewReason').textContent = view.reason ?? '';
  $('pending').hidden = true;
  // 「我自己输入」等完成时不显示倒计时（设计稿）；后台仍按时限收尾，到时改显示已过期。
  $('clock').hidden = view.stage === 'self_wait';
  $('kbdNote').hidden = view.stage !== 'choose';
  $('close').setAttribute('aria-label', t('approvalCloseLabel'));
  $('close').title = t('approvalCloseLabel');

  const buttons = $('buttons');
  buttons.className = 'actions';
  buttons.replaceChildren();
  let focus: HTMLButtonElement | null = null;
  for (const choice of choicesFor(view)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = t(choice.label);
    b.className = choice.style;
    b.dataset.answer = choice.answer;
    b.addEventListener('click', () => {
      void answerWith(view, choice, b);
    });
    buttons.append(b);
    if (choice.answer === 'deny' && view.stage === 'choose') focus = b;
  }

  // 默认焦点在「拒绝」：新窗口里误按 Enter 不会放行；Tab 能到所有选项、关闭入口与长脚本。
  (focus ?? buttons.querySelector('button'))?.focus({ preventScroll: true });

  stopCountdown();
  if (stageChanged) {
    totalSeconds = Math.max(1, Math.ceil((view.expiresAt - Date.now()) / 1000));
  }

  const tick = () => {
    const left = Math.max(0, Math.ceil((view.expiresAt - Date.now()) / 1000));
    $('countdown').textContent = t('approvalCountdown', [String(left)]);
    $('track').style.width = `${Math.min(100, (left / totalSeconds) * 100)}%`;
    if (left === 0 && !answering) {
      expired();
    }
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
  void fitWindow();
}

async function answerWith(view: PromptView, choice: Choice, button: HTMLButtonElement): Promise<void> {
  if (answering || finished) {
    return;
  }

  answering = true;
  ($('close') as HTMLButtonElement).disabled = true;
  for (const b of $('buttons').querySelectorAll('button')) {
    b.disabled = true;
  }

  button.textContent = t(choice.busyLabel);
  $('clock').hidden = true;
  $('pending').hidden = false;
  void fitWindow();

  let ok = false;
  try {
    ok = (await send<{ ok: boolean }>({ type: 'prompt:answer', id, answer: choice.answer }))?.ok === true;
  } catch {
    ok = false;
  }

  if (!ok) {
    // 后台没收下：多半是刚好到时（已过期）或确认已经结束（窗口外被取消）。
    if (Date.now() >= view.expiresAt - 500) expired();
    else gone();
    return;
  }

  if (choice.answer === 'self') {
    // 后台把焦点放进字段后切到「输入完成」阶段：等阶段变了再重画。
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
document.title = t('approvalWindowTitle');
for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
  el.textContent = t(el.dataset.i18n ?? '');
}

$('close').setAttribute('aria-label', t('approvalCloseLabel'));
$('close').title = t('approvalCloseLabel');
// 关闭与 Esc：确认还在等时由后台按拒绝收尾；已过期、已结束时只是关窗。
$('close').addEventListener('click', () => window.close());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    if (!answering || finished) window.close();
  }
});

// 包含宽度变化后的折行及「我自己输入」的阶段变化，不靠固定内容行数估算高度。
new ResizeObserver(() => { void fitWindow(); }).observe($('content'));
void load();
