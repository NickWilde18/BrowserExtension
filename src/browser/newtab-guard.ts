// 新开标签的把关（计划 4.5「跨站跳转」）：AI 的动作期间，会新开标签的导航留在本标签（AI 的标签）里。
//
// 为什么不接管新标签：AI 标签打开的弹出标签，调试接口在它发出请求之前接不到（实测：标签页级的
// Target.setAutoAttach 收不到 popup），而计划的权限里没有 webNavigation / declarativeNetRequest。新标签一旦
// 打开，请求已经带着用户的登录态发往目标站点，同标签里拦得住的跨站跳转在新标签里拦不住。
//
// 所以在页面主世界里装一个守卫（Page.addScriptToEvaluateOnNewDocument：每个框架的每个新文档，先于页面脚本），
// 只在 AI 动作期间生效（setActing 打开），把这几种情况改成本标签的顶层导航，走同一套请求阶段的跨站拦截：
// - target 不是 _self / _top / _parent 的链接、带 Ctrl / Meta / Shift 或中键的链接点击；
// - target 是新窗口的表单提交（含提交按钮的 formtarget）；
// - window.open(http(s) 地址)。
// 用户自己在 AI 标签里点的不受影响（动作之外守卫不生效）。
//
// 守卫跑在页面主世界里，页面自己的脚本能绕过它（比如从新建的 iframe 里拿原生的 window.open）。页面脚本本来就能
// 直接 fetch 外站，不在这条防线的范围内（计划第 10 节）；万一还是冒出了新标签，后台的兜底会立即关掉它
// （background.ts 的 tabs.onCreated）。

/** 守卫读的开关（主世界的全局符号；页面也看得到，只是一个布尔值）。 */
export const ACTING_KEY = 'agent.acting';

/** 装进页面主世界的守卫源码。 */
export const NEWTAB_GUARD_SOURCE = `(() => {
  const KEY = Symbol.for(${JSON.stringify(ACTING_KEY)});
  if (globalThis[Symbol.for('agent.newtabGuard')]) { return; }
  globalThis[Symbol.for('agent.newtabGuard')] = true;
  const acting = () => globalThis[KEY] === true;
  const opensElsewhere = (t) => { const v = String(t || '').trim().toLowerCase(); return v !== '' && v !== '_self' && v !== '_top' && v !== '_parent'; };
  const goTop = (href) => { try { window.top.location.href = href; } catch (e) { location.href = href; } };

  const onClick = (e) => {
    if (!acting()) { return; }
    const a = e.composedPath().find((n) => n instanceof Element && (n.localName === 'a' || n.localName === 'area') && n.hasAttribute('href'));
    if (!a || a.hasAttribute('download')) { return; }
    const modified = e.ctrlKey || e.metaKey || e.shiftKey || e.button === 1;
    if (modified) {
      e.preventDefault();
      goTop(a.href);
      return;
    }
    if (opensElsewhere(a.target)) {
      const old = a.getAttribute('target');
      a.setAttribute('target', '_top');
      setTimeout(() => { if (old === null) { a.removeAttribute('target'); } else { a.setAttribute('target', old); } }, 0);
    }
  };
  window.addEventListener('click', onClick, true);
  window.addEventListener('auxclick', onClick, true);

  window.addEventListener('submit', (e) => {
    if (!acting()) { return; }
    const form = e.target;
    const submitter = e.submitter;
    if (submitter && opensElsewhere(submitter.getAttribute('formtarget'))) {
      const old = submitter.getAttribute('formtarget');
      submitter.setAttribute('formtarget', '_top');
      setTimeout(() => submitter.setAttribute('formtarget', old), 0);
    }
    if (form instanceof HTMLFormElement && opensElsewhere(form.getAttribute('target'))) {
      const old = form.getAttribute('target');
      form.setAttribute('target', '_top');
      setTimeout(() => form.setAttribute('target', old), 0);
    }
  }, true);

  const nativeOpen = window.open;
  const guardedOpen = function (url, target, features) {
    if (acting() && url !== undefined && url !== null && String(url) !== '') {
      try {
        const u = new URL(String(url), location.href);
        if (u.protocol === 'http:' || u.protocol === 'https:') { goTop(u.href); return null; }
      } catch (e) { /* 网址不合法：交给原生的 window.open 处理 */ }
    }
    return nativeOpen.apply(this, arguments);
  };
  Object.defineProperty(window, 'open', { value: guardedOpen, writable: true, configurable: true });
})()`;

/** 在一个执行上下文里打开 / 关上守卫的表达式。 */
export function actingExpression(on: boolean): string {
  return `void (globalThis[Symbol.for(${JSON.stringify(ACTING_KEY)})] = ${on ? 'true' : 'false'})`;
}
