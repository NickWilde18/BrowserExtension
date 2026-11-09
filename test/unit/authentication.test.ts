import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserAuthentication } from '../../src/connection/authentication';
import { Identity } from '../../src/identity';
import { MemoryKV } from '../../src/storage';

const ORIGIN = 'https://platform.test';
const INSTALL = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const redirect = 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org/';
const flush = async () => { for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0)); };

async function setup(kind: 'chromium' | 'firefox' | 'safari' = 'chromium') {
  const local = new MemoryKV();
  await local.set('identity.installId', INSTALL);
  await local.set('identity.displayName', 'Test browser');
  let complete!: (url: string) => void;
  let launchUrl = '';
  const updated = new Set<(id: number, change: { url?: string }) => void>();
  const removed = new Set<(id: number) => void>();
  const launch = vi.fn(({ url }: { url: string }) => { launchUrl = url; return new Promise<string>((r) => { complete = r; }); });
  const close = vi.fn(async () => undefined);
  const onAuthenticated = vi.fn();
  const onInvalidated = vi.fn(async () => undefined);
  const getRedirectURL = () => kind === 'firefox' ? `https://${'a'.repeat(40)}.extensions.allizom.org/` : redirect;
  vi.stubGlobal('chrome', {
    identity: kind === 'safari' ? undefined : { launchWebAuthFlow: launch, getRedirectURL },
    tabs: {
      create: vi.fn(async ({ url }: { url: string }) => { launchUrl = url; return { id: 7 }; }),
      get: vi.fn(async () => ({ id: 7, url: launchUrl })),
      remove: close,
      onUpdated: { addListener: (f: any) => updated.add(f), removeListener: (f: any) => updated.delete(f) },
      onRemoved: { addListener: (f: any) => removed.add(f), removeListener: (f: any) => removed.delete(f) },
    },
    runtime: { getPlatformInfo: vi.fn(async () => ({})) },
  });
  const fetcher = vi.fn(async () => Response.json({ credential: 'synthetic-fixture', account: 'user@example.test' }));
  vi.stubGlobal('fetch', fetcher);
  const auth = new BrowserAuthentication({ origin: ORIGIN, local, identity: new Identity(local), onAuthenticated, onInvalidated });
  const callback = (params: Record<string, string> = {}) => {
    const url = new URL(kind === 'safari' ? `${ORIGIN}/chat/browser-extension/callback` : getRedirectURL());
    url.searchParams.set('state', new URL(launchUrl).searchParams.get('state')!);
    url.searchParams.set('code', 'synthetic-code');
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    if (kind === 'safari') for (const fn of updated) fn(7, { url: url.href });
    else complete(url.href);
  };
  return { auth, local, launch, fetcher, onAuthenticated, onInvalidated, close, callback, url: () => new URL(launchUrl), updated, removed };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('独立安装认证', () => {
  it.each(['chromium', 'firefox', 'safari'] as const)('%s 授权参数、S256 交换和持久凭据；重复点击复用登录', async (kind) => {
    const s = await setup(kind);
    const a = s.auth.login();
    const b = s.auth.login();
    expect(a).toBe(b);
    await flush();
    const query = s.url().searchParams;
    expect(s.url().pathname).toBe('/chat/browser-extension/authorize');
    expect(query.get('browser')).toBe(kind);
    expect(query.get('install_id')).toBe(INSTALL);
    expect(query.get('code_challenge_method')).toBe('S256');
    expect(query.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(query.has('redirect_uri')).toBe(kind !== 'safari');
    s.callback();
    expect(await a).toEqual({ ok: true });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = (s.fetcher.mock.calls as unknown as [string, RequestInit][])[0]!;
    expect(url).toBe(`${ORIGIN}/chat-service/browser/token`);
    expect(init.credentials).toBe('omit');
    const body = JSON.parse(String(init.body));
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.code_verifier));
    expect(Buffer.from(digest).toString('base64url') === query.get('code_challenge')).toBe(true);
    expect(body.install_id).toBe(INSTALL);
    expect(body.redirect_uri).toBe(query.get('redirect_uri') ?? '');
    expect((await s.auth.credential()) === 'synthetic-fixture').toBe(true);
    expect(s.onAuthenticated).toHaveBeenCalledTimes(1);
    if (kind === 'safari') {
      expect(s.close).toHaveBeenCalledWith(7);
      expect(s.updated.size + s.removed.size).toBe(0);
    }
  });

  it.each<Record<string, string>>([{ state: 'wrong' }, { error: 'access_denied' }])('state 不符或拒绝不交换也不保存', async (params) => {
    const s = await setup();
    const pending = s.auth.login();
    await flush();
    s.callback(params);
    expect((await pending).ok).toBe(false);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(await s.auth.credential()).toBeUndefined();
  });

  // 服务端拒绝回调不带 code；三种浏览器都应结束等待，不交换/保存凭据，随后可以正常再登录。
  it.each(['chromium', 'firefox', 'safari'] as const)('%s 拒绝回调结束等待、拒绝重放不发凭据、可以重新授权', async (kind) => {
    const s = await setup(kind);
    const denied = s.auth.login();
    await flush();
    const oldState = s.url().searchParams.get('state')!;
    s.callback({ code: '', error: 'access_denied' });
    expect(await denied).toEqual({ ok: false });
    expect(s.auth.signingIn).toBe(false);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(await s.auth.credential()).toBeUndefined();
    expect(s.onAuthenticated).not.toHaveBeenCalled();
    if (kind === 'safari') {
      expect(s.close).toHaveBeenCalledWith(7);
      expect(s.updated.size + s.removed.size).toBe(0);
    }

    const replay = s.auth.login();
    await flush();
    expect(s.url().searchParams.get('state')).not.toBe(oldState);
    s.callback({ code: '', error: 'access_denied', state: oldState });
    expect(await replay).toEqual({ ok: false });
    expect(s.auth.signingIn).toBe(false);
    expect(s.fetcher).not.toHaveBeenCalled();
    expect(await s.auth.credential()).toBeUndefined();

    const retry = s.auth.login();
    await flush();
    s.callback();
    expect(await retry).toEqual({ ok: true });
    expect(s.fetcher).toHaveBeenCalledTimes(1);
    expect(s.onAuthenticated).toHaveBeenCalledTimes(1);
  });

  it('identity 关窗拒绝后可以重新登录', async () => {
    const s = await setup('firefox');
    s.launch.mockRejectedValueOnce(new Error('cancelled'));
    expect((await s.auth.login()).ok).toBe(false);
    const next = s.auth.login();
    await flush();
    s.callback();
    expect((await next).ok).toBe(true);
  });

  it('Safari 只收本标签同源指定路径，换凭据完成后才关标签', async () => {
    const s = await setup('safari');
    const pending = s.auth.login();
    await flush();
    for (const fn of s.updated) {
      fn(8, { url: `${ORIGIN}/chat/browser-extension/callback?code=x` });
      fn(7, { url: 'https://other.test/chat/browser-extension/callback?code=x' });
    }
    expect(s.fetcher).not.toHaveBeenCalled();
    let finish!: () => void;
    s.fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(Response.json({ credential: 'synthetic-fixture', account: 'user@example.test' })); }));
    s.callback();
    await flush();
    expect(s.close).not.toHaveBeenCalled();
    finish();
    expect((await pending).ok).toBe(true);
    expect(s.close).toHaveBeenCalledTimes(1);
  });

  it('Safari 关闭授权页结束等待，可以重试', async () => {
    const s = await setup('safari');
    const pending = s.auth.login();
    await flush();
    for (const fn of s.removed) fn(7);
    expect((await pending).ok).toBe(false);
    expect(s.updated.size + s.removed.size).toBe(0);
  });

  it('退出用 Bearer 发 install_id，网络失败也清本地凭据与授权', async () => {
    const s = await setup();
    const login = s.auth.login(); await flush(); s.callback(); await login;
    s.fetcher.mockRejectedValueOnce(new Error('offline'));
    expect((await s.auth.logout()).ok).toBe(false);
    expect(await s.auth.credential()).toBeUndefined();
    expect(s.onInvalidated).toHaveBeenCalledTimes(1);
    const [url, init] = (s.fetcher.mock.calls as unknown as [string, RequestInit][]).at(-1)!;
    expect(url).toBe(`${ORIGIN}/chat-service/browser/logout`);
    expect(init.credentials).toBe('omit');
    expect(new Headers(init.headers).get('authorization') === 'Bearer synthetic-fixture').toBe(true);
    expect(JSON.parse(String(init.body))).toEqual({ install_id: INSTALL });
  });

  it('切服销毁后迟到换凭据不能写入或重连', async () => {
    const s = await setup();
    let finish!: () => void;
    s.fetcher.mockImplementationOnce(() => new Promise((resolve) => { finish = () => resolve(Response.json({ credential: 'synthetic-fixture', account: 'user@example.test' })); }));
    const login = s.auth.login(); await flush(); s.callback(); await flush();
    s.auth.dispose(); finish();
    expect((await login).ok).toBe(false);
    expect(await s.auth.credential()).toBeUndefined();
    expect(s.onAuthenticated).not.toHaveBeenCalled();
  });

  it('撤销先停止执行；存储删除失败也执行授权清理', async () => {
    const s = await setup();
    let remove!: () => void;
    vi.spyOn(s.local, 'remove').mockImplementationOnce(() => new Promise<void>((resolve) => { remove = resolve; }));
    const clearing = s.auth.invalidate();
    await flush();
    expect(s.onInvalidated).toHaveBeenCalledTimes(1);
    remove(); await clearing;
    s.onInvalidated.mockClear();
    vi.spyOn(s.local, 'remove').mockRejectedValueOnce(new Error('storage unavailable'));
    await expect(s.auth.invalidate()).rejects.toThrow('storage unavailable');
    expect(s.onInvalidated).toHaveBeenCalledTimes(1);
  });

  it('凭据绑定平台 origin 和 install_id；重启沿用，另一平台不发出', async () => {
    const s = await setup();
    const login = s.auth.login(); await flush(); s.callback(); await login;
    const options = { local: s.local, identity: new Identity(s.local), onAuthenticated: vi.fn(), onInvalidated: vi.fn() };
    const same = new BrowserAuthentication({ ...options, origin: ORIGIN });
    const other = new BrowserAuthentication({ ...options, origin: 'https://other.test' });
    expect((await same.credential()) === 'synthetic-fixture').toBe(true);
    expect(await other.credential()).toBeUndefined();
    await s.local.set('identity.installId', '11111111-2222-4333-8444-555555555555');
    expect(await same.credential()).toBeUndefined();
  });
});
