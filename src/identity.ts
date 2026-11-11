// 安装 id 与显示名（契约 3.1、计划 4.2「安装 id 与多浏览器」）。
//
// 安装密钥与安装 id：首次运行时用 WebCrypto 生成 ECDSA P-256 密钥对（私钥不可导出），CryptoKeyPair 对象本身
// 存进插件的 IndexedDB；安装 id 由公钥算出（UUIDv8，见 deriveInstallId），换凭据时用私钥签名证明持有这份安装，
// 别人知道 install_id 也拿不出能算出它的公钥对应的私钥。卸载重装会变。每装一份插件 = 一个浏览器
// （同一台电脑的 Chrome 和 Edge、多个用户资料、多台电脑各算一个）。
// 当前使用的 install_id 存在 storage.local 的 identity.installId。启动时不拿密钥核对（587-KEYLOSS=A）：密钥丢了
// 或和缓存对不上，照旧用缓存的 id 和凭据；只在换凭据时发现私钥不可用，才重新生成密钥和 id（等于重装一次）。
// 显示名：默认按浏览器与系统生成（如「Chrome · Linux」），用户可在弹窗里改；用于在对话里选用哪台。

import { PROTOCOL_VERSION } from './config';
import { isUUID } from './protocol/frames';
import type { ActionName, HelloFrame } from './protocol/frames';
import type { KV } from './storage';

const INSTALL_ID_KEY = 'identity.installId';
const DISPLAY_NAME_KEY = 'identity.displayName';
const KEY_DB = 'identity';
const KEY_STORE = 'keys';
const KEY_RECORD = 'install';
/** 签名内容的第一行（域分隔与版本号），与 Chat 侧校验一致，见 installProofMessage。 */
export const INSTALL_PROOF_DOMAIN = 'chat-browser-install-proof/v1';
const ECDSA_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;

/** base64url，无填充。 */
export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * 由 raw 公钥（未压缩点，65 字节）推导安装 id：SHA-256 的前 16 字节，第 6 字节高 4 位置 8（UUIDv8），
 * 第 8 字节高 2 位置 10（RFC 9562 变体），排成小写带连字符的 36 字符。
 */
export async function deriveInstallId(rawPublicKey: Uint8Array<ArrayBuffer>): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', rawPublicKey)).slice(0, 16);
  h[6] = (h[6]! & 0x0f) | 0x80;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const hex = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 换凭据签名的内容：三行用 \n 连接，末尾不加换行，UTF-8。 */
export function installProofMessage(installId: string, code: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(`${INSTALL_PROOF_DOMAIN}\n${installId}\n${code}`);
}

/** 安装密钥对的存取。生产用 IndexedDB（indexedDBKeyStore），单测换成内存实现。 */
export interface KeyStore {
  get(): Promise<CryptoKeyPair | undefined>;
  put(pair: CryptoKeyPair): Promise<void>;
}

/** CryptoKeyPair 原样（structured clone）存进插件的 IndexedDB；不可导出的私钥只能这样跨重启保留。 */
export function indexedDBKeyStore(): KeyStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(KEY_DB, 1);
    req.onupgradeneeded = () => { req.result.createObjectStore(KEY_STORE); };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  const run = async <T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction(KEY_STORE, mode);
        const req = op(tx.objectStore(KEY_STORE));
        tx.oncomplete = () => resolve(req.result as T);
        tx.onerror = () => reject(tx.error ?? req.error);
        tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
      });
    } finally {
      db.close();
    }
  };
  return {
    get: () => run<CryptoKeyPair | undefined>('readonly', (s) => s.get(KEY_RECORD)),
    put: async (pair) => { await run('readwrite', (s) => s.put(pair, KEY_RECORD)); },
  };
}

/** 内存实现，给单测用。 */
export class MemoryKeyStore implements KeyStore {
  pair: CryptoKeyPair | undefined;
  async get(): Promise<CryptoKeyPair | undefined> { return this.pair; }
  async put(pair: CryptoKeyPair): Promise<void> { this.pair = pair; }
}

