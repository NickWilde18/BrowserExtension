import type { Identity } from '../identity';
import type { KV } from '../storage';

const CREDENTIAL_KEY = 'connection.credential';
const CALLBACK_PATH = '/chat/browser-extension/callback';
/** 授权页打开后最长等待；用户离开授权页又不关标签时，到点放弃并关掉它。 */
const LOGIN_TIMEOUT_MS = 10 * 60_000;
type Result = { ok: boolean };
interface StoredCredential { origin: string; installId: string; credential: string; account: string }
interface Options {
  origin: string;
  local: KV;
  identity: Identity;
  onAuthenticated(): void;
  onInvalidated(): Promise<void>;
}

function randomValue(): string {
  return base64url(crypto.getRandomValues(new Uint8Array(32)));
}
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 每个运行期只有一次进行中的授权；凭据只属于签发它的平台和安装。 */
export class BrowserAuthentication {
  private pending: Promise<Result> | null = null;
  private invalidating: Promise<void> = Promise.resolve();
  private controller: AbortController | null = null;
  private disposed = false;
  private generation = 0;

  constructor(private readonly options: Options) {}
  get signingIn(): boolean { return this.pending !== null; }

  async credential(): Promise<string | undefined> {
    if (this.disposed) return undefined;
    const stored = await this.options.local.get<StoredCredential>(CREDENTIAL_KEY);
    if (stored?.origin === this.options.origin && stored.installId === await this.options.identity.installId()
      && typeof stored.credential === 'string' && stored.credential !== '') return stored.credential;
    return undefined;
  }

  login(): Promise<Result> {
    if (this.pending) return this.pending;
    if (this.disposed) return Promise.resolve({ ok: false });
    const task = this.authorize().catch(() => ({ ok: false })).finally(() => {
      if (this.pending === task) this.pending = null;
    });
    this.pending = task;
    return task;
  }

  /** 登录中再点：作废进行中的授权并关掉它的授权页，再开一次新的授权。 */
  restart(): Promise<Result> {
    if (this.pending) {
      this.generation++;
      this.controller?.abort();
      this.pending = null;
    }
    return this.login();
  }

  /** 立即废弃迟到的授权；清理完成前不能启动下一次登录。 */
  invalidate(): Promise<void> {
    this.generation++;
    this.controller?.abort();
    this.invalidating = this.invalidating.catch(() => undefined).then(async () => {
      const cleared = await Promise.allSettled([
        this.options.onInvalidated(),
        this.options.local.remove(CREDENTIAL_KEY),
      ]);
      for (const result of cleared) if (result.status === 'rejected') throw result.reason;
    });
    return this.invalidating;
  }

