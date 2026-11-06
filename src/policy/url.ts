// 网址规则：AI 能开哪些网址、哪些页面附着不上、站点（来源）怎么算。见计划 4.4「browser_open 能开哪些网址」。

import { ActionError } from '../protocol/errors';

/**
 * 校验 open / tabs new 给的网址，返回规整后的网址。
 *
 * 能开：任意 http(s)（含校内系统、内网 IP、localhost），以及 about:blank。
 * 不开：javascript:（等于执行任意脚本）、data:（凭空造页面）、file://（暴露本机磁盘）、
 * 浏览器与插件的内部页面；带账号密码的网址（user:pass@host）也不开，免得把凭据写进地址。
 */
export function checkOpenableUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === 'about:blank') {
    return trimmed;
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ActionError('invalid_args', 'url must be a full http(s) address, like https://example.com/.');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ActionError('site_not_allowed', 'Only http(s) pages and about:blank can be opened.');
  }

  if (url.username !== '' || url.password !== '') {
    throw new ActionError('site_not_allowed', 'Addresses with a user name or password in them cannot be opened.');
  }

  return url.href;
}

/** 站点（来源）：`https://host[:port]`。不是 http(s) 的网址返回 null（about:blank 等，不需要站点授权）。 */
export function siteOf(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

/**
 * 调试接口附着不上的页面：浏览器与插件的内部页面（Chromium `ExtensionMayAttachToURL`）。
 * 应用商店页面也附着不上，但它是普通 https 网址，靠附着失败识别（attach_failed → unsupported_page）。
 */
export function isUnattachableUrl(raw: string): boolean {
  if (raw === '' || raw === 'about:blank') {
    return false;
  }

  const lower = raw.toLowerCase();
  return ['chrome:', 'edge:', 'chrome-extension:', 'extension:', 'devtools:', 'chrome-search:', 'chrome-untrusted:',
    'view-source:', 'about:'].some((p) => lower.startsWith(p));
}
