// 平台会话 Cookie 变了就断开重连（计划第 9 节第 17 条，BX-COOKIE=A）：只看是不是平台站点的 HttpOnly Cookie，不读值。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { COOKIE_CHANGE_DEBOUNCE_MS, watchSessionCookie } from '../../src/connection/cookie-watch';
import type { CookieChangeInfo } from '../../src/connection/cookie-watch';

const HOST = 'chat.example.edu';

/** 一条事件；cookie 包一层 Proxy，记下被读过哪些字段（钉住「不读值」）。 */
function change(domain: string, httpOnly: boolean, removed: boolean, touched: Set<string>): CookieChangeInfo {
  const cookie = { domain, httpOnly, name: 'sid', value: 'session-secret', path: '/', secure: true };
  const watched = new Proxy(cookie, {
    get(target, prop, receiver) {
      touched.add(String(prop));
      return Reflect.get(target, prop, receiver);
    },
  });
  return { cookie: watched, removed } as unknown as CookieChangeInfo;
}

function setup() {
  let listener: ((info: CookieChangeInfo) => void) | null = null;
  const onSessionCookieChanged = vi.fn();
  watchSessionCookie({
    platformHost: HOST,
    addListener: (fn) => {
      listener = fn;
    },
    onSessionCookieChanged,
  });
  const fire = (info: CookieChangeInfo) => listener?.(info);
  return { fire, onSessionCookieChanged };
}

describe('watchSessionCookie', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('平台站点的 HttpOnly Cookie 设了或删了：合并成一次重连；重新登录连来的删、设两条也只重连一次', async () => {
    const { fire, onSessionCookieChanged } = setup();
    const touched = new Set<string>();

    fire(change(HOST, true, false, touched));
    expect(onSessionCookieChanged).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(COOKIE_CHANGE_DEBOUNCE_MS);
    expect(onSessionCookieChanged).toHaveBeenCalledTimes(1);

    fire(change(HOST, true, true, touched));
    fire(change(HOST, true, false, touched));
    await vi.advanceTimersByTimeAsync(COOKIE_CHANGE_DEBOUNCE_MS);
    expect(onSessionCookieChanged).toHaveBeenCalledTimes(2);

    // 退出登录：只有一条删。Domain 写成平台主机本身时，域带一个前导点。
    fire(change('.' + HOST, true, true, touched));
    await vi.advanceTimersByTimeAsync(COOKIE_CHANGE_DEBOUNCE_MS);
    expect(onSessionCookieChanged).toHaveBeenCalledTimes(3);
  });

  it('不带 HttpOnly 的（页面脚本写的）、别的主机的、上级域的：都不重连', async () => {
    const { fire, onSessionCookieChanged } = setup();
    const touched = new Set<string>();

    fire(change(HOST, false, false, touched));
    fire(change('other.example.edu', true, false, touched));
    fire(change('example.edu', true, false, touched));
    fire(change('.example.edu', true, true, touched));
    fire(change('evil-' + HOST, true, false, touched));
    await vi.advanceTimersByTimeAsync(COOKIE_CHANGE_DEBOUNCE_MS * 4);
    expect(onSessionCookieChanged).not.toHaveBeenCalled();
  });

  it('换服务器后按新主机过滤，并丢弃旧主机排队中的 Cookie 回调', async () => {
    let host = HOST;
    let fire!: (info: CookieChangeInfo) => void;
    const reconnect = vi.fn();
    watchSessionCookie({ platformHost: () => host, addListener: (fn) => { fire = fn; }, onSessionCookieChanged: reconnect });
    const touched = new Set<string>();
    fire(change(HOST, true, false, touched));
    host = 'new.example.edu';
    await vi.advanceTimersByTimeAsync(COOKIE_CHANGE_DEBOUNCE_MS);
    expect(reconnect).not.toHaveBeenCalled();
    fire(change(HOST, true, false, touched));
    fire(change(host, true, false, touched));
    await vi.advanceTimersByTimeAsync(COOKIE_CHANGE_DEBOUNCE_MS);
    expect(reconnect).toHaveBeenCalledTimes(1);
    expect([...touched].sort()).toEqual(['domain', 'httpOnly']);
  });

  it('不读 Cookie 的值：事件里只碰域和 HttpOnly 两个字段', async () => {
    const { fire } = setup();
    const touched = new Set<string>();

    fire(change(HOST, true, false, touched));
    fire(change('other.example.edu', true, false, touched));
    fire(change(HOST, false, false, touched));
    await vi.advanceTimersByTimeAsync(COOKIE_CHANGE_DEBOUNCE_MS);

    expect([...touched].sort()).toEqual(['domain', 'httpOnly']);
  });
});
