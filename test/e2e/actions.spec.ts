// 22 个动作在真浏览器里跑（站点预先授权，把关流程见 approvals.spec.ts）。
import { expect, test } from '@playwright/test';

import { A, B, CONV2, aiPage, allowSite, call, launch, refOf, sent } from './helpers';
import type { Harness } from './helpers';

let h: Harness;

test.beforeEach(async () => {
  h = await launch();
  await allowSite(h, A);
});

test.afterEach(async () => {
  await h.close();
});

async function snapshot(): Promise<string> {
  const r = await call(h, 'read');
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  return String(r.payload?.snapshot ?? '');
}

test('navigate：后退、前进、刷新', async () => {
  await call(h, 'open', { url: `${A}/crosssite.html` });
  const r1 = await call(h, 'click', { element: 'Same site', ref: refOf(await snapshot(), 'Same site') });
  expect(r1.outcome, JSON.stringify(r1)).toBe('ok');
  expect(r1.page?.url).toBe(`${A}/landing.html`);

  const back = await call(h, 'navigate', { direction: 'back' });
  expect(back.page?.url).toBe(`${A}/crosssite.html`);
  const fwd = await call(h, 'navigate', { direction: 'forward' });
  expect(fwd.page?.url).toBe(`${A}/landing.html`);
  const reload = await call(h, 'navigate', { direction: 'reload' });
  expect(reload.outcome).toBe('ok');
  expect(reload.page?.title).toBe('Landing');

  const none = await call(h, 'navigate', { direction: 'forward' });
  expect(none.code).toBe('action_failed');
});

test('tabs：list、new、select、close；close 关掉 AI 开的标签', async () => {
  await call(h, 'open', { url: `${A}/form.html` });
  const nt = await call(h, 'tabs', { op: 'new', url: `${A}/landing.html` });
  expect(nt.outcome, JSON.stringify(nt)).toBe('ok');
  expect(nt.payload?.tabs).toHaveLength(2);
  expect(nt.payload?.tabs[1]).toMatchObject({ index: 1, active: true, title: 'Landing' });

  const sel = await call(h, 'tabs', { op: 'select', index: 0 });
  expect(sel.page?.title).toBe('Form');

  const missing = await call(h, 'tabs', { op: 'select', index: 5 });
  expect(missing.code).toBe('no_tab');

  const closed = await call(h, 'tabs', { op: 'close', index: 1 });
  expect(closed.payload?.tabs).toHaveLength(1);

  const done = await call(h, 'close');
  expect(done.outcome).toBe('ok');
  expect(done.payload).toMatchObject({ closed_tabs: 1 });
  expect(h.ctx.pages().some((p) => p.url().includes('/form.html'))).toBe(false);

  const after = await call(h, 'read');
  expect(after.code).toBe('no_tab');
});

test('close keep_tabs：只断开附着、标签留下', async () => {
  await call(h, 'open', { url: `${A}/form.html` });
  const done = await call(h, 'close', { keep_tabs: true });
  expect(done.payload).toMatchObject({ detached: 1, closed_tabs: 0 });
  expect(h.ctx.pages().some((p) => p.url().includes('/form.html'))).toBe(true);
});

test('不同对话各开各的标签组', async () => {
  await allowSite(h, A, CONV2);
  await call(h, 'open', { url: `${A}/form.html` });
  await call(h, 'open', { url: `${A}/landing.html` }, { conversation: CONV2 });
  const l1 = await call(h, 'tabs', { op: 'list' });
  const l2 = await call(h, 'tabs', { op: 'list' }, { conversation: CONV2 });
  expect(l1.payload?.tabs).toHaveLength(1);
  expect(l1.payload?.tabs[0].title).toBe('Form');
  expect(l2.payload?.tabs[0].title).toBe('Landing');
});

test('find：按文字与正则找元素', async () => {
  await call(h, 'open', { url: `${A}/form.html` });
  const byText = await call(h, 'find', { text: 'submit' });
  expect(byText.outcome, JSON.stringify(byText)).toBe('ok');
  expect(byText.payload?.matches.some((m: any) => m.role === 'button')).toBe(true);
  // 每个命中都真含这段文字（不是把整页都当成命中）。
  const agree = await call(h, 'find', { text: 'I agree' });
  expect(agree.payload?.total).toBeGreaterThan(0);
  expect(agree.payload?.matches.every((m: any) => `${m.name} ${m.text}`.toLowerCase().includes('i agree'))).toBe(true);
  const byRe = await call(h, 'find', { regex: '^I agree$' });
  expect(byRe.outcome, JSON.stringify(byRe)).toBe('ok');
  expect(byRe.payload?.total).toBeGreaterThan(0);
  expect(byRe.payload?.matches.every((m: any) => /^I agree$/.test(m.name) || /^I agree$/.test(m.text))).toBe(true);
  const bad = await call(h, 'find', { text: 'x', regex: 'y' });
  expect(bad.code).toBe('invalid_args');
});

