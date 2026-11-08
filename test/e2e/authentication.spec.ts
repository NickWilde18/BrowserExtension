// 使用真实浏览器 identity 窗口和本地授权/交换夹具，不读取凭据。
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CHAT_PORT } from './global-setup';
import { signIn } from './helpers';

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-test-fetch');
const CHAT = `http://127.0.0.1:${CHAT_PORT}`;
let ctx: BrowserContext;
let popup: Page;
let sw: Worker;
const fixture = async () => (await fetch(`${CHAT}/__control/state`)).json();

test.beforeEach(async ({}, info) => {
  ctx = await chromium.launchPersistentContext(info.outputPath('profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
  await expect(popup.locator('#login')).toBeVisible();
});
test.afterEach(async () => { await ctx?.close(); });

test('不申请 cookies；平台 Cookie 新增/删除不改变独立登录', async () => {
  const permissions = await sw.evaluate(() => chrome.runtime.getManifest().permissions);
  expect(permissions).not.toContain('cookies');
  expect(permissions).toContain('identity');
  await signIn(ctx, popup);
  const before = (await fixture()).streamCount;
  await ctx.addCookies([{ name: 'platform-session', value: 'synthetic', url: CHAT, httpOnly: true, sameSite: 'Lax' }]);
  await ctx.clearCookies();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  expect((await fixture()).streamCount).toBe(before);
  expect(await sw.evaluate(() => (globalThis as any).__bxTest.status().state)).toBe('connected');
});

test('用户拒绝不换凭据，重新点击可授权；并发点击只有一个授权流程', async () => {
  const before = await fixture();
  await signIn(ctx, popup, 'Decline authorization');
  expect((await fixture()).exchanges).toBe(before.exchanges);
  const opened = ctx.waitForEvent('page');
  const pending = popup.evaluate(() => Promise.all([
    chrome.runtime.sendMessage({ type: 'popup:login' }),
    chrome.runtime.sendMessage({ type: 'popup:login' }),
  ]));
  const authorization = await opened;
  await authorization.getByRole('button', { name: 'Authorize browser', exact: true }).click();
  expect(await pending).toEqual([{ ok: true }, { ok: true }]);
  expect((await fixture()).authorizations).toBe(before.authorizations + 2);
  expect((await fixture()).exchanges).toBe(before.exchanges + 1);
});

test('回调 state 不符不换凭据、不登录，仍可重新授权', async () => {
  await fetch(`${CHAT}/__control/next-auth?mode=wrong_state`);
  const before = await fixture();
  const opened = ctx.waitForEvent('page');
  await popup.locator('#login').click();
  const authorization = await opened;
  await authorization.getByRole('button', { name: 'Authorize browser', exact: true }).click();
  await expect(popup.locator('#authError')).toBeVisible();
  expect((await fixture()).exchanges).toBe(before.exchanges);
  expect(await sw.evaluate(async () => !!(await chrome.storage.local.get('connection.credential'))['connection.credential'])).toBe(false);
  await signIn(ctx, popup);
});