interface InstallKey { pair: CryptoKeyPair; installKey: string; installId: string }

/** 取回的密钥对是否可用：ECDSA P-256 私钥能签名、公钥能导出 65 字节未压缩点。不可用时返回 null。 */
async function usable(pair: unknown): Promise<{ pair: CryptoKeyPair; raw: Uint8Array<ArrayBuffer> } | null> {
  if (!pair || typeof pair !== 'object') return null;
  const { privateKey, publicKey } = pair as Partial<CryptoKeyPair>;
  if (!(privateKey instanceof CryptoKey) || !(publicKey instanceof CryptoKey)) return null;
  const alg = privateKey.algorithm as EcKeyAlgorithm;
  if (privateKey.type !== 'private' || publicKey.type !== 'public' || alg.name !== 'ECDSA' || alg.namedCurve !== 'P-256'
    || !privateKey.usages.includes('sign')) return null;
  try {
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', publicKey));
    return raw.length === 65 && raw[0] === 4 ? { pair: { privateKey, publicKey }, raw } : null;
  } catch {
    return null;
  }
}

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
  private loading: Promise<InstallKey> | null = null;

  constructor(private readonly local: KV, private readonly keys: KeyStore = indexedDBKeyStore()) {}

  /**
   * 当前使用的安装 id（hello、凭据比对、退出、各通道都用它）：storage.local 里缓存的规范 UUID。
   * 启动时不拿密钥核对（587-KEYLOSS=A）：密钥丢了或和缓存对不上，照旧用缓存的 id 和凭据，到下一次换凭据才换。
   * 没有缓存（首次运行）或缓存不是规范形态时，取安装密钥（没有就生成）算出 id 并缓存。
   */
  async installId(): Promise<string> {
    const cached = await this.local.get<unknown>(INSTALL_ID_KEY);
    if (isUUID(cached)) return cached;
    const id = (await this.key()).installId;
    await this.local.set(INSTALL_ID_KEY, id);
    return id;
  }

  /**
   * 换凭据要用的安装 id：由当前可用的安装密钥算出；私钥不可用（丢了、坏了）就重新生成密钥，等于重装一次。
   * 可能和 installId() 的缓存不同（例如旧版本的随机 UUID、密钥被清掉）；换凭据成功后由 adopt() 改写缓存。
   */
  async exchangeId(): Promise<string> {
    return (await this.key()).installId;
  }

  /** 换凭据成功：从此以这个 id 为准（hello、凭据比对都换成它）。 */
  async adopt(installId: string): Promise<void> {
    await this.local.set(INSTALL_ID_KEY, installId);
  }

  /**
   * 换凭据用的持有证明：install_key 是 raw 公钥、install_proof 是对 installProofMessage 的 ECDSA/SHA-256 签名
   * （WebCrypto 输出 IEEE P1363，r‖s 共 64 字节），都是无填充 base64url。
   */
  async prove(code: string): Promise<{ install_id: string; install_key: string; install_proof: string }> {
    const key = await this.key();
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.pair.privateKey,
      installProofMessage(key.installId, code)));
    return { install_id: key.installId, install_key: key.installKey, install_proof: base64url(signature) };
  }

  /** 同一运行期只取一次；并发调用共用一次加载，避免同时生成两把密钥。失败不缓存，下次重试。 */
  private key(): Promise<InstallKey> {
    if (!this.loading) {
      const task = this.load();
      this.loading = task;
      task.catch(() => { if (this.loading === task) this.loading = null; });
    }
    return this.loading;
  }

  private async load(): Promise<InstallKey> {
    let found = await usable(await this.keys.get());
    if (!found) {
      // 首次运行，或换凭据时发现密钥丢了/坏了：重新生成，等于重装一次（Chat 按新的一台浏览器认）。
      const generated = await crypto.subtle.generateKey(ECDSA_P256, false, ['sign']);
      await this.keys.put(generated);
      found = await usable(generated);
      if (!found) throw new Error('generated install key is unusable');
    }
    return { pair: found.pair, installKey: base64url(found.raw), installId: await deriveInstallId(found.raw) };
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