test('click / hover / type / select / fill_form', async () => {
  await call(h, 'open', { url: `${A}/form.html` });
  const snap = await snapshot();

  const typed = await call(h, 'type', { element: 'Name', ref: refOf(snap, 'textbox "Name"'), text: '张三 Zhang' });
  expect(typed.outcome, JSON.stringify(typed)).toBe('ok');
  const page = await aiPage(h, '/form.html');
  expect(await page.locator('#name').inputValue()).toBe('张三 Zhang');

  // 再输一次是替换，不是追加。
  await call(h, 'type', { element: 'Name', ref: refOf(snap, 'textbox "Name"'), text: 'Li', slowly: true });
  expect(await page.locator('#name').inputValue()).toBe('Li');

  const sel = await call(h, 'select', { element: 'Fruits', ref: refOf(snap, 'listbox "Fruits"'), values: ['Pear', 'Plum'] });
  expect(sel.outcome, JSON.stringify(sel)).toBe('ok');
  expect(await page.locator('#fruits').evaluate((e: HTMLSelectElement) => [...e.selectedOptions].map((o) => o.value))).toEqual(['Pear', 'Plum']);

  const bad = await call(h, 'select', { element: 'Color', ref: refOf(snap, 'combobox "Color"'), values: ['Purple'] });
  expect(bad.code).toBe('action_failed');

  const form = await call(h, 'fill_form', {
    fields: [
      { element: 'Bio', ref: refOf(snap, 'textbox "Bio"'), type: 'textbox', value: 'hello\nworld' },
      { element: 'Color', ref: refOf(snap, 'combobox "Color"'), type: 'combobox', value: 'Blue' },
      { element: 'I agree', ref: refOf(snap, 'checkbox "I agree"'), type: 'checkbox', value: 'true' },
      { element: 'Large', ref: refOf(snap, 'radio "Large"'), type: 'radio', value: 'true' },
      { element: 'Level', ref: refOf(snap, 'slider "Level"'), type: 'slider', value: '7' },
      { element: 'Day', ref: refOf(snap, 'textbox "Day"'), type: 'textbox', value: '2026-11-05' },
      { element: 'Note', ref: refOf(snap, 'generic "Note"'), type: 'textbox', value: 'new note' },
    ],
  });
  expect(form.outcome, JSON.stringify(form)).toBe('ok');
  expect(await page.locator('#bio').inputValue()).toBe('hello\nworld');
  expect(await page.locator('#color').inputValue()).toBe('b');
  expect(await page.locator('#agree').isChecked()).toBe(true);
  expect(await page.locator('#size-l').isChecked()).toBe(true);
  expect(await page.locator('#level').inputValue()).toBe('7');
  expect(await page.locator('#day').inputValue()).toBe('2026-11-05');
  expect(await page.locator('#note').textContent()).toBe('new note');
  // 页面自己的 change 监听都收到了（可信事件 / 派发的事件）。
  expect(await page.evaluate(() => document.body.dataset.changed ?? '')).toContain('agree');

  const submit = await call(h, 'click', { element: 'Submit', ref: refOf(snap, 'button "Submit"') });
  expect(submit.outcome, JSON.stringify(submit)).toBe('ok');
  expect(submit.page?.url).toContain('/submitted?');
  expect(submit.page?.url).toContain('color=b');
});

test('stale ref 回 element_not_found', async () => {
  await call(h, 'open', { url: `${A}/form.html` });
  const snap = await snapshot();
  const ref = refOf(snap, 'textbox "Name"');
  await call(h, 'open', { url: `${A}/landing.html` });
  const r = await call(h, 'click', { element: 'Name', ref });
  expect(r.code).toBe('element_not_found');
});

test('hover 触发悬停；坐标点击', async () => {
  await call(h, 'open', { url: `${A}/hover.html` });
  const snap = await snapshot();
  const r = await call(h, 'hover', { element: 'Hover me', ref: refOf(snap, 'button "Hover me"') });
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  const after = await snapshot();
  expect(after).toContain('Tooltip text');

  const page = await aiPage(h, '/hover.html');
  const box = await page.locator('#h').boundingBox();
  const byXY = await call(h, 'click', { element: 'Hover me', x: (box?.x ?? 0) + 5, y: (box?.y ?? 0) + 5 });
  expect(byXY.outcome, JSON.stringify(byXY)).toBe('ok');
});

