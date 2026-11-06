// 新开标签与动作之外的下载：AI 动作引起的新标签导航与同标签跨站跳转同一套把关；AI 标签里的下载一律不落进下载目录。
import { expect, test } from '@playwright/test';

import { A, B, CONV, aiPage, allowSite, answer, approvalWindow, call, launch, refOf, result, send } from './helpers';
import type { Harness } from './helpers';

let h: Harness;

test.beforeEach(async () => {
  await fetch(`${A}/__reset`);
  h = await launch();
  await allowSite(h, A);
});

test.afterEach(async () => {
  await h.close();
});

async function hitsOnB(): Promise<number> {
  const stats = await (await fetch(`${A}/__stats`)).json() as Record<string, number>;
  return stats[`${new URL(B).host} /landing.html`] ?? 0;
}

async function snapshot(): Promise<string> {
  const r = await call(h, 'read');
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  return String(r.payload?.snapshot ?? '');
}

const tabCount = () => h.ctx.pages().filter((p) => !p.url().includes('/approval.html')).length;

for (const [name, needle] of [
  ['target=_blank 的链接', 'Open elsewhere'],
  ['点击触发 window.open', 'button "Pop up"'],
  ['target=_blank 的表单', 'button "Send away"'],
] as const) {
  test(`新开标签（${name}）去没授权的站点：先问，拒绝就一个请求都不发、不多开标签`, async () => {
    await call(h, 'open', { url: `${A}/newtab.html` });
    const snap = await snapshot();
    const before = tabCount();

    const id = await send(h, 'click', { element: name, ref: refOf(snap, needle) });
    const win = await approvalWindow(h);
    expect(await win.locator('#site').textContent()).toBe(B);
    await answer(h, 'Deny');
    const r = await result(h, id);
    expect(r.code, JSON.stringify(r)).toBe('user_denied');
    expect(r.page?.url).toBe(`${A}/newtab.html`);
    expect(await hitsOnB()).toBe(0);
    await new Promise((res) => setTimeout(res, 500));
    expect(tabCount()).toBe(before);
    expect(await hitsOnB()).toBe(0);
  });
}

test('新开标签：允许后在本 AI 标签里打开，之后照常能操作', async () => {
  await call(h, 'open', { url: `${A}/newtab.html` });
  const snap = await snapshot();
  const before = tabCount();

  const id = await send(h, 'click', { element: 'Pop up', ref: refOf(snap, 'button "Pop up"') });
  await answer(h, 'This conversation only');
  const r = await result(h, id);
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  expect(r.page?.url).toBe(`${B}/landing.html?via=open`);
  expect(tabCount()).toBe(before);
  const tabs = await call(h, 'tabs', { op: 'list' });
  expect(tabs.payload?.tabs).toEqual([expect.objectContaining({ active: true, url: `${B}/landing.html?via=open` })]);
  expect((await call(h, 'read')).outcome).toBe('ok');

  // 同站的新开标签链接：已授权的站点，不弹窗，同样留在本标签。
  await call(h, 'navigate', { direction: 'back' });
  const snap2 = await snapshot();
  const same = await call(h, 'click', { element: 'Open here', ref: refOf(snap2, 'Open here in a new tab') });
  expect(same.outcome, JSON.stringify(same)).toBe('ok');
  expect(same.page?.url).toBe(`${A}/landing.html?via=same`);
  expect(tabCount()).toBe(before);
});

test('动作之外：用户自己在 AI 标签里点新开标签的链接照常打开新标签，插件不附着它', async () => {
  await call(h, 'open', { url: `${A}/newtab.html` });
  const page = await aiPage(h, '/newtab.html');
  const popup = h.ctx.waitForEvent('page');
  await page.click('#blank');
  const p = await popup;
  await p.waitForLoadState();
  expect(p.url()).toBe(`${B}/landing.html?via=link`);
  expect(await h.sw.evaluate(() => (globalThis as any).__bxTest.attachedCount())).toBe(1);
  const list = await call(h, 'tabs', { op: 'list' });
  expect(list.payload?.tabs).toHaveLength(1);
});

test('动作结束之后 AI 标签里触发的下载：取消、不落进下载目录，下一个结果里告诉模型', async () => {
  await call(h, 'open', { url: `${A}/newtab.html` });
  const snap = await snapshot();
  const r = await call(h, 'click', { element: 'Download later', ref: refOf(snap, 'button "Download later"') });
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  expect(r.message).toBeUndefined();

  await new Promise((res) => setTimeout(res, 3000));
  expect(await h.sw.evaluate(() => chrome.downloads.search({}))).toHaveLength(0);
  expect(h.ctx.pages().some((x) => x.url().includes('/approval.html'))).toBe(false);

  const next = await call(h, 'read');
  expect(next.outcome).toBe('ok');
  expect(next.message).toContain('report-2026.txt');
  expect(next.message).toContain(A);
  // 只说一次。
  expect((await call(h, 'read')).message).toBeUndefined();
});

test('用户自己在 AI 标签之外的下载照常', async () => {
  await call(h, 'open', { url: `${A}/newtab.html` });
  const mine = await h.ctx.newPage();
  await mine.goto(`${A}/download.html`);
  const dl = mine.waitForEvent('download');
  await mine.click('#att');
  const download = await dl;
  // 下载成功（被插件取消的话 failure() 是 canceled）。Playwright 接管下载、按随机名存，文件名不看。
  await download.path();
  expect(await download.failure()).toBeNull();
  expect(download.suggestedFilename()).toBe('report-2026.txt');
  const items = await h.sw.evaluate(() => chrome.downloads.search({}));
  expect(items.some((i: chrome.downloads.DownloadItem) => i.state === 'complete' && i.url.endsWith('/files/report.txt'))).toBe(true);
  expect((await call(h, 'read', {}, { conversation: CONV })).message).toBeUndefined();
});
