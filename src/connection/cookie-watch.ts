// 平台会话 Cookie 变了就断开下行连接、立刻重连（计划第 9 节第 17 条，已定 BX-COOKIE=A）。
//
// 网关只在请求开始时校验会话，已经开着的下行长连接不会因为退出登录、换人登录被断开。同一台浏览器上这两件事都会改平台
// 的会话 Cookie（网关清掉它、或下发一个新的），插件收到 chrome.cookies.onChanged 就主动断开重连，网关按此刻的会话重新
// 校验：退出了就是 401（插件提示先在网页上登录）；换了人 ready.account 就变（插件清掉上一个账号的状态，见 account.ts）。
// 在别的设备上吊销不改这台浏览器的 Cookie，仍靠 Chat 的 5 分钟轮换（契约 2.2）。
//
// 边界（计划 4.6）：只看事件里的两个字段——Cookie 是不是 HttpOnly、域是不是平台主机；**不读、不存、不发 Cookie 的值**，
// 也不调任何读写 Cookie 的接口。别的站点的事件插件收不到：Chrome 按主机权限过滤，插件只有平台地址的主机权限（计划 7.1
// 第 7 项实测）。不带 HttpOnly 的 Cookie 是页面脚本写的（语言偏好之类），网关的会话 Cookie 一定带 HttpOnly，所以不管。
//
// 一次重新登录会连着来两条事件（删旧的、设新的），合并成一次重连。

/** onChanged 事件里用得到的部分（chrome.cookies.CookieChangeInfo 的子集）。 */
export interface CookieChangeInfo {
  readonly cookie: { readonly domain: string; readonly httpOnly: boolean };
}

export interface CookieWatchDeps {
  /** 平台对外地址的主机名。 */
  platformHost: string | (() => string);
  /** 注册 chrome.cookies.onChanged 的监听；要在后台脚本的顶层调，休眠的后台才会被这个事件唤醒。 */
  addListener(listener: (info: CookieChangeInfo) => void): void;
  /** 平台的会话 Cookie 变了。 */
  onSessionCookieChanged(): void;
}

/** 合并连着到来的事件的等待时间。 */
export const COOKIE_CHANGE_DEBOUNCE_MS = 500;

export function watchSessionCookie(deps: CookieWatchDeps): void {
  const currentHost = () => (typeof deps.platformHost === 'function' ? deps.platformHost() : deps.platformHost).toLowerCase();
  let pending: ReturnType<typeof setTimeout> | null = null;

  deps.addListener((info) => {
    const host = currentHost();
    if (!info.cookie.httpOnly || !isPlatformHost(info.cookie.domain, host)) {
      return;
    }

    if (pending !== null) {
      clearTimeout(pending);
    }

    pending = setTimeout(() => {
      pending = null;
      if (currentHost() === host) deps.onSessionCookieChanged();
    }, COOKIE_CHANGE_DEBOUNCE_MS);
  });
}

/**
 * Cookie 的域是不是平台主机：只设在主机上的 Cookie 域就是主机名，Domain 写成主机本身时前面多一个点。上级域的 Cookie
 * （`.example.edu`）不算：那是同一上级域下别的站点也能写的，Chrome 也不会把它的事件交给只有平台主机权限的插件。
 */
function isPlatformHost(domain: string, host: string): boolean {
  return domain.replace(/^\./, '').toLowerCase() === host;
}
