import { expect, test } from '@playwright/test';
import { A, B, CONV2, aiPage, allowSite, call, clickPanelButton, launch, openTab, type Harness } from './helpers';
let h: Harness;

test.beforeEach(async () => { h = await launch(); await allowSite(h, A); await allowSite(h, A, CONV2); });
test.afterEach(async () => { await h.close(); });

test('最后一页关闭后，可信popup可恢复指定对话，全局恢复不会越过对话接管', async () => {
  expect((await call(h, 'open', { url: `${A}/form.html` }, { title: '待恢复的任务' })).outcome).toBe('ok');
  const page = await aiPage(h, '/form.html');
  const panel = page.locator('#browser-assistant-controls');
  await expect(panel).toBeVisible();
  await clickPanelButton(page, panel);
  await expect(panel).toHaveAttribute('data-mode', 'user');
  await page.close();
  await h.sw.evaluate(async () => { await (globalThis as any).__bxTest.stop(); await (globalThis as any).__bxTest.resume(); });
  expect((await call(h, 'read')).code).toBe('user_stopped');
  const popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup.html`);
  await expect(popup.locator('#controlledConversations li')).toHaveCount(1, { timeout: 2000 });
  await expect(popup.locator('#controlledConversations')).toContainText('待恢复的任务');
  await openTab(popup, 'conv');
  await popup.locator('#controlledConversations button').click();
  expect((await call(h, 'open', { url: `${A}/form.html` })).outcome).toBe('ok');
  expect((await call(h, 'press_key', { key: 'Tab' })).code).toBe('action_failed');
  expect((await call(h, 'read')).outcome).toBe('ok');
});

test('普通用户页不注入；伪造控制消息被拒，保留网页但撤销归属后控制条移除', async () => {
  const user = await h.ctx.newPage();
  await user.goto(`${A}/landing.html`);
  expect((await call(h, 'open', { url: `${A}/form.html` })).outcome).toBe('ok');
  const page = await aiPage(h, '/form.html');
  await expect(page.locator('#browser-assistant-controls')).toBeVisible();
  await expect(user.locator('#browser-assistant-controls')).toHaveCount(0);
  const denied = await h.sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://127.0.0.1/*form.html' });
    const result = await chrome.scripting.executeScript({ target: { tabId: tab!.id!, frameIds: [0] },
      func: () => chrome.runtime.sendMessage({ type: 'panel:takeover', epoch: 'forged', token: 'forged' }) });
    return result[0]?.result;
  });
  expect(denied).toEqual({ ok: false });
  expect((await call(h, 'read')).outcome).toBe('ok');
  expect((await call(h, 'close', { keep_tabs: true })).outcome).toBe('ok');
  await expect(page.locator('#browser-assistant-controls')).toHaveCount(0);
  expect(page.isClosed()).toBe(false);
});

test('已授权给助手但未给注入权限的另一来源，不擅自安装控制条', async () => {
  await allowSite(h, B);
  expect((await call(h, 'open', { url: `${B}/form.html` })).outcome).toBe('ok');
  const page = await aiPage(h, '/form.html');
  expect(await h.sw.evaluate(() => chrome.permissions.contains({ origins: ['http://localhost/*'] }))).toBe(false);
  await expect(page.locator('#browser-assistant-controls')).toHaveCount(0);
  expect((await call(h, 'read')).outcome).toBe('ok');
});

test('归属页控制条确认对话级接管；恢复先观察、不重放动作，其他对话继续', async () => {
  expect((await call(h, 'open', { url: `${A}/form.html` })).outcome).toBe('ok');
  expect((await call(h, 'open', { url: `${A}/landing.html` }, { conversation: CONV2 })).outcome).toBe('ok');
  const page = await aiPage(h, '/form.html');
  const panel = page.locator('#browser-assistant-controls');
  await expect(panel).toBeVisible({ timeout: 2000 });
  // 控件位于关闭的 shadow root；用真实鼠标点击主按钮，不通过页面脚本伪造事件。
  const clickAction = () => clickPanelButton(page, panel);
  await clickAction();
  await expect(panel).toHaveAttribute('data-mode', 'user');
  expect(await h.sw.evaluate(() => (globalThis as any).__bxTest.attachedCount())).toBe(1);
  expect((await call(h, 'read')).code).toBe('user_stopped');
  expect((await call(h, 'read', {}, { conversation: CONV2 })).outcome).toBe('ok');
  await clickAction();
  await expect(panel).toHaveAttribute('data-mode', 'observing');
  expect((await call(h, 'press_key', { key: 'Tab' })).code).toBe('action_failed');
  expect((await call(h, 'read')).outcome).toBe('ok');
  expect((await call(h, 'press_key', { key: 'Tab' })).outcome).toBe('ok');
});
