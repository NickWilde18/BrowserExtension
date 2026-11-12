// 在已授予来源权限的归属页顶层运行；不使用 CDP，不在网页里做授权确认（等确认时只引导去独立确认窗）。
//
// 界面按设计状态集 07 的「网页控制条」：右下角距边 16px；展开时校徽 + 平台名、对话标题、状态、说明和一个按钮；
// 收起成 39px 校徽圆钮，配状态色点和文字标签（不只靠颜色）。不显示网址、账号、用户的问题或输入内容。
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
      --bg:#fff;--soft:#f8f7f9;--fg:#252327;--muted:#625c68;--line:#ddd8e2;--purple:#751276;--on-purple:#fff;--warn:#80570d;--ok:#316347;--danger:#963b40;color-scheme:light}
    @media (prefers-color-scheme:dark){:host{--bg:#232126;--soft:#2b282f;--fg:#eeebf0;--muted:#b9b1bf;--line:#46404c;--purple:#dda2df;--on-purple:#28172d;--warn:#edc477;--ok:#a5d4b5;--danger:#efb1b5;color-scheme:dark}}
    *{box-sizing:border-box}
    .bar,.mini{font:13px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:var(--fg)}
    .bar{width:min(370px,calc(100vw - 32px));background:var(--bg);border:1px solid var(--line);border-top:3px solid var(--purple);border-radius:5px;padding:12px 13px;box-shadow:0 3px 12px #0000001f}
    .row{display:flex;align-items:center;justify-content:space-between;gap:10px}
    .brand{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--purple)}
    .brand img{width:26px;height:26px;object-fit:contain}
    .conversation{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin:3px 0 8px}
    .state{font-size:13px;font-weight:550;display:flex;align-items:flex-start;gap:7px}
    .action{font-size:12px;color:var(--muted);margin:5px 0 12px;line-height:1.7;overflow-wrap:anywhere}
    .help{font-size:11px;line-height:1.7;color:var(--muted);margin:7px 0 0}
    .error{font-size:12px;color:var(--danger);margin:0 0 8px}
    button{font:inherit;cursor:pointer;border:1px solid var(--line);border-radius:4px;background:var(--bg);color:var(--fg);padding:7px 11px;line-height:1.4;font-size:13px}
    button:hover{background:var(--soft)}
    button:focus-visible{outline:2px solid var(--purple);outline-offset:3px}
    button:disabled{opacity:.5;cursor:default}
    button.wide{display:block;width:100%;min-height:39px}
    button.primary{background:var(--purple);border-color:var(--purple);color:var(--on-purple)}
    button.quiet{padding:3px 7px;color:var(--muted);font-size:12px}
    .dot{display:inline-block;width:7px;height:7px;border-radius:50%;flex-shrink:0;margin-top:7px;background:var(--ok)}
    .dot.purple{background:var(--purple)}.dot.warn{background:var(--warn)}
    .spinner{display:inline-block;width:13px;height:13px;flex-shrink:0;border:1.5px solid var(--line);border-top-color:var(--purple);border-radius:50%;margin-top:4px;animation:spin .9s linear infinite}
    .mini{display:flex;align-items:center;gap:7px}
    .mini>span{font-size:11px;color:var(--muted);background:var(--bg);padding:2px 7px;border-radius:3px;border:1px solid var(--line)}
    button.orb{position:relative;width:39px;height:39px;padding:0;border:2px solid var(--purple);border-radius:50%;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 8px #0000001f}
    button.orb img{width:28px;height:28px;object-fit:contain}
    button.orb .dot{position:absolute;right:0;bottom:0;margin:0;width:9px;height:9px;border:2px solid var(--bg);box-sizing:content-box}
    button.orb.active::after{content:"";position:absolute;inset:-5px;border:1px solid var(--purple);border-radius:50%;animation:pulse 1.7s ease-out infinite;pointer-events:none}
    [hidden]{display:none!important}
    @keyframes spin{to{transform:rotate(360deg)}}
    @keyframes pulse{0%{opacity:.6;transform:scale(.85)}100%{opacity:0;transform:scale(1.18)}}
    @media (prefers-reduced-motion:reduce){.spinner,button.orb.active::after{animation:none}}
  `;
  const text = (key: string) => chrome.i18n.getMessage(key) || key;
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = ''): HTMLElementTagNameMap[K] => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    return node;
  };
  const crest = () => {
    const img = el('img');
    img.src = emblem;
    // 旁边就有平台名或按钮名，校徽只作装饰。
    img.alt = '';
    return img;
  };

  const bar = el('section', 'bar');
  bar.setAttribute('aria-label', text('controlBrand'));
  const brand = el('span', 'brand');
  brand.append(crest(), text('controlBrand'));
  const collapse = el('button', 'quiet');
  collapse.type = 'button';
  collapse.textContent = text('controlCollapse');
  collapse.setAttribute('aria-label', text('controlCollapseLabel'));
  const top = el('div', 'row');
  top.append(brand, collapse);
  const conversation = el('div', 'conversation');
  const state = el('div', 'state');
  state.setAttribute('role', 'status');
  const marker = el('i');
  const stateText = el('span');
  state.append(marker, stateText);
  const action = el('div', 'action');
  const error = el('p', 'error');
  error.hidden = true;
  const button = el('button', 'wide');
  button.type = 'button';
  const help = el('p', 'help');
  help.textContent = text('controlHelp');
  bar.append(top, conversation, state, action, error, button, help);

  const mini = el('div', 'mini');
  const miniLabel = el('span');
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

    button.hidden = transient;
    button.textContent = text(phase === 'taken' ? 'controlResume' : 'controlTakeOver');
    button.className = phase === 'taken' ? 'wide primary' : 'wide';
    button.disabled = busy;
    help.hidden = phase !== 'working' && phase !== 'waiting';

    miniLabel.textContent = text({
      working: 'controlMiniWorking', waiting: 'controlMiniWaiting', handoff: 'controlMiniTaking',
      taken: 'controlMiniUser', recheck: 'controlMiniObserve',
    }[phase]);
    orbDot.className = `dot${phase === 'working' ? ' purple' : phase === 'waiting' ? ' warn' : ''}`;
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