  async logout(): Promise<Result> {
    const credential = await this.credential();
    const installId = await this.options.identity.installId();
    // 本地立即收回执行权限，即使服务不可达也不继续使用旧凭据。
    const cleanup = this.invalidate();
    try {
      if (!credential) return { ok: true };
      const response = await fetch(`${this.options.origin}/chat-service/browser/logout`, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${credential}` },
        body: JSON.stringify({ install_id: installId }),
      });
      return { ok: response.ok || response.status === 401 };
    } catch { return { ok: false }; }
    finally { await cleanup; }
  }

  dispose(): void {
    this.disposed = true;
    this.generation++;
    this.controller?.abort();
  }

  private async authorize(): Promise<Result> {
    await this.invalidating;
    if (this.disposed) return { ok: false };
    const generation = this.generation;
    const ctrl = new AbortController();
    this.controller = ctrl;
    const active = () => !this.disposed && generation === this.generation && !ctrl.signal.aborted;
    const verifier = randomValue();
    const state = randomValue();
    const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const installId = await this.options.identity.installId();
    const displayName = await this.options.identity.displayName();
    if (!active()) return { ok: false };
    const identity = chrome.identity;
    const redirect = typeof identity?.launchWebAuthFlow === 'function' && typeof identity?.getRedirectURL === 'function'
      ? identity.getRedirectURL() : '';
    const browser = redirect === '' ? 'safari' : new URL(redirect).hostname.endsWith('.extensions.allizom.org') ? 'firefox' : 'chromium';
    const url = new URL('/chat/browser-extension/authorize', this.options.origin);
    url.search = new URLSearchParams({ install_id: installId, browser, display_name: displayName,
      code_challenge: challenge, code_challenge_method: 'S256', state,
      ...(redirect ? { redirect_uri: redirect } : {}),
    }).toString();

    let tab: number | undefined;
    let keepAlive: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      timeout = setTimeout(() => ctrl.abort(), LOGIN_TIMEOUT_MS);
      // 授权页打开期间沿用后台的原生 API 保活，避免等待用户操作的事件后台被挂起。
      keepAlive = setInterval(() => { void chrome.runtime.getPlatformInfo(); }, 20_000);
      const callback = redirect
        ? await this.identityCallback(identity, url.href, ctrl.signal)
        : await this.tabCallback(url.href, ctrl.signal, (id) => { tab = id; });
      if (!active()) return { ok: false };
      const result = new URL(callback);
      const expected = new URL(redirect || `${this.options.origin}${CALLBACK_PATH}`);
      if (result.origin !== expected.origin || result.pathname !== expected.pathname
        || result.searchParams.get('state') !== state || result.searchParams.has('error')) return { ok: false };
      const code = result.searchParams.get('code');
      if (!code) return { ok: false };
      const response = await fetch(`${this.options.origin}/chat-service/browser/token`, {
        method: 'POST', credentials: 'omit', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
        body: JSON.stringify({ code, code_verifier: verifier, install_id: installId, redirect_uri: redirect }),
      });
      if (!response.ok) return { ok: false };
      const body: unknown = await response.json();
      if (!active() || !body || typeof body !== 'object' || !('credential' in body) || typeof body.credential !== 'string'
        || !body.credential || !('account' in body) || typeof body.account !== 'string' || !body.account) return { ok: false };
      await this.options.local.set(CREDENTIAL_KEY, { origin: this.options.origin, installId, credential: body.credential, account: body.account });
      if (!active()) return { ok: false };
      this.options.onAuthenticated();
      return { ok: true };
    } finally {
      clearInterval(keepAlive);
      clearTimeout(timeout);
      if (this.controller === ctrl) this.controller = null;
      // Safari 的授权页在 state 检查与交换结束后关闭；不会关闭用户原来的平台标签页。
      if (tab !== undefined) await chrome.tabs.remove(tab).catch(() => undefined);
    }
  }

  private identityCallback(identity: typeof chrome.identity, url: string, signal: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(new Error('cancelled'));
      signal.addEventListener('abort', abort, { once: true });
      identity.launchWebAuthFlow({ url, interactive: true }).then((callback) => {
        if (callback) resolve(callback); else reject(new Error('cancelled'));
      }, () => reject(new Error('cancelled'))).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  private tabCallback(url: string, signal: AbortSignal, created: (id: number) => void): Promise<string> {
    return new Promise((resolve, reject) => {
      let tabId: number | undefined;
      const cleanup = () => {
        chrome.tabs.onUpdated.removeListener(updated);
        chrome.tabs.onRemoved.removeListener(removed);
        signal.removeEventListener('abort', aborted);
      };
      const fail = () => { cleanup(); reject(new Error('cancelled')); };
      const aborted = () => fail();
      const removed = (id: number) => { if (id === tabId) fail(); };
      const updated = (id: number, change: { url?: string }) => {
        if (id !== tabId || !change.url) return;
        let callback: URL;
        try { callback = new URL(change.url); } catch { return; }
        if (callback.origin !== this.options.origin || callback.pathname !== CALLBACK_PATH) return;
        cleanup();
        resolve(callback.href);
      };
      chrome.tabs.onUpdated.addListener(updated);
      chrome.tabs.onRemoved.addListener(removed);
      signal.addEventListener('abort', aborted, { once: true });
      void chrome.tabs.create({ url }).then(async (tab) => {
        tabId = tab.id;
        if (tabId === undefined) { fail(); return; }
        created(tabId);
        if (signal.aborted) { await chrome.tabs.remove(tabId).catch(() => undefined); fail(); return; }
        // 导航可能早于 create 的 Promise 完成，补读当前标签 URL。
        const current = await chrome.tabs.get(tabId);
        if (current.url) updated(tabId, { url: current.url });
      }).catch(fail);
    });
  }
}