test('press_key：单键与组合键', async () => {
  await call(h, 'open', { url: `${A}/keys.html` });
  const snap = await snapshot();
  await call(h, 'type', { element: 'Keys', ref: refOf(snap, 'textbox "Keys"'), text: 'ab' });
  const r = await call(h, 'press_key', { key: 'Control+A' });
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  await call(h, 'press_key', { key: 'Backspace' });
  await call(h, 'press_key', { key: 'x', repeat: 3 });
  const page = await aiPage(h, '/keys.html');
  expect(await page.locator('#k').inputValue()).toBe('xxx');
  expect(await page.locator('#log').textContent()).toContain('a+ctrl');

  const bad = await call(h, 'press_key', { key: 'Hyper+Q' });
  expect(bad.code).toBe('invalid_args');
});

test('scroll：滚到元素与滚轮', async () => {
  await call(h, 'open', { url: `${A}/long.html` });
  const page = await aiPage(h, '/long.html');
  const r = await call(h, 'scroll', { x: 300, y: 300, direction: 'down', amount: 800 });
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(400);

  const snap = await snapshot();
  await call(h, 'scroll', { element: 'Bottom', ref: refOf(snap, 'Bottom') });
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(2000);
});

test('drag：HTML5 拖放', async () => {
  await call(h, 'open', { url: `${A}/drag.html` });
  const snap = await snapshot();
  const r = await call(h, 'drag', {
    start_element: 'Item', start_ref: refOf(snap, 'Item'),
    end_element: 'Drop here', end_ref: refOf(snap, 'Drop here'),
  });
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  const page = await aiPage(h, '/drag.html');
  expect(await page.locator('#res').textContent()).toBe('dropped item');
});

test('dialog：alert / confirm / prompt', async () => {
  await call(h, 'open', { url: `${A}/dialogs.html` });
  const snap = await snapshot();

  const clicked = await call(h, 'click', { element: 'Alert', ref: refOf(snap, 'button "Alert"') });
  expect(clicked.outcome, JSON.stringify(clicked)).toBe('ok');
  expect(clicked.page?.dialog).toMatchObject({ type: 'alert', message: 'hello alert' });

  // 对话框开着时别的动作做不了。
  const blocked = await call(h, 'read');
  expect(blocked.code).toBe('action_failed');
  expect(blocked.page?.dialog?.type).toBe('alert');

  const ok = await call(h, 'dialog', { accept: true });
  expect(ok.outcome, JSON.stringify(ok)).toBe('ok');
  expect(ok.page?.dialog).toBeUndefined();

  await call(h, 'click', { element: 'Confirm', ref: refOf(snap, 'button "Confirm"') });
  await call(h, 'dialog', { accept: false });
  await call(h, 'click', { element: 'Prompt', ref: refOf(snap, 'button "Prompt"') });
  const pr = await call(h, 'dialog', { accept: true, prompt_text: 'Wang' });
  expect(pr.outcome).toBe('ok');

  const page = await aiPage(h, '/dialogs.html');
  expect(await page.locator('#res').textContent()).toBe('prompt Wang');

  const none = await call(h, 'dialog', { accept: true });
  expect(none.code).toBe('action_failed');
});

test('wait：等文字出现、等文字消失、等几秒', async () => {
  await call(h, 'open', { url: `${A}/later.html` });
  const t0 = Date.now();
  const r = await call(h, 'wait', { text: 'ready now', seconds: 5 });
  expect(r.payload?.satisfied).toBe(true);
  expect(Date.now() - t0).toBeGreaterThan(500);
  const gone = await call(h, 'wait', { text_gone: 'waiting', seconds: 2 });
  expect(gone.payload?.satisfied).toBe(true);
  const never = await call(h, 'wait', { text: 'never appears', seconds: 1 });
  expect(never.payload?.satisfied).toBe(false);
  const plain = await call(h, 'wait', { seconds: 0.5 });
  expect(plain.payload?.satisfied).toBe(true);
});

