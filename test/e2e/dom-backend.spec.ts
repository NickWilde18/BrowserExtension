import { expect, test } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { A, B, allowSite, call, launch, refOf, sent, type Harness } from './helpers';
const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-test-dom');
let h: Harness;
test.beforeEach(async () => { h = await launch({ extensionDir: extension }); });
test.afterEach(async () => { await h.close(); });

async function sharedPage() {
  const page = await h.ctx.newPage();
  await page.goto(`${A}/form.html`);
  // 模型先请求读取再由用户共享，验证 active 为空时的真实恢复路径。
  expect((await call(h, 'read')).code).toBe('no_tab');
  const popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup.html`);
  await page.bringToFront();
  expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'popup:share' }))).toMatchObject({ ok: true });
  return page;
}

test('仅声明read；共享单文档后复用快照格式和ref，未声明动作明确拒绝', async () => {
  expect((await sent(h, 'hello'))[0].capabilities).toEqual({ actions: ['read'] });
  expect((await call(h, 'open', { url: `${A}/form.html` })).code).toBe('unsupported_action');
  const page = await sharedPage();
  const read = await call(h, 'read');
  expect(read.outcome, JSON.stringify(read)).toBe('ok');
  expect(read.page?.url).toBe(`${A}/form.html`);
  const snapshot = String(read.payload?.snapshot);
  expect(snapshot).toContain('textbox "Name"');
  const ref = refOf(snapshot, 'textbox "Name"');
  expect((await call(h, 'read', { ref, depth: 2, boxes: true })).outcome).toBe('ok');
  expect((await call(h, 'type', { element: 'Name', ref, text: 'must-not-run' })).code).toBe('unsupported_action');
  expect(await page.getByRole('textbox', { name: 'Name', exact: true }).inputValue()).toBe('');
  expect(await page.evaluate(() => typeof (globalThis as any).__browserRead)).toBe('undefined');
  expect(await h.sw.evaluate(() => (globalThis as any).__bxTest.attachedCount())).toBe(0);
});

test('frame页面或未授予来源权限时明确unsupported_page，不返回删减快照', async () => {
  const page = await sharedPage();
  await page.goto(`${A}/iframe.html`);
  const framed = await call(h, 'read');
  expect(framed.code).toBe('unsupported_page');
  expect(framed.payload?.snapshot).toBeUndefined();
  await allowSite(h, B);
  await page.goto(`${B}/form.html`);
  expect((await call(h, 'read')).code).toBe('unsupported_page');
});
