import { expect, test } from '@playwright/test';
import { A, CONV, allowSite, call, launch, type Harness } from './helpers';

let h: Harness;
test.beforeEach(async () => { h = await launch(); });
test.afterEach(async () => { await h.close(); });

async function popup() {
  const p = await h.ctx.newPage();
  await p.goto(`chrome-extension://${h.extId}/popup.html`);
  return p;
}

test('服务器配置可读；切换到同主机另一来源也清除同名账号的授权与页归属', async () => {
  await allowSite(h, A);
  expect((await call(h, 'open', { url: `${A}/form.html` })).outcome).toBe('ok');
  await h.sw.evaluate((site) => (globalThis as any).__bxTest.sites.grant('any', site, 'always'), A);
  const p = await popup();
  const state = await p.evaluate(() => chrome.runtime.sendMessage({ type: 'popup:state' }));
  expect(state.serverOrigin).toBe('http://127.0.0.1:18960');
  expect(typeof state.serverEpoch).toBe('string');
  const switched = await p.evaluate(({ origin, epoch }) => chrome.runtime.sendMessage({ type: 'popup:setServer', origin, epoch }), { origin: A, epoch: state.serverEpoch });
  expect(switched).toMatchObject({ ok: true });
  await expect.poll(() => h.sw.evaluate(() => (globalThis as any).__bxTest.status().state)).toBe('connected');
  expect(await h.sw.evaluate((conv) => (globalThis as any).__bxTest.tabs.list(conv), CONV)).toEqual([]);
  expect(await h.sw.evaluate(() => (globalThis as any).__bxTest.sites.list())).toEqual({ always: [], conversation: {} });
  expect(await h.sw.evaluate(() => (globalThis as any).__bxTest.attachedCount())).toBe(0);
  expect(h.ctx.pages().some((page) => page.url() === `${A}/form.html`)).toBe(true);
  const after = await p.evaluate(() => chrome.runtime.sendMessage({ type: 'popup:state' }));
  expect(after.serverOrigin).toBe(A);
  expect(after.serverEpoch).not.toBe(state.serverEpoch);
  expect(await p.evaluate((epoch) => chrome.runtime.sendMessage({ type: 'popup:setServer', origin: 'http://127.0.0.1:18960', epoch }), state.serverEpoch)).toMatchObject({ ok: false });
});
