// 安装 id 与显示名（契约 3.1、计划 4.2「安装 id 与多浏览器」）。
//
// 安装 id：首次运行时生成的随机 UUID，存在 storage.local，卸载重装会变。每装一份插件 = 一个浏览器
// （同一台电脑的 Chrome 和 Edge、多个用户资料、多台电脑各算一个）。
// 显示名：默认按浏览器与系统生成（如「Chrome · Linux」），用户可在弹窗里改；用于在对话里选用哪台。

import { PROTOCOL_VERSION } from './config';
import { isUUID } from './protocol/frames';
import type { ActionName, HelloFrame } from './protocol/frames';
import type { KV } from './storage';

const INSTALL_ID_KEY = 'identity.installId';
const DISPLAY_NAME_KEY = 'identity.displayName';

export const MAX_DISPLAY_NAME = 64;

/** 规整显示名：去掉控制字符与首尾空白，限 64 个字符；规整后为空返回 null。 */
export function normalizeDisplayName(raw: string): string | null {
  // 控制字符、零宽字符、双向文本控制符、BOM：显示名会出现在对话页的选择卡上，这些字符能伪装成别的名字。
  const cleaned = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, '').trim();
  if (cleaned === '') {
    return null;
  }

  return [...cleaned].slice(0, MAX_DISPLAY_NAME).join('');
}

/** 默认显示名：「浏览器 · 系统」。认不出时用「Browser」。 */
export function defaultDisplayName(userAgent: string, brands: readonly string[], os: string): string {
  let browser = 'Browser';
  if (brands.some((b) => /edge/i.test(b)) || /\bEdg\//.test(userAgent)) {
    browser = 'Edge';
  } else if (brands.some((b) => /chrome/i.test(b)) || /\bChrome\//.test(userAgent)) {
    browser = 'Chrome';
  } else if (brands.some((b) => /chromium/i.test(b))) {
    browser = 'Chromium';
  }

  const osName: Record<string, string> = {
    win: 'Windows',
    mac: 'macOS',
    linux: 'Linux',
    cros: 'ChromeOS',
    android: 'Android',
    openbsd: 'OpenBSD',
    fuchsia: 'Fuchsia',
  };

  return `${browser} · ${osName[os] ?? os}`;
}

export class Identity {
  constructor(private readonly local: KV) {}

  async installId(): Promise<string> {
    // 只用规范形态（小写带连字符）的 UUID：不是的 Chat 对 frames / uploads / files 回 400；存储里的值坏了
    // 就换一个新的（等于重装一次，Chat 那边按新的一台浏览器认）。
    const existing = await this.local.get<unknown>(INSTALL_ID_KEY);
    if (isUUID(existing)) {
      return existing;
    }

    const id = crypto.randomUUID();
    await this.local.set(INSTALL_ID_KEY, id);
    return id;
  }

  async displayName(): Promise<string> {
    const saved = await this.local.get<string>(DISPLAY_NAME_KEY);
    if (saved) {
      return saved;
    }

    const platform = await chrome.runtime.getPlatformInfo();
    const uaData = (navigator as Navigator & { userAgentData?: { brands?: Array<{ brand: string }> } }).userAgentData;
    const brands = uaData?.brands?.map((b) => b.brand) ?? [];

    return defaultDisplayName(navigator.userAgent, brands, platform.os);
  }

  /** 改显示名；不合法时返回 false。下次连接的 hello 生效（弹窗会触发重连）。 */
  async setDisplayName(raw: string): Promise<boolean> {
    const name = normalizeDisplayName(raw);
    if (name === null) {
      return false;
    }

    await this.local.set(DISPLAY_NAME_KEY, name);
    return true;
  }

  async hello(actions?: readonly ActionName[]): Promise<HelloFrame> {
    return {
      type: 'hello',
      protocol: PROTOCOL_VERSION,
      install_id: await this.installId(),
      display_name: (normalizeDisplayName(await this.displayName()) ?? 'Browser'),
      extension_version: chrome.runtime.getManifest().version.slice(0, 32),
      ...(actions !== undefined ? { capabilities: { actions: [...actions] } } : {}),
    };
  }
}
