// 真实传输（契约第 2 节 A2）：插件经 fetch 连仿 Chat 服务（fixtures/chat-server.mjs）。加载 dist-test-fetch：
// 平台地址是仿 Chat 服务，连接用真实传输（测试入口照开，只读状态、预授权站点用）。
import { chromium, expect, test } from '@playwright/test';
import type { BrowserContext, Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CHAT_PORT } from './global-setup';
import { ACTIONS } from '../../src/protocol/frames';
import { A, CONV, answer, refOf, signIn, openTab } from './helpers';
import type { Harness } from './helpers';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.resolve(here, '..', '..', 'dist-test-fetch');
const CHAT = `http://127.0.0.1:${CHAT_PORT}`;
const EXT_ID = 'agagklnjfndomhambbpfhenaoclcbpmo';
const EXT_ORIGIN = `chrome-extension://${EXT_ID}`;
const PATHS = ['stream', 'frames', 'uploads', 'files'].map((p) => `/chat-service/browser/${p}`);

test.describe.configure({ mode: 'serial' });

let ctx: BrowserContext;
let sw: Worker;
let dir: string;
let seq = 0;

async function ctl(op: string, params: Record<string, string> = {}): Promise<any> {
  return (await fetch(`${CHAT}/__control/${op}?${new URLSearchParams(params)}`)).json();
}

async function until<T>(fn: () => Promise<T>, ok: (v: T) => boolean, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (ok(v) || Date.now() > end) {
      return v;
    }

    await new Promise((r) => setTimeout(r, 50));
  }
}

const status = () => sw.evaluate(() => (globalThis as any).__bxTest.status());

/** 经仿 Chat 下发一个请求，等插件经 frames 交回的结果。 */
async function request(action: string, args: Record<string, unknown> = {}, wait = true): Promise<any> {
  seq++;
  const id = `00000000-0000-4000-c000-${seq.toString(16).padStart(12, '0')}`;
  await ctl('send', { frame: JSON.stringify({ type: 'request', request_id: id, action, args, conversation: CONV, conversation_title: '传输测试', deadline_ms: 30000, auth_wait_ms: 60000 }) });
  if (!wait) {
    return id;
  }

  return result(id);
}

async function result(id: string): Promise<any> {
  const st = await until(() => ctl('state'), (s) => s.received.some((r: any) => r.frame.type === 'result' && r.frame.request_id === id), 30_000);
  return st.received.find((r: any) => r.frame.type === 'result' && r.frame.request_id === id)?.frame;
}

const harness = (): Harness => ({ ctx, sw, extId: EXT_ID, close: async () => undefined });

/** 给对话预先授权夹具站点（跳过站点授权小窗）：后面的用例和登录那条一起单独跑也成立。 */
const grantA = () => sw.evaluate(({ conv, site }) => (globalThis as any).__bxTest.sites.grant(conv, site, 'conversation'), { conv: CONV, site: A });

test.beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-transport-'));
  ctx = await chromium.launchPersistentContext(dir, {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
  });
  ctx.on('page', (p) => p.on('dialog', () => undefined));
  sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
});

