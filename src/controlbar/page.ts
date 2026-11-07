// 在已授予来源权限的归属页顶层运行；不使用 CDP，不在网页里做授权确认。
import type { PanelBinding, PanelRender, PanelReply } from './protocol';
import type { ControlView } from '../browser/control';

(() => {
  const world = globalThis as typeof globalThis & { __browserControlBar?: boolean };
  if (world.__browserControlBar) return;
  world.__browserControlBar = true;
  const host = document.createElement('div');
  host.id = 'browser-assistant-controls';
  // 关闭的 shadow root 减少网页脚本和页面快照对控件的干扰，授权边界仍由后台校验。
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host{all:initial;position:fixed!important;right:16px!important;bottom:16px!important;z-index:2147483647!important;display:block!important;width:min(280px,calc(100vw - 32px))!important;color-scheme:light dark!important}
    *{box-sizing:border-box}section{background:light-dark(#fff,#202124);color:light-dark(#202124,#f3f4f5);border:1px solid light-dark(#d4d7dc,#61646c);border-radius:12px;box-shadow:0 4px 20px #0003;padding:12px;font:13px/1.45 system-ui,sans-serif}
    header{display:flex;align-items:center;justify-content:space-between;gap:8px;font-weight:600}h2,p{font:inherit;margin:0}p{margin-top:8px;overflow-wrap:anywhere}button{font:inherit;color:inherit;cursor:pointer;border:1px solid light-dark(#b8bdc6,#767b85);border-radius:6px;background:transparent;padding:6px 10px}button:focus-visible{outline:2px solid #7a88e8;outline-offset:2px}button:disabled{opacity:.6;cursor:wait}#action{display:block;width:100%;margin-top:10px;min-height:36px;font-weight:600}#collapse{border:0;padding:0 6px;font-size:18px}#task:empty{display:none}[hidden]{display:none!important}#error{color:light-dark(#a0242d,#ffb2b8)}
  `;
  const section = document.createElement('section');
  const header = document.createElement('header');
  const heading = document.createElement('h2');
  const collapse = document.createElement('button');
  collapse.id = 'collapse';
  const details = document.createElement('div');
  const task = document.createElement('p'); task.id = 'task';
  const status = document.createElement('p'); status.setAttribute('role', 'status');
  const error = document.createElement('p'); error.id = 'error'; error.hidden = true;
  const action = document.createElement('button'); action.id = 'action';
  header.append(heading, collapse);
  details.append(task, status, error, action);
  section.append(header, details);
  root.append(style, section);
  const text = (key: string) => chrome.i18n.getMessage(key) || key;
  heading.textContent = text('controlBarTitle');
  let binding: PanelBinding | null = null;
  let view: ControlView = { mode: 'assistant', title: '', action: null };
  let busy = false;
  let collapsed = false;

  function render() {
    if (!binding) { host.remove(); return; }
    host.dataset.mode = view.mode;
    details.hidden = collapsed;
    collapse.textContent = collapsed ? '+' : '−';
    collapse.setAttribute('aria-label', text(collapsed ? 'controlExpand' : 'controlCollapse'));
    collapse.setAttribute('aria-expanded', String(!collapsed));
    task.textContent = [view.title, view.action].filter(Boolean).join(' · ');
    status.textContent = text(view.mode === 'user' ? 'controlUser' : view.mode === 'taking_over' ? 'controlTaking'
      : view.mode === 'observing' ? 'controlObserve' : view.action ? 'controlWorking' : 'controlIdle');
    action.textContent = text(view.mode === 'user' ? 'controlResume' : 'controlTakeOver');
    action.disabled = busy;
    if (!host.isConnected) document.documentElement.append(host);
  }

  collapse.addEventListener('click', (event) => {
    if (!event.isTrusted) return;
    collapsed = !collapsed;
    render();
  });
  action.addEventListener('click', async (event) => {
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
