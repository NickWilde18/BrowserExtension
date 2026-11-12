// 把关流程：站点授权、跨站跳转拦截、逐次确认（密码框、上传、下载、脚本）、Auto Mode 下的审批帧。
import { expect, test } from '@playwright/test';

import { A, B, CONV2, actOnPrompt, aiPage, allowSite, answer, approvalWindow, call, launch, refOf, result, send, sent } from './helpers';
import type { Harness } from './helpers';

let h: Harness;

test.afterEach(async () => {
  await h?.close();
});

/** 夹具服务收到的 B 站 /landing.html 请求次数（用例开头先 resetHits 清零）。 */
async function landingHitsOnB(): Promise<number> {
  const stats = await (await fetch(`${A}/__stats`)).json() as Record<string, number>;
  return stats[`${new URL(B).host} /landing.html`] ?? 0;
}

async function resetHits(): Promise<void> {
  await fetch(`${A}/__reset`);
}

async function snapshot(): Promise<string> {
  const r = await call(h, 'read');
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  return String(r.payload?.snapshot ?? '');
}

test('确认窗：产品身份、页面标题和图标明确，默认键盘焦点在拒绝', async () => {
  h = await launch({ realViewport: true });
  const pending = call(h, 'open', { url: `${A}/form.html` }, { title: '课程 <b>报名</b>' });
  const win = await approvalWindow(h);
  await expect(win).toHaveTitle(/Allow the assistant to access this site\? · AI Services Platform/);
  await expect(win.locator('header')).toContainText('AI Services Platform');
  expect(await win.locator('header img').evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
  const icon = await win.locator('link[rel="icon"]').getAttribute('href');
  expect(icon).toBeTruthy();
  expect(await win.evaluate(async (href) => (await fetch(href!)).ok, icon)).toBe(true);
  await expect(win.locator('#site')).toHaveText(A);
  await expect(win.locator('#conversation')).toHaveText('课程 <b>报名</b>');
  expect(await win.locator('#conversation').innerHTML()).not.toContain('<b>');
  await expect(win.getByRole('button', { name: 'Decline', exact: true })).toBeFocused();
  await actOnPrompt(win, () => win.keyboard.press('Enter'));
  expect((await pending).code).toBe('user_denied');
});

for (const closeBy of ['button', 'Escape'] as const) {
  test(`确认窗：${closeBy} 关闭只拒绝当前动作，不全局停止浏览器`, async () => {
    h = await launch({ realViewport: true });
    await allowSite(h, A);
    await call(h, 'open', { url: `${A}/form.html` });
    const id = await send(h, 'open', { url: `${B}/landing.html` });
    const win = await approvalWindow(h);
    await expect(win.locator('#conversationRow')).toBeHidden();
    if (closeBy === 'button') {
      await actOnPrompt(win, () => win.getByRole('button', { name: 'Close and decline this request' }).click({ timeout: 2000 }));
    } else {
      await actOnPrompt(win, () => win.keyboard.press('Escape'));
    }

    await expect.poll(() => win.isClosed(), { timeout: 2000 }).toBe(true);
    expect((await result(h, id)).code).toBe('user_denied');
    expect((await h.sw.evaluate(() => (globalThis as any).__bxTest.popupState())).stopped).toBe(false);
    expect((await call(h, 'read')).outcome).toBe('ok');
  });
}

test('确认窗：短内容收紧窗口，长脚本可滚动阅读且按钮始终可达', async () => {
  h = await launch({ realViewport: true });
  const id = await send(h, 'open', { url: `${A}/form.html` });
  const win = await approvalWindow(h);
  await expect.poll(() => win.evaluate(() => innerHeight - document.querySelector('main')!.getBoundingClientRect().height)).toBeLessThan(40);
  await answer(h, 'Allow');
  expect((await result(h, id)).outcome).toBe('ok');

  const source = `() => {\n${'  // Read this line before deciding.\n'.repeat(80)}  return 1;\n}`;
  const script = await send(h, 'evaluate', { function: source });
  const long = await approvalWindow(h);
  await expect(long.locator('pre')).toHaveText(source);
  await expect(long.locator('#scriptBox')).not.toHaveAttribute('open');
  await long.locator('#scriptBox summary').click();
  const code = long.getByRole('region', { name: 'Script to run' });
  await expect(code).toHaveAttribute('tabindex', '0');
  expect(await code.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await code.focus();
  await long.keyboard.press('Control+End');
  await expect.poll(() => code.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const deny = long.getByRole('button', { name: 'Decline', exact: true });
  await deny.focus();
  expect(await deny.evaluate((el) => el.getBoundingClientRect().bottom <= innerHeight)).toBe(true);
  expect(await long.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await actOnPrompt(long, () => long.keyboard.press('Enter'));
  expect((await result(h, script)).code).toBe('user_denied');
});

test('确认窗：浅深主题均有明确底色与可读文字，窄窗口不横向溢出', async () => {
  h = await launch();
  const id = await send(h, 'open', { url: `${A}/form.html` });
  const win = await approvalWindow(h);
  const colors = [];
  for (const colorScheme of ['light', 'dark'] as const) {
    await win.emulateMedia({ colorScheme });
    colors.push(await win.evaluate(() => {
      const css = getComputedStyle(document.body);
      return { background: css.backgroundColor, text: css.color };
    }));
  }

  expect(colors[0]!.background).not.toBe('rgba(0, 0, 0, 0)');
  expect(colors[1]!.background).not.toBe(colors[0]!.background);
  expect(colors[1]!.text).not.toBe(colors[0]!.text);
  await win.setViewportSize({ width: 320, height: 560 });
  expect(await win.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await answer(h, 'Decline');
  expect((await result(h, id)).code).toBe('user_denied');
});

test('站点授权：仅本次对话；同一对话不再问，别的对话还要问', async () => {
  h = await launch();
  const id = await send(h, 'open', { url: `${A}/form.html` });
  const win = await approvalWindow(h);
  expect(await win.locator('#site').textContent()).toBe(A);
  await answer(h, 'Allow');
  const r = await result(h, id);
  expect(r.outcome, JSON.stringify(r)).toBe('ok');

  // 等用户时发了 awaiting_user，点完发了 working。
  const progress = (await sent(h, 'progress')).filter((f) => f.request_id === id);
  expect(progress.map((f) => f.stage)).toEqual(['awaiting_user', 'working']);
  expect(progress[0].kind).toBe('site');

  const again = await call(h, 'open', { url: `${A}/landing.html` });
  expect(again.outcome).toBe('ok');
  expect((await sent(h, 'progress')).filter((f) => f.request_id !== id)).toHaveLength(0);

  const other = await send(h, 'open', { url: `${A}/form.html` }, { conversation: CONV2 });
  await answer(h, 'Decline');
  const denied = await result(h, other);
  expect(denied.code).toBe('user_denied');
});

test('站点授权：总是允许，换对话也不问；弹窗里能撤销', async () => {
  h = await launch();
  const id = await send(h, 'open', { url: `${A}/form.html` });
  await answer(h, 'Always allow this site');
  expect((await result(h, id)).outcome).toBe('ok');

  const other = await call(h, 'open', { url: `${A}/landing.html` }, { conversation: CONV2 });
  expect(other.outcome).toBe('ok');

  const state = await h.sw.evaluate(() => (globalThis as any).__bxTest.popupState());
  expect(state.sites.always).toEqual([A]);

  // 弹窗页面里点撤销。
  const popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup.html`);
  await popup.locator('#sites button').first().click();
  await expect.poll(async () => (await h.sw.evaluate(() => (globalThis as any).__bxTest.popupState())).sites.always).toEqual([]);
});

test('站点授权：拒绝不开标签；超时回 approval_timeout', async () => {
  h = await launch();
  const id = await send(h, 'open', { url: `${A}/form.html` });
  await answer(h, 'Decline');
  const r = await result(h, id);
  expect(r.code).toBe('user_denied');
  expect((await call(h, 'tabs', { op: 'list' })).payload?.tabs).toEqual([]);

  const slow = await send(h, 'open', { url: `${A}/form.html` }, { authWaitMs: 1500 });
  await approvalWindow(h);
  const t = await result(h, slow);
  expect(t.code).toBe('approval_timeout');
  expect(t.message).toContain('in time');
  const expiredWindow = h.ctx.pages().find((p) => p.url().includes('/approval.html'))!;
  await expect(expiredWindow.locator('#title')).toHaveText('Confirmation expired');
  await actOnPrompt(expiredWindow, () => expiredWindow.locator('#buttons button').click());
  await expect.poll(() => h.ctx.pages().filter((p) => p.url().includes('/approval.html')).length).toBe(0);
});

test('跨站跳转：点链接去没授权的站点先问，拒绝就不跳', async () => {
  await resetHits();
  h = await launch();
  await allowSite(h, A);
  await call(h, 'open', { url: `${A}/crosssite.html` });
  const snap = await snapshot();

  const id = await send(h, 'click', { element: 'Other site', ref: refOf(snap, 'Other site') });
  const win = await approvalWindow(h);
  expect(await win.locator('#site').textContent()).toBe(B);
  await answer(h, 'Decline');
  const r = await result(h, id);
  expect(r.code, JSON.stringify(r)).toBe('user_denied');
  expect(r.page?.url).toBe(`${A}/crosssite.html`);
  // 请求根本没发到那个站点（不是先发出去再回来）。
  expect(await landingHitsOnB()).toBe(0);

  const id2 = await send(h, 'click', { element: 'Other site', ref: refOf(snap, 'Other site') });
  await answer(h, 'Allow');
  const ok = await result(h, id2);
  expect(ok.outcome, JSON.stringify(ok)).toBe('ok');
  expect(ok.page?.url).toBe(`${B}/landing.html`);
});

test('跨站跳转：同站链接重定向到别的站点也拦', async () => {
  await resetHits();
  h = await launch();
  await allowSite(h, A);
  await call(h, 'open', { url: `${A}/crosssite.html` });
  const snap = await snapshot();
  const id = await send(h, 'click', { element: 'Redirect away', ref: refOf(snap, 'Redirect away') });
  const win = await approvalWindow(h);
  expect(await win.locator('#site').textContent()).toBe(B);
  await answer(h, 'Decline');
  const r = await result(h, id);
  expect(r.code).toBe('user_denied');
  expect(r.page?.url).toBe(`${A}/crosssite.html`);
  expect(await landingHitsOnB()).toBe(0);
});

test('密码框：允许 / 我自己输入 / 拒绝', async () => {
  h = await launch();
  await allowSite(h, A);
  await call(h, 'open', { url: `${A}/form.html` });
  const snap = await snapshot();
  const pw = refOf(snap, 'textbox "Password"');
  const page = await aiPage(h, '/form.html');

  const id = await send(h, 'type', { element: 'Password', ref: pw, text: 's3cret' });
  const win = await approvalWindow(h);
  expect(await win.locator('#facts').textContent()).toContain('Password');
  await answer(h, 'Allow');
  const r = await result(h, id);
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  expect(r.payload?.password_field).toBe(true);
  expect(await page.locator('#pw').inputValue()).toBe('s3cret');
  // 审批请求里只有字段名，没有密码。
  const ar = (await sent(h, 'approval_request')).find((f) => f.request_id === id);
  expect(ar).toMatchObject({ kind: 'password', site: A, detail: { field: 'Password' } });
  expect(JSON.stringify(ar)).not.toContain('s3cret');

  const self = await send(h, 'type', { element: 'Password', ref: pw, text: 'ignored' });
  await answer(h, 'Enter it myself');
  const w2 = await approvalWindow(h);
  await w2.locator('#buttons button', { hasText: 'Input complete' }).waitFor();
  await page.locator('#pw').fill('typed-by-user');
  await actOnPrompt(w2, () => w2.locator('#buttons button', { hasText: 'Input complete' }).click());
  const sr = await result(h, self);
  expect(sr.outcome, JSON.stringify(sr)).toBe('ok');
  expect(sr.message).toContain('themselves');
  expect(await page.locator('#pw').inputValue()).toBe('typed-by-user');

  const no = await send(h, 'type', { element: 'Password', ref: pw, text: 'nope' });
  await answer(h, 'Decline');
  expect((await result(h, no)).code).toBe('user_denied');
  expect(await page.locator('#pw').inputValue()).toBe('typed-by-user');
});

async function stageUpload(token: string, bytes: number[], type: string): Promise<void> {
  await h.sw.evaluate(({ token, bytes, type }) => {
    (globalThis as any).__bxTest.server.uploads.set(token, { data: new Uint8Array(bytes), type });
  }, { token, bytes, type });
}

test('上传：可见的文件框、藏在按钮后面的文件框；拒绝不放文件', async () => {
  h = await launch();
  await allowSite(h, A);
  await call(h, 'open', { url: `${A}/upload.html` });
  const snap = await snapshot();
  const page = await aiPage(h, '/upload.html');
  const content = Array.from({ length: 2000 }, (_, i) => i % 251);
  const sum = content.reduce((s, b) => (s + b) % 65521, 0);
  await stageUpload('t1', content, 'application/pdf');
  await stageUpload('t2', [104, 105], 'text/plain');

  const id = await send(h, 'upload', {
    element: 'Attachment', ref: refOf(snap, 'Attachment'),
    files: [{ token: 't1', name: '报告.pdf', size: 2000, content_type: 'application/pdf' }, { token: 't2', name: 'a.txt', size: 2, content_type: 'text/plain' }],
  });
  const win = await approvalWindow(h);
  expect(await win.locator('#facts').textContent()).toContain('报告.pdf');
  await answer(h, 'Allow');
  const r = await result(h, id);
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  expect(r.payload?.uploaded).toEqual([{ name: '报告.pdf', size: 2000 }, { name: 'a.txt', size: 2 }]);
  await expect.poll(() => page.locator('#out').textContent()).toContain(`visible:报告.pdf:2000:application/pdf:${sum}`);
  expect(await page.locator('#out').textContent()).toContain('visible:a.txt:2:text/plain');

  // 藏起来的文件框：点按钮，插件拦下文件选择框，拿到背后的文件框。
  await stageUpload('t3', [1, 2, 3], 'image/png');
  const id2 = await send(h, 'upload', {
    element: 'Choose a photo', ref: refOf(snap, 'button "Choose a photo"'),
    files: [{ token: 't3', name: 'p.png', size: 3, content_type: 'image/png' }],
  });
  await answer(h, 'Allow');
  const r2 = await result(h, id2);
  expect(r2.outcome, JSON.stringify(r2)).toBe('ok');
  await expect.poll(() => page.locator('#out').textContent()).toContain('hidden:p.png:3:image/png:6');

  await stageUpload('t4', [9], 'text/plain');
  const no = await send(h, 'upload', {
    element: 'Attachment', ref: refOf(snap, 'Attachment'),
    files: [{ token: 't4', name: 'x.txt', size: 1, content_type: 'text/plain' }],
  });
  await answer(h, 'Decline');
  expect((await result(h, no)).code).toBe('user_denied');
  expect(await page.locator('#out').textContent()).not.toContain('x.txt');
});

test('下载：允许后存成交付文件、不进下载目录；拒绝回 download_denied', async () => {
  h = await launch();
  await allowSite(h, A);
  await call(h, 'open', { url: `${A}/download.html` });
  const snap = await snapshot();

  const id = await send(h, 'click', { element: 'Get the report', ref: refOf(snap, 'Get the report') });
  const win = await approvalWindow(h);
  expect(await win.locator('#facts').textContent()).toContain('report-2026.txt');
  // 文件区有可见的小标签，列表能按无障碍名称识别，文件名与大小清楚分行；写明文件交给对话、不进下载目录。
  await expect(win.locator('#facts .label', { hasText: 'File' })).toBeVisible({ timeout: 2000 });
  await expect(win.locator('#facts')).toContainText('not to your downloads folder');
  await expect(win.getByRole('list', { name: 'File', exact: true })).toContainText('26 B · text/plain');
  await answer(h, 'Allow');
  const r = await result(h, id);
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  const file = r.payload?.files?.[0];
  expect(file).toMatchObject({ kind: 'download', name: 'report-2026.txt', content_type: 'text/plain', size: 26 });
  const stored = await h.sw.evaluate(() => (globalThis as any).__bxTest.server.files);
  expect(Buffer.from(stored.at(-1).base64, 'base64').toString()).toBe('quarterly report\nline two\n');
  const left = await h.sw.evaluate(() => chrome.downloads.search({}));
  expect(left).toHaveLength(0);

  const id2 = await send(h, 'click', { element: 'Get the table', ref: refOf(snap, 'Get the table') });
  await answer(h, 'Decline');
  const d = await result(h, id2);
  expect(d.outcome, JSON.stringify(d)).toBe('ok');
  expect(d.payload?.download_denied).toBe(true);
  expect(await h.sw.evaluate(() => chrome.downloads.search({}))).toHaveLength(0);
});

test('下载：<a download>（页面里重新取）、跨源的文件地址与表单 POST 导出（响应阶段截下）', async () => {
  h = await launch();
  await allowSite(h, A);
  await allowSite(h, B);
  await call(h, 'open', { url: `${A}/download.html` });
  const snap = await snapshot();
  const stored = async () => h.sw.evaluate(() => (globalThis as any).__bxTest.server.files.at(-1));

  const viaAttr = await send(h, 'click', { element: 'Get the table', ref: refOf(snap, 'Get the table') });
  await answer(h, 'Allow');
  const r1 = await result(h, viaAttr);
  expect(r1.outcome, JSON.stringify(r1)).toBe('ok');
  expect(r1.payload?.files?.[0]).toMatchObject({ kind: 'download', name: 'table.csv' });
  expect(Buffer.from((await stored()).base64, 'base64').toString()).toBe('a,b\n1,2\n');

  const cross = await send(h, 'click', { element: 'Get the mirrored report', ref: refOf(snap, 'Get the mirrored report') });
  await answer(h, 'Allow');
  const r2 = await result(h, cross);
  expect(r2.outcome, JSON.stringify(r2)).toBe('ok');
  expect(r2.payload?.files?.[0]).toMatchObject({ kind: 'download', name: 'report-2026.txt' });
  expect(r2.page?.url).toBe(`${A}/download.html`);

  const post = await send(h, 'click', { element: 'Export', ref: refOf(snap, 'button "Export"') });
  await answer(h, 'Allow');
  const r3 = await result(h, post);
  expect(r3.outcome, JSON.stringify(r3)).toBe('ok');
  expect(r3.payload?.files?.[0]).toMatchObject({ kind: 'download', name: 'export.csv', content_type: 'text/csv' });
  expect(Buffer.from((await stored()).base64, 'base64').toString()).toBe('posted,q=2026\n');
  expect(r3.page?.url).toBe(`${A}/download.html`);
  expect(await h.sw.evaluate(() => chrome.downloads.search({}))).toHaveLength(0);
});

test('脚本：每次确认，显示全文；允许后在页面主世界执行，可带元素', async () => {
  h = await launch();
  await allowSite(h, A);
  await call(h, 'open', { url: `${A}/form.html` });
  const snap = await snapshot();

  const id = await send(h, 'evaluate', { function: '() => document.title + ":" + typeof window.someGlobal' });
  const win = await approvalWindow(h);
  expect(await win.locator('pre').textContent()).toContain('document.title');
  await answer(h, 'Allow');
  const r = await result(h, id);
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  expect(r.payload?.value).toBe('"Form:undefined"');

  const id2 = await send(h, 'evaluate', { function: '(el) => el.tagName', element: 'Submit', ref: refOf(snap, 'button "Submit"') });
  await answer(h, 'Allow');
  expect((await result(h, id2)).payload?.value).toBe('"BUTTON"');

  const id3 = await send(h, 'evaluate', { function: '() => { throw new Error("boom") }' });
  await answer(h, 'Allow');
  const e = await result(h, id3);
  expect(e.code).toBe('action_failed');
  expect(e.message).toContain('boom');

  const id4 = await send(h, 'evaluate', { function: '() => 1' });
  await answer(h, 'Decline');
  expect((await result(h, id4)).code).toBe('user_denied');
});

test('Auto Mode：审查放行就不弹小窗', async () => {
  h = await launch({ autoApproval: 'allow' });
  const r = await call(h, 'open', { url: `${A}/form.html` });
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  expect(h.ctx.pages().some((p) => p.url().includes('/approval.html'))).toBe(false);
  const ar = await sent(h, 'approval_request');
  expect(ar).toHaveLength(1);
  expect(ar[0]).toMatchObject({ kind: 'site', site: A, detail: {} });
  expect(await sent(h, 'progress')).toHaveLength(0);
});

test('Auto Mode：审查拦下时小窗显示理由，由用户定', async () => {
  h = await launch({ autoApproval: 'block' });
  const id = await send(h, 'open', { url: `${A}/form.html` });
  const win = await approvalWindow(h);
  await expect(win.locator('#review')).toBeVisible();
  expect(await win.locator('#reviewReason').textContent()).toBe('test reason');
  await answer(h, 'Allow');
  expect((await result(h, id)).outcome).toBe('ok');
});

test('审批只认 Chat：本机旧关闭设置不影响请求，ask_user 仍需插件确认', async () => {
  h = await launch({ autoApproval: 'ask_user' });
  // 模拟升级前保存的本机开关；新版本不得读取它绕过对话档位。
  await h.sw.evaluate(() => chrome.storage.local.set({ 'settings.autoMode': false }));
  const id = await send(h, 'open', { url: `${A}/form.html` });
  const win = await approvalWindow(h);
  await expect(win.locator('#buttons')).toBeVisible();
  expect(await sent(h, 'approval_request')).toHaveLength(1);
  await answer(h, 'Allow');
  expect((await result(h, id)).outcome).toBe('ok');
});

test('Auto Mode：Chat 迟迟不回审批，15 秒后回到小窗', async () => {
  test.setTimeout(60_000);
  h = await launch({ autoApproval: 'none' });
  const id = await send(h, 'open', { url: `${A}/form.html` });
  const t0 = Date.now();
  await approvalWindow(h);
  expect(Date.now() - t0).toBeGreaterThan(14_000);
  await answer(h, 'Allow');
  expect((await result(h, id)).outcome).toBe('ok');
});

test('叫停：弹窗「停止」后请求回 user_stopped，「恢复」后照常', async () => {
  h = await launch();
  await allowSite(h, A);
  await call(h, 'open', { url: `${A}/form.html` });
  await h.sw.evaluate(() => (globalThis as any).__bxTest.stop());
  const r = await call(h, 'read');
  expect(r.code).toBe('user_stopped');
  await h.sw.evaluate(() => (globalThis as any).__bxTest.resume());
  const ok = await call(h, 'read');
  expect(ok.outcome).toBe('ok');
});