test.afterAll(async () => {
  await ctx?.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('平台网页 Cookie 不足以连接；插件独立授权后连上、收到 ready', async () => {
  const before = await until(status, (s: any) => s.state === 'waiting_login');
  expect(before).toMatchObject({ state: 'waiting_login', lastError: 'unauthenticated' });

  const page = await ctx.newPage();
  await page.goto(`${CHAT}/login`);
  await sw.evaluate(() => (globalThis as any).__bxTest.reconnect());
  expect((await until(status, (v: any) => v.state === 'waiting_login')).state).toBe('waiting_login');
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await signIn(ctx, popup);
  await popup.close();
  const s = await until(status, (v: any) => v.state === 'connected');
  expect(s).toMatchObject({ state: 'connected', account: 'first.user@example.test' });

  const st = await ctl('state');
  expect(st.hellos.at(-1)).toMatchObject({ type: 'hello', protocol: 1, capabilities: { actions: [...ACTIONS] } });
  expect(st.hellos.at(-1).install_id).toMatch(/^[0-9a-f-]{36}$/);
});

test('执行一个动作，结果经 frames 交回', async () => {
  await sw.evaluate((site) => (globalThis as any).__bxTest.sites.grant('0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0', site, 'conversation'), A);
  const r = await request('open', { url: `${A}/form.html` });
  expect(r).toMatchObject({ outcome: 'ok', page: { url: `${A}/form.html`, title: 'Form' } });
});

test('上传：经 uploads 按令牌取文件内容', async () => {
  await ctl('upload', { token: 'tk-1', b64: Buffer.from('hello upload').toString('base64'), type: 'text/plain' });
  await request('open', { url: `${A}/upload.html` });
  const snap = String((await request('read')).payload.snapshot);
  const id = await request('upload', { element: 'Attachment', ref: refOf(snap, 'Attachment'), files: [{ token: 'tk-1', name: 'note.txt', size: 12, content_type: 'text/plain' }] }, false);
  await answer(harness(), 'Allow');
  const r = await result(id);
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  const page = ctx.pages().find((p) => p.url().includes('/upload.html'));
  await expect.poll(() => page?.locator('#out').textContent()).toContain('visible:note.txt:12:text/plain');
});

test('上传：uploads 读到一半断了（字节数不到 Content-Length）：回 action_failed，不把截断的文件放进页面', async () => {
  await grantA();
  const data = Buffer.from('0123456789'.repeat(400));
  await ctl('upload', { token: 'tk-cut', b64: data.toString('base64'), type: 'text/plain', truncate: '1' });
  await request('open', { url: `${A}/upload.html` });
  const snap = String((await request('read')).payload.snapshot);
  const id = await request('upload', { element: 'Attachment', ref: refOf(snap, 'Attachment'), files: [{ token: 'tk-cut', name: 'cut.txt', size: data.length, content_type: 'text/plain' }] }, false);
  await answer(harness(), 'Allow');
  const r = await result(id);
  expect(r, JSON.stringify(r)).toMatchObject({ outcome: 'error', code: 'action_failed' });
  expect(r.message).toContain('nothing was uploaded');
  const page = ctx.pages().find((p) => p.url().includes('/upload.html'));
  expect(await page?.locator('#out').textContent()).not.toContain('cut.txt');
});

test('下载：内容经 files 送回 Chat，结果里是 Chat 给的 file_id', async () => {
  await request('open', { url: `${A}/download.html` });
  const snap = String((await request('read')).payload.snapshot);
  const id = await request('click', { element: 'Get the report', ref: refOf(snap, 'Get the report') }, false);
  await answer(harness(), 'Allow');
  const r = await result(id);
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  const st = await ctl('state');
  const stored = st.files.at(-1);
  expect(r.payload.files[0]).toMatchObject({ file_id: stored.file_id, kind: 'download', name: 'report-2026.txt' });
  expect(stored).toMatchObject({ request_id: id, name: 'report-2026.txt', content_type: 'text/plain', text: 'quarterly report\nline two\n' });
  expect(stored.install_id).toBe(st.hellos.at(-1).install_id);
});

test('rotate（连接到 5 分钟寿命）：立刻重连，不退避', async () => {
  const before = (await ctl('state')).streamCount;
  const t0 = Date.now();
  await ctl('rotate');
  const st = await until(() => ctl('state'), (s) => s.streamCount === before + 1 && s.streamOpen, 5000);
  expect(st.streamCount).toBe(before + 1);
  expect(Date.now() - t0).toBeLessThan(1000);
  expect((await until(status, (v: any) => v.state === 'connected')).state).toBe('connected');
});

test('断线：按退避重连', async () => {
  const before = (await ctl('state')).streamCount;
  await ctl('drop');
  const st = await until(() => ctl('state'), (s) => s.streamCount === before + 1 && s.streamOpen, 10_000);
  expect(st.streamCount).toBe(before + 1);
  expect((await until(status, (v: any) => v.state === 'connected')).state).toBe('connected');
});

test('401：清掉凭据并停止重连；重新独立授权后恢复', async () => {
  const before = (await ctl('state')).streamCount;
  await ctl('next-stream', { status: '401' });
  await ctl('drop');
  const s = await until(status, (v: any) => v.state === 'waiting_login', 10_000);
  expect(s).toMatchObject({ state: 'waiting_login', lastError: 'unauthenticated' });
  expect(s.retryAt).toBeUndefined();
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect((await ctl('state')).streamCount).toBe(before);
  expect(await sw.evaluate(async () => !!(await chrome.storage.local.get('connection.credential'))['connection.credential'])).toBe(false);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await signIn(ctx, popup);
  await popup.close();
  expect((await ctl('state')).streamCount).toBe(before + 1);
});

test('审查结论从轮换后的新连接到达（补充约定 1）：照认，不弹确认小窗', async () => {
  await grantA();
  await ctl('hold-approvals', { on: '1' });
  try {
    await request('open', { url: `${A}/download.html` });
    const snap = String((await request('read')).payload.snapshot);
    const id = await request('click', { element: 'Get the report', ref: refOf(snap, 'Get the report') }, false);
    await until(() => ctl('state'), (s) => s.heldApprovals.length > 0, 10_000);

    // 请求在这条连接上收到；连接轮换之后，结论从新连接发来。
    const before = (await ctl('state')).streamCount;
    await ctl('rotate');
    await until(() => ctl('state'), (s) => s.streamCount === before + 1 && s.streamOpen, 5000);
    await until(status, (v: any) => v.state === 'connected');
    expect((await ctl('approve', { decision: 'allow' })).ok).toBe(true);

    const r = await result(id);
    expect(r.outcome, JSON.stringify(r)).toBe('ok');
    expect(r.payload.files[0]).toMatchObject({ kind: 'download', name: 'report-2026.txt' });
    expect(ctx.pages().some((p) => p.url().includes('/approval.html'))).toBe(false);
  } finally {
    await ctl('hold-approvals', { on: '0' });
  }
});

test('frames 回 413（结果超过 9 MiB，补充约定 3）：换成 action_failed 的错误结果再发一次', async () => {
  await ctl('next-frames', { status: '413' });
  const r = await request('read');
  expect(r).toEqual({ type: 'result', request_id: r.request_id, outcome: 'error', code: 'action_failed', message: 'The result was too large to send.' });
});

test('files 回 413：存 PDF 回 file_too_large；下载回 file_too_large，说明写明动作已经生效', async () => {
  await grantA();
  await request('open', { url: `${A}/form.html` });
  await ctl('next-files', { status: '413' });
  expect(await request('pdf')).toMatchObject({ outcome: 'error', code: 'file_too_large' });

  await request('open', { url: `${A}/download.html` });
  const snap = String((await request('read')).payload.snapshot);
  await ctl('next-files', { status: '413' });
  const id = await request('click', { element: 'Get the report', ref: refOf(snap, 'Get the report') }, false);
  await answer(harness(), 'Allow');
  const r = await result(id);
  expect(r).toMatchObject({ outcome: 'error', code: 'file_too_large' });
  expect(r.message).toContain('do not repeat');
});

test('stream 回 403（插件没在平台登记）：停住不重连，弹窗提示；点「重新连接」再连', async () => {
  const streams = async () => (await ctl('state')).requests.filter((r: any) => r.path.endsWith('/stream')).length;
  await ctl('next-stream', { status: '403' });
  await ctl('drop');
  const s = await until(status, (v: any) => v.lastError === 'forbidden', 10_000);
  expect(s).toMatchObject({ state: 'error', lastError: 'forbidden' });
  expect(s.retryAt).toBeUndefined();
  const n = await streams();
  await new Promise((r) => setTimeout(r, 3000));
  expect(await streams()).toBe(n);

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await expect(popup.locator('#state')).toHaveText('The platform refused access. Check your device authorization, then click Reconnect.');
  await popup.locator('#reconnect').click();
  expect((await until(status, (v: any) => v.state === 'connected')).state).toBe('connected');
  await popup.close();
});

test('换了平台账号（ready.account 变了，补充约定 4）：清掉上一个账号的对话状态、断开附着，AI 标签不关', async () => {
  const snapshot = () => sw.evaluate(async (conv) => {
    const t = (globalThis as any).__bxTest;
    return { target: (await t.popupState()).shareTarget, tabs: await t.tabs.list(conv), attached: t.attachedCount(), sites: await t.sites.list() };
  }, CONV);

  // 上一个账号：用过浏览器（AI 标签组、对话标题、站点授权、调试附着都在）。
  await sw.evaluate(({ conv, site }) => (globalThis as any).__bxTest.sites.grant(conv, site, 'always'), { conv: CONV, site: A });
  expect((await request('open', { url: `${A}/form.html` })).outcome).toBe('ok');
  const before = await snapshot();
  expect(before.target).toEqual({ kind: 'recent', title: '传输测试' });
  expect(before.tabs.length).toBeGreaterThan(0);
  expect(before.attached).toBeGreaterThan(0);
  expect(before.sites.always).toContain(A);

  await ctl('account', { value: 'second.user@example.test' });
  await ctl('rotate');
  await until(status, (v: any) => v.state === 'connected' && v.account === 'second.user@example.test');
  const after = await snapshot();
  expect(after).toEqual({ target: { kind: 'next' }, tabs: [], attached: 0, sites: { always: [], conversation: {} } });

  // AI 标签本身还在，只是不在 AI 标签组里了。
  const tab = await sw.evaluate((id) => chrome.tabs.get(id), before.tabs[0]);
  expect(tab.url).toBe(`${A}/form.html`);
  expect(tab.groupId).toBe(-1);

  // 同一账号再连一次（轮换）：不清。
  await grantA();
  const streamsBefore = (await ctl('state')).streamCount;
  await ctl('rotate');
  await until(() => ctl('state'), (s) => s.streamCount === streamsBefore + 1 && s.streamOpen, 5000);
  await until(status, (v: any) => v.state === 'connected');
  expect((await snapshot()).sites.conversation).toEqual({ [CONV]: [A] });
});

test('四通道只 POST、不带 X-Service 和 Cookie，全部用独立凭据', async () => {
  const st = await ctl('state');
  const channels = st.requests.filter((r: any) => PATHS.includes(r.path));
  expect(channels.length).toBeGreaterThan(5);
  for (const r of channels) {
    expect(r.method).toBe('POST');
    expect(r.xService).toBe(false);
    expect(r.cookie).toBe(false);
    expect(r.authenticated).toBe(true);
  }
  expect(channels.map((r: any) => r.path)).toEqual(expect.arrayContaining(PATHS));
});

test('closed revoked 立即清凭据、授权和标签归属，停止重连；退出也撤销服务端凭据', async () => {
  await ctl('revoke');
  const s = await until(status, (v: any) => v.state === 'waiting_login');
  expect(s).toMatchObject({ state: 'waiting_login', lastError: 'revoked' });
  const before = (await ctl('state')).streamCount;
  await expect.poll(() => sw.evaluate(async () => ({
    credential: !!(await chrome.storage.local.get('connection.credential'))['connection.credential'],
    tabs: await (globalThis as any).__bxTest.tabs.list('0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0'),
    attached: (globalThis as any).__bxTest.attachedCount(),
    sites: await (globalThis as any).__bxTest.sites.list(),
  }))).toEqual({ credential: false, tabs: [], attached: 0, sites: { always: [], conversation: {} } });
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect((await ctl('state')).streamCount).toBe(before);
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${EXT_ID}/popup.html`);
  await signIn(ctx, popup);
  const logouts = (await ctl('state')).logouts;
  await openTab(popup, 'settings');
  await popup.locator('#logout').click();
  await expect.poll(async () => (await status()).state).toBe('waiting_login');
  await expect.poll(async () => (await ctl('state')).logouts).toBe(logouts + 1);
  await popup.close();
});
