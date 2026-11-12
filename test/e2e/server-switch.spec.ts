// 两个独立本地服务、相同账号与 hostname，验证切服实际重新握手且不继承权限。
import { chromium, expect, test, type BrowserContext, type Page, type Worker } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { A, CONV, signIn, openTab } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIRST = 'http://127.0.0.1:18963';
const SECOND = 'http://127.0.0.1:18964';
const RID = '10000000-0000-4000-8000-000000000001';
let other: ChildProcess;
let ctx: BrowserContext;
let sw: Worker;
let popup: Page;

async function ctl(origin: string, op: string, params: Record<string, string> = {}) {
  return (await fetch(`${origin}/__control/${op}?${new URLSearchParams(params)}`)).json();
}
async function send(origin: string, id: string, action: string, args: object) {
  await ctl(origin, 'send', { frame: JSON.stringify({ type: 'request', request_id: id, action, args, conversation: CONV, conversation_title: '切服测试', deadline_ms: 30000, auth_wait_ms: 60000 }) });
}
const state = () => popup.evaluate(() => chrome.runtime.sendMessage({ type: 'popup:state' }));

test.beforeAll(async () => {
  other = spawn(process.execPath, [path.join(here, 'fixtures/chat-server.mjs'), '18964'], { stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('second fixture did not start')), 10000);
    other.stdout!.on('data', (b) => { if (String(b).includes('"ready":true')) { clearTimeout(timeout); resolve(); } });
    other.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`second fixture exited ${code}`)); });
  });
});
test.afterAll(() => { other?.kill(); });
test.afterEach(async () => { await ctx?.close(); });

test('高级设置通过真实权限API切服，旧确认/授权/去重不进入同账号新服务器', async ({}, info) => {
  const extension = path.resolve(here, '../../dist-test-fetch');
  ctx = await chromium.launchPersistentContext(info.outputPath('profile'), { channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${id}/popup.html`);
  await signIn(ctx, popup);
  await expect.poll(async () => (await state()).connection).toBe('connected');
  await sw.evaluate(({ conv, site }) => (globalThis as any).__bxTest.sites.grant(conv, site, 'always'), { conv: CONV, site: A });
  await send(FIRST, RID, 'open', { url: `${A}/form.html` });
  await expect.poll(async () => (await ctl(FIRST, 'state')).received.find((x: any) => x.frame.request_id === RID)?.frame.outcome).toBe('ok');
  const pending = '10000000-0000-4000-8000-000000000002';
  await send(FIRST, pending, 'evaluate', { function: '() => document.title' });
  await expect.poll(() => ctx.pages().filter((p) => p.url().includes('approval.html')).length).toBe(1);

  await openTab(popup, 'settings');
  await popup.locator('#openSettings').click();
  await popup.locator('#serverOrigin').fill(SECOND);
  await popup.locator('#saveServer').click();
  // 先说明系统权限，再从真实点击申请权限；拿到权限后仍须单独确认清除状态。
  await expect(popup.locator('#serverPermissionHint')).toBeVisible();
  await popup.locator('#saveServer').click();
  await expect(popup.locator('#switchConfirmation')).toBeVisible();
  expect((await state()).serverOrigin).toBe(FIRST);
  await popup.locator('#saveServer').click();
  await expect.poll(async () => ({ origin: (await state()).serverOrigin, connection: (await state()).connection })).toEqual({ origin: SECOND, connection: 'waiting_login' });
  await expect(popup.locator('#serverError')).toContainText('saved');
  expect((await ctl(SECOND, 'state')).hellos).toHaveLength(0);
  await popup.locator('#settingsView [data-back]').click();
  await signIn(ctx, popup);
  await expect.poll(() => ctx.pages().filter((p) => p.url().includes('approval.html')).length).toBe(0);
  expect((await state()).sites).toEqual({ always: [], conversation: [] });
  expect(await sw.evaluate((conv) => (globalThis as any).__bxTest.tabs.list(conv), CONV)).toEqual([]);
  expect(await sw.evaluate(() => (globalThis as any).__bxTest.attachedCount())).toBe(0);
  expect(ctx.pages().some((p) => p.url() === `${A}/form.html`)).toBe(true);
  expect((await ctl(SECOND, 'state')).hellos).toHaveLength(1);
  expect((await ctl(SECOND, 'state')).received.some((x: any) => x.frame.request_id === pending)).toBe(false);

  // 新服务器即使复用了旧服务器 request_id，也不得被旧去重缓存吞掉。
  await send(SECOND, RID, 'tabs', { op: 'list' });
  await expect.poll(async () => (await ctl(SECOND, 'state')).received.find((x: any) => x.frame.request_id === RID)?.frame.payload?.tabs).toEqual([]);

  // 未授权地址只保存并等待登录，不发送带另一个平台凭据的探测请求。
  const beforeChange = await state();
  const selected = await popup.evaluate(({ origin, epoch }) => chrome.runtime.sendMessage({ type: 'popup:setServer', origin, epoch }),
    { origin: A, epoch: beforeChange.serverEpoch });
  expect(selected).toMatchObject({ ok: true });
  await expect.poll(async () => ({ origin: (await state()).serverOrigin, connection: (await state()).connection })).toEqual({ origin: A, connection: 'waiting_login' });
  expect((await state()).serverEpoch).not.toBe(beforeChange.serverEpoch);
});
