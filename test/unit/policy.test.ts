import { describe, expect, it } from 'vitest';

import { isCredentialHeader, stripCredentialHeaders } from '../../src/policy/headers';
import { SiteStore } from '../../src/policy/sites';
import { checkOpenableUrl, isUnattachableUrl, siteOf } from '../../src/policy/url';
import { ActionError } from '../../src/protocol/errors';
import { MemoryKV } from '../../src/storage';

function openCode(url: string): string | null {
  try {
    checkOpenableUrl(url);
    return null;
  } catch (err) {
    return err instanceof ActionError ? err.code : 'other';
  }
}

describe('网址可开范围', () => {
  it('能开 http(s)（含内网 IP、localhost）与 about:blank', () => {
    expect(checkOpenableUrl('https://intranet.example.edu/a?b=1')).toBe('https://intranet.example.edu/a?b=1');
    expect(checkOpenableUrl('http://10.1.2.3:8080/')).toBe('http://10.1.2.3:8080/');
    expect(checkOpenableUrl('http://localhost:3000')).toBe('http://localhost:3000/');
    expect(checkOpenableUrl(' about:blank ')).toBe('about:blank');
  });

  it('javascript:、data:、file://、浏览器与插件页面不开；带账号密码的不开', () => {
    for (const url of ['javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'chrome://settings',
      'edge://flags', 'chrome-extension://abc/x.html', 'devtools://devtools/x', 'view-source:https://a.test/', 'blob:https://a.test/1',
      'ftp://a.test/', 'https://user:pass@a.test/', 'https://user@a.test/']) {
      expect(openCode(url), url).toBe('site_not_allowed');
    }

    expect(openCode('not a url')).toBe('invalid_args');
  });

  it('站点是来源（协议 + 主机 + 端口），不是完整网址', () => {
    expect(siteOf('https://a.test:8443/x/y?z#w')).toBe('https://a.test:8443');
    expect(siteOf('https://A.Test/')).toBe('https://a.test');
    expect(siteOf('about:blank')).toBeNull();
    expect(siteOf('chrome://newtab')).toBeNull();
    expect(siteOf('')).toBeNull();
  });

  it('附着不上的页面', () => {
    expect(isUnattachableUrl('chrome://settings')).toBe(true);
    expect(isUnattachableUrl('chrome-extension://x/popup.html')).toBe(true);
    expect(isUnattachableUrl('about:blank')).toBe(false);
    expect(isUnattachableUrl('https://a.test/')).toBe(false);
  });
});

describe('凭据头去除', () => {
  it('按名字去掉 Cookie、Set-Cookie、Authorization、Proxy-Authorization 与带 token / session / csrf / xsrf / auth 的头', () => {
    for (const name of ['Cookie', 'set-cookie', 'AUTHORIZATION', 'Proxy-Authorization', 'X-Csrf-Token', 'X-XSRF-TOKEN', 'X-Session-Id',
      'x-auth-user', 'X-Api-Token', 'WWW-Authenticate', 'sessionid']) {
      expect(isCredentialHeader(name), name).toBe(true);
    }

    for (const name of ['Content-Type', 'Accept', 'X-Trace', 'Location', 'Cache-Control', 'User-Agent']) {
      expect(isCredentialHeader(name), name).toBe(false);
    }
  });

  it('其余头原样保留', () => {
    expect(stripCredentialHeaders({ 'Content-Type': 'a', Cookie: 'b', 'X-Trace': 'c', Authorization: 'd' }))
      .toEqual({ 'Content-Type': 'a', 'X-Trace': 'c' });
    expect(stripCredentialHeaders(undefined)).toEqual({});
  });
});

describe('站点授权记录', () => {
  it('仅本次对话只对那个对话有效；总是允许对所有对话有效；撤销两种都删', async () => {
    const store = new SiteStore(new MemoryKV(), new MemoryKV());
    await store.grant('c1', 'https://a.test', 'conversation');
    expect(await store.isAllowed('c1', 'https://a.test')).toBe(true);
    expect(await store.isAllowed('c2', 'https://a.test')).toBe(false);
    expect(await store.isAllowed('c1', 'https://b.test')).toBe(false);

    await store.grant('c2', 'https://b.test', 'always');
    expect(await store.isAllowed('c9', 'https://b.test')).toBe(true);

    await store.grant('c3', 'https://a.test', 'conversation');
    await store.revoke('https://a.test');
    expect(await store.isAllowed('c1', 'https://a.test')).toBe(false);
    expect(await store.isAllowed('c3', 'https://a.test')).toBe(false);
    expect((await store.list()).conversation).toEqual({});
    expect((await store.list()).always).toEqual(['https://b.test']);
  });

  it('站点按来源比：同主机不同端口、不同协议都算不同站点', async () => {
    const store = new SiteStore(new MemoryKV(), new MemoryKV());
    await store.grant('c1', 'https://a.test', 'conversation');
    expect(await store.isAllowed('c1', 'https://a.test:8443')).toBe(false);
    expect(await store.isAllowed('c1', 'http://a.test')).toBe(false);
  });
});