test('console 与 network：级别过滤、凭据头去掉、按编号看正文', async () => {
  await call(h, 'open', { url: `${A}/console.html` });
  const all = await call(h, 'console', { level: 'debug' });
  expect(all.outcome, JSON.stringify(all)).toBe('ok');
  const texts = all.payload?.messages.map((m: any) => `${m.level}:${m.text}`);
  expect(texts).toEqual(expect.arrayContaining(['info:hello from console 42', 'warning:careful', 'error:broken thing']));
  const errors = await call(h, 'console', { level: 'error' });
  expect(errors.payload?.messages.every((m: any) => m.level === 'error')).toBe(true);

  const snap = await snapshot();
  await call(h, 'click', { element: 'Load data', ref: refOf(snap, 'button "Load data"') });
  await call(h, 'wait', { text: 'status 200', seconds: 5 });

  const list = await call(h, 'network', { filter: '/api/data' });
  expect(list.outcome, JSON.stringify(list)).toBe('ok');
  const req = list.payload?.requests.find((x: any) => x.url.endsWith('/api/data'));
  expect(req).toMatchObject({ method: 'POST', status: 200 });

  const detail = await call(h, 'network', { index: req.index });
  const d = detail.payload?.request;
  const reqHeaders = Object.keys(d.request_headers).map((k) => k.toLowerCase());
  const resHeaders = Object.keys(d.response_headers).map((k) => k.toLowerCase());
  expect(reqHeaders).toContain('x-trace');
  expect(reqHeaders).not.toContain('authorization');
  expect(reqHeaders).not.toContain('x-csrf-token');
  expect(resHeaders).toContain('x-plain');
  expect(resHeaders).not.toContain('set-cookie');
  expect(resHeaders).not.toContain('x-session-id');
  expect(d.request_body).toBe('{"q":"hello"}');
  expect(d.response_body).toContain('"ok":true');

  const nostatic = await call(h, 'network', {});
  expect(nostatic.payload?.requests.every((x: any) => !['Image', 'Stylesheet', 'Script', 'Font'].includes(x.type))).toBe(true);
});

test('screenshot：视口、整页、元素；尺寸按 CSS 像素', async () => {
  await call(h, 'open', { url: `${A}/long.html` });
  const vp = await call(h, 'screenshot');
  expect(vp.outcome, JSON.stringify(vp).slice(0, 300)).toBe('ok');
  expect(vp.payload?.image).toMatchObject({ mime: 'image/png', width: 1200, height: 800 });

  const full = await call(h, 'screenshot', { full_page: true });
  expect(full.payload?.image.height).toBeGreaterThan(3000);

  const snap = await snapshot();
  const el = await call(h, 'screenshot', { ref: refOf(snap, 'Bottom') });
  expect(el.outcome).toBe('ok');
  expect(el.payload?.image.height).toBeLessThan(100);
});

test('pdf：存成交付文件', async () => {
  await call(h, 'open', { url: `${A}/form.html` });
  const r = await call(h, 'pdf');
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  const file = r.payload?.files[0];
  expect(file).toMatchObject({ kind: 'pdf', name: 'Form.pdf', content_type: 'application/pdf' });
  const stored = await h.sw.evaluate(() => (globalThis as any).__bxTest.server.files);
  expect(stored[0]).toMatchObject({ file_id: file.file_id, kind: 'pdf' });
  expect(Buffer.from(stored[0].base64, 'base64').subarray(0, 5).toString()).toBe('%PDF-');
});

test('iframe：同源与跨源子框架进快照，编号带前缀，能点', async () => {
  await allowSite(h, B);
  await call(h, 'open', { url: `${A}/iframe.html` });
  // 跨源子框架的子会话附着要一点时间。
  await call(h, 'wait', { seconds: 0.5 });
  const snap = await snapshot();
  expect(snap).toContain('frame same');
  expect(snap).toContain('frame cross');
  const refs = [...snap.matchAll(/button "Count" \[ref=([^\]]+)\]/g)].map((m) => m[1]);
  expect(refs).toHaveLength(2);
  expect(refs.every((r) => /^f\d+e\d+$/.test(r ?? ''))).toBe(true);

  for (const ref of refs) {
    const r = await call(h, 'click', { element: 'Count', ref });
    expect(r.outcome, JSON.stringify(r)).toBe('ok');
  }

  const page = await aiPage(h, '/iframe.html');
  for (const f of page.frames().filter((x) => x.url().includes('frame-child'))) {
    expect(await f.locator('#n').textContent()).toBe('1');
  }
});

test('网址范围：javascript:、data:、file:// 不开', async () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,hi', 'file:///etc/passwd', 'chrome://settings']) {
    const r = await call(h, 'open', { url });
    expect(r.code, url).toBe('site_not_allowed');
  }

  const creds = await call(h, 'open', { url: `http://user:pw@127.0.0.1:1/` });
  expect(creds.code).toBe('site_not_allowed');
  expect(await sent(h, 'approval_request')).toHaveLength(0);
});
