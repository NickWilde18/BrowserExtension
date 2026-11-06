// 弹窗「共享此页」写明将共享给哪个对话（契约 3.2 的 conversation_title）。标题按纯文本显示，不当 HTML。
import { expect, test } from '@playwright/test';

import { CONV2, call, launch } from './helpers';
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

test('还没有对话用过浏览器：将共享给下一个使用浏览器的对话', async () => {
  expect((await shareTarget()).text).toBe('Will share with the next conversation that uses the browser');
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
