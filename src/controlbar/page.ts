// 在已授予来源权限的归属页顶层运行；不使用 CDP，不在网页里做授权确认（等确认时只引导去独立确认窗）。
//
// 界面按第二版（Tark#528 拍板 rev 531）：右下角距边 16px；展开时校徽 + 状态、带文字的「收起」按钮、动作与对话标题、
// 说明和「手动接管」；收起成带转圈外环的校徽圆钮，左边一枚胶囊写状态（圆点 + 文字，不只靠颜色）。
// 不显示网址、账号、用户的问题或输入内容。
import emblem from '../../static/icons/emblem.png';
import type { PanelBinding, PanelRender, PanelReply } from './protocol';
import type { ControlView } from '../browser/control';

/** 设计稿的状态：交接中等插件回执、接管后由用户操作、继续前先重新看页面。 */
type Phase = 'working' | 'waiting' | 'handoff' | 'taken' | 'recheck';

function phaseOf(view: ControlView): Phase {
  if (view.mode === 'taking_over') return 'handoff';
  if (view.mode === 'user') return 'taken';
  if (view.waiting) return 'waiting';
  return view.mode === 'observing' ? 'recheck' : 'working';
}

(() => {
  const world = globalThis as typeof globalThis & { __browserControlBar?: boolean };
  if (world.__browserControlBar) return;
  world.__browserControlBar = true;
  const host = document.createElement('div');
  host.id = 'browser-assistant-controls';
  // 关闭的 shadow root 减少网页脚本和页面快照对控件的干扰，授权边界仍由后台校验。
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  // 颜色取设计稿的语义变量；网页的样式进不来（all:initial + 关闭的 shadow root），明暗跟随系统。
  style.textContent = `
    :host{all:initial;position:fixed!important;right:16px!important;bottom:16px!important;z-index:2147483647!important;display:block!important;
      --bg:#fff;--card:#f8f7f9;--sunk:#f1eff3;--fg:#252327;--muted:#625c68;--line:#e4e0e8;--purple:#751276;--on-purple:#fff;--warn:#80570d;--ok:#316347;--danger:#963b40;color-scheme:light}
    @media (prefers-color-scheme:dark){:host{--bg:#232126;--card:#2b282f;--sunk:#1d1b20;--fg:#eeebf0;--muted:#b9b1bf;--line:#403a46;--purple:#dda2df;--on-purple:#28172d;--warn:#edc477;--ok:#a5d4b5;--danger:#efb1b5;color-scheme:dark}}
    *{box-sizing:border-box}
    .bar,.mini{font:13px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg)}
    .bar{position:relative;width:min(336px,calc(100vw - 32px));background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px;box-shadow:0 8px 28px #2a0f2b2e,0 1px 3px #0000001a;overflow:hidden}
    .bar::before{content:"";position:absolute;left:0;top:12px;bottom:12px;width:3px;border-radius:0 3px 3px 0;background:var(--purple)}
    .head{display:flex;align-items:center;gap:8px}
    .head>img{width:22px;height:22px;object-fit:contain;flex-shrink:0}
    .state{flex:1;min-width:0;font-size:13px;font-weight:600;display:flex;align-items:center;gap:7px}
    .line{margin:6px 0 10px 30px;font-size:12px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .line b{color:var(--fg);font-weight:500}
    .grid{display:flex;align-items:center;gap:8px;margin-left:30px}
    .help{flex:1;min-width:0;font-size:11px;line-height:1.5;color:var(--muted);margin:0}
    .error{font-size:12px;color:var(--danger);margin:0 0 8px 30px}
    button{font:inherit;cursor:pointer;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg);padding:0 12px;min-height:32px;font-size:13px;font-weight:500;line-height:1.35;display:inline-flex;align-items:center;justify-content:center;gap:6px;white-space:nowrap}
    button:hover{background:var(--card)}
    button:focus-visible{outline:2px solid var(--purple);outline-offset:2px}
    button:disabled{opacity:.45;cursor:default}
    button.primary{background:var(--purple);border-color:var(--purple);color:var(--on-purple)}
    button.main{flex-shrink:0;margin-left:auto}
    button.collapse{min-height:26px;padding:0 9px 0 6px;gap:3px;font-size:12px;background:var(--card);color:var(--muted);flex-shrink:0}
    svg{width:16px;height:16px;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
    button.collapse svg{width:14px;height:14px}
    .dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;background:var(--ok)}
    .dot.purple{background:var(--purple)}.dot.warn{background:var(--warn)}
    .spinner{display:inline-block;width:14px;height:14px;flex-shrink:0;border:2px solid color-mix(in srgb,var(--purple) 25%,transparent);border-top-color:var(--purple);border-radius:50%;animation:spin .9s linear infinite}
    .mini{display:flex;align-items:center;gap:8px}
    .mini>span{display:flex;align-items:center;gap:6px;height:32px;padding:0 12px;border-radius:999px;background:var(--bg);border:1px solid var(--line);font-size:12px;font-weight:500;box-shadow:0 6px 20px #2a0f2b26}
    button.orb{position:relative;width:44px;height:44px;min-height:44px;padding:0;border-radius:50%;box-shadow:0 6px 20px #2a0f2b33}
    button.orb img{width:32px;height:32px;object-fit:contain}
    button.orb .dot{position:absolute;right:0;bottom:0;width:10px;height:10px;border:2px solid var(--bg);box-sizing:content-box}
    button.orb.active .dot{display:none}
    button.orb.active::after{content:"";position:absolute;inset:-4px;border:2px solid color-mix(in srgb,var(--purple) 25%,transparent);border-top-color:var(--purple);border-radius:50%;animation:spin 1.2s linear infinite;pointer-events:none}
    [hidden]{display:none!important}
    @keyframes spin{to{transform:rotate(360deg)}}
    @media (prefers-reduced-motion:reduce){.spinner,button.orb.active::after{animation:none}}
  `;
  const text = (key: string) => chrome.i18n.getMessage(key) || key;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = ''): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  // 固定的图标路径；用 DOM 建 SVG，不拼 HTML。
  const icon = (d: string) => {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', d);
    svg.append(path);
    return svg;
  };
  const HAND = 'M18 11V6a2 2 0 0 0-4 0M14 10V4a2 2 0 0 0-4 0v2m0 4.5V6a2 2 0 0 0-4 0v8m12-3a2 2 0 1 1 4 0v3a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L6 14';
  const crest = () => {
    const img = el('img');
    img.src = emblem;
    // 旁边就有平台名或按钮名，校徽只作装饰。
    img.alt = '';
    return img;
  };

  const bar = el('section', 'bar');
  bar.setAttribute('aria-label', text('controlBrand'));
  const state = el('div', 'state');
  state.setAttribute('role', 'status');
  const marker = el('i');
  const stateText = el('span');
  state.append(marker, stateText);
  // 收起：带文字的按钮，悬停与读屏都说明「助手继续操作」。
  const collapse = el('button', 'collapse');
  collapse.type = 'button';
  collapse.append(icon('m6 9 6 6 6-6'), text('controlCollapse'));
  collapse.title = text('controlCollapseLabel');
  collapse.setAttribute('aria-label', text('controlCollapseLabel'));
  const head = el('div', 'head');
  head.append(crest(), state, collapse);
  // 第二行：在做什么 · 对话标题（标题按纯文本显示）。
  const line = el('div', 'line');
  const action = el('span');
  const conversation = el('b');
  line.append(action, ' · ', conversation);
  const error = el('p', 'error');
  error.hidden = true;
  const help = el('p', 'help');
  help.textContent = text('controlHelp');
  const button = el('button', 'main');
  button.type = 'button';
  const buttonText = el('span');
  button.append(icon(HAND), buttonText);
  const grid = el('div', 'grid');
  grid.append(help, button);
  bar.append(head, line, error, grid);

  const mini = el('div', 'mini');
  const miniLabel = el('span');
  const miniDot = el('i', 'dot');
  const miniText = el('span');
  miniLabel.append(miniDot, miniText);
  const orb = el('button', 'orb');
  orb.type = 'button';
  orb.setAttribute('aria-label', text('controlExpand'));
  const orbDot = el('i', 'dot');
  orb.append(crest(), orbDot);
  mini.append(miniLabel, orb);
  root.append(style, bar, mini);

  let binding: PanelBinding | null = null;
  let view: ControlView = { mode: 'assistant', title: '', action: null, waiting: false };
  let busy = false;
  let collapsed = false;

  function render() {
    if (!binding) { host.remove(); return; }
    const phase = phaseOf(view);
    host.dataset.mode = view.mode;
    host.dataset.phase = phase;
    // 交接中、重新查看页面时不能收起：这两个过程要让用户看到结果。
    const transient = phase === 'handoff' || phase === 'recheck';
    const showMini = collapsed && !transient;
    bar.hidden = showMini;
    mini.hidden = !showMini;
    collapse.hidden = transient;

    const title = view.title.trim();
    conversation.textContent = title || text('controlUntitled');
    conversation.title = title || text('controlUntitled');

    // 进行中的动作才转圈；重新查看页面在等助手下一步时只显示状态，不假装在忙。
    const spinning = phase === 'handoff' || (phase === 'recheck' && view.action !== null);
    // 绿点只表示「你在操作」；等助手回来重新看页面用紫点（助手那一侧的事），不用绿色免得像是已经好了。
    marker.className = spinning ? 'spinner' : `dot${phase === 'waiting' ? ' warn' : phase === 'taken' ? '' : ' purple'}`;
    stateText.textContent = text({
      working: 'controlStateWorking', waiting: 'controlStateWaiting', handoff: 'controlStateTaking',
      taken: 'controlStateUser', recheck: 'controlStateObserve',
    }[phase]);
    action.textContent = phase === 'working'
      ? text(view.action ? `controlAction_${view.action}` : 'controlActionIdle')
      : text({ waiting: 'controlActionWaiting', handoff: 'controlActionTaking', taken: 'controlActionUser', recheck: 'controlActionObserve' }[phase]);

    grid.hidden = transient;
    buttonText.textContent = text(phase === 'taken' ? 'controlResume' : 'controlTakeOver');
    button.className = phase === 'taken' ? 'main primary' : 'main';
    button.disabled = busy;
    help.hidden = phase !== 'working' && phase !== 'waiting';

    miniText.textContent = text({
      working: 'controlMiniWorking', waiting: 'controlMiniWaiting', handoff: 'controlMiniTaking',
      taken: 'controlMiniUser', recheck: 'controlMiniObserve',
    }[phase]);
    orbDot.className = `dot${phase === 'working' ? ' purple' : phase === 'waiting' ? ' warn' : ''}`;
    miniDot.className = orbDot.className;
    orb.classList.toggle('active', phase === 'working');
    if (!host.isConnected) document.documentElement.append(host);
  }

  collapse.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    collapsed = true;
    render();
    orb.focus();
  });
  orb.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    collapsed = false;
    render();
    collapse.focus();
  });
  button.addEventListener('click', async (event) => {
    if (!event.isTrusted || !binding || busy) return;
    const expected = binding;
    const type = view.mode === 'user' ? 'panel:resume' : 'panel:takeover';
    busy = true;
    error.hidden = true;
    render();
    try {
      const reply = await chrome.runtime.sendMessage({ type, ...expected }) as PanelReply;
      if (binding?.epoch !== expected.epoch || binding.token !== expected.token) return;
      if (reply?.ok && reply.view) view = reply.view;
      else { error.textContent = text('controlUnavailable'); error.hidden = false; }
    } catch {
      error.textContent = text('controlUnavailable'); error.hidden = false;
    } finally {
      busy = false;
      render();
    }
  });

  chrome.runtime.onMessage.addListener((raw: unknown, sender) => {
    if (sender.id !== chrome.runtime.id || !raw || typeof raw !== 'object') return;
    const message = raw as PanelRender | (PanelBinding & { type: 'panel:remove' });
    if (message.type === 'panel:remove') {
      if (binding?.epoch === message.epoch && binding.token === message.token) {
        binding = null;
        host.remove();
      }
      return;
    }
    if (message.type !== 'panel:render') return;
    binding = { epoch: message.epoch, token: message.token };
    view = message.view;
    if (message.expand) collapsed = false;
    render();
  });
})();
