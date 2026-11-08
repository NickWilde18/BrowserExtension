// 弹窗「共享此页」写明将共享给哪个对话（契约 3.2 的 conversation_title）。标题按纯文本显示，不当 HTML。
import { expect, test } from '@playwright/test';

import { A, CONV, CONV2, aiPage, allowSite, call, launch } from './helpers';
import type { Harness } from './helpers';

let h: Harness;

test.beforeEach(async () => {
  h = await launch();
});

test.afterEach(async () => {
  await h.close();
});

async function shareTarget(): Promise<{ text: string; html: string }> {
  const popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup.html`);
  const el = popup.locator('#shareTarget');
  await expect.poll(async () => (await el.textContent()) ?? '').not.toBe('');
  const out = { text: (await el.textContent()) ?? '', html: await el.innerHTML() };
  await popup.close();
  return out;
}

test('没有对话时引导先打开平台，不能把页面共享给未知的下一段对话', async () => {
  const popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup.html`);
  await expect(popup.locator('#openPlatform')).toBeVisible();
  await expect(popup.locator('#share')).toBeHidden();
  await expect(popup.locator('#pageExplanation')).toContainText('cannot be shared');
  expect(await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'popup:share' }))).toMatchObject({ ok: false });
});

test('最近用过浏览器的对话有标题：将共享给：<标题>，标题当纯文本', async () => {
  await call(h, 'tabs', { op: 'list' }, { title: '选课 <b>帮忙</b>' });
  const t = await shareTarget();
  expect(t.text).toBe('Will share with: 选课 <b>帮忙</b>');
  expect(t.html).not.toContain('<b>');

  // 换了一个对话用浏览器：跟着换。
  await call(h, 'tabs', { op: 'list' }, { conversation: CONV2, title: 'Second chat' });
  expect((await shareTarget()).text).toBe('Will share with: Second chat');
});

test('最近用过浏览器的对话标题为空：将共享给最近使用浏览器的对话', async () => {
  await call(h, 'tabs', { op: 'list' }, { title: '' });
  expect((await shareTarget()).text).toBe('Will share with the conversation that used the browser most recently');
});

test('同一站点长期授权和两段对话授权只提供一个移除入口，点击清除全部范围', async () => {
  await allowSite(h, A, CONV);
  await allowSite(h, A, CONV2);
  await h.sw.evaluate((site) => (globalThis as any).__bxTest.sites.grant('any', site, 'always'), A);
  const popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup.html`);
  await expect(popup.locator('#sites .site-group')).toHaveCount(1);
  await expect(popup.locator('#sites .grant-row')).toHaveCount(3);
  await expect(popup.locator('#sites button')).toHaveCount(1);
  await popup.locator('#sites button').click();
  await expect(popup.locator('#siteCount')).toHaveText('0');
  expect(await h.sw.evaluate(() => (globalThis as any).__bxTest.sites.list())).toEqual({ always: [], conversation: {} });
});

test('助手打开的页面可以取消访问，网页保留并移除控制条', async () => {
  await allowSite(h, A);
  await call(h, 'open', { url: `${A}/form.html` }, { title: 'Synthetic task' });
  const page = await aiPage(h, '/form.html');
  const popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup.html`);
  await h.sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ url: '*://127.0.0.1/*form.html' });
    await chrome.tabs.update(tab!.id!, { active: true });
  });
  await expect(popup.locator('#sharedRow')).toBeVisible();
  await expect(popup.locator('#sharedOwner')).toHaveText('Synthetic task');
  // 页面消息由真实插件页发出；点击会把 popup 标签激活，所以在其后台执行消息来保持原网页为当前页。
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'popup:unshare' }));
  await expect(page.locator('#browser-assistant-controls')).toHaveCount(0);
  expect(page.isClosed()).toBe(false);
  expect(await h.sw.evaluate((conversation) => (globalThis as any).__bxTest.tabs.list(conversation), CONV)).toEqual([]);
});
