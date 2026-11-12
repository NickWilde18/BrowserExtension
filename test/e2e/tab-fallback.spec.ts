// 真实 Chromium 扩展 + 分组 API 故障注入；不代表 Mac 真机结果。
import { expect, test } from '@playwright/test';
import { A, CONV, CONV2, allowSite, call, launch, result, send, sent, type Harness } from './helpers';

let h: Harness;
test.beforeEach(async () => {
  h = await launch();
  await allowSite(h, A);
  await allowSite(h, A, CONV2);
});
test.afterEach(async () => h.close());

async function fault(mode: 'missing' | 'reject' | 'hang' | 'late' | 'title') {
  await h.sw.evaluate((mode) => {
    const c = (globalThis as any).chrome;
    const group = c.tabs.group.bind(c.tabs);
    (globalThis as any).__groupCalls = 0;
    if (mode === 'title') c.tabGroups.update = () => new Promise(() => {});
    else c.tabs.group = mode === 'missing' ? undefined : (...args: any[]) => {
      (globalThis as any).__groupCalls++;
      if (mode === 'reject') return Promise.reject(new Error('unsupported'));
      if (mode === 'late') return new Promise((resolve, reject) => {
        (globalThis as any).__finishGroup = () => group(...args).then(resolve, reject);
      });
      return new Promise(() => {});
    };
  }, mode);
}

for (const mode of ['missing', 'reject', 'hang', 'title'] as const) {
  test(`${mode}：open、read、tabs new、关闭与会话隔离仍可用`, async () => {
    await fault(mode);
    const opened = await call(h, 'open', { url: `${A}/form.html` });
    expect(opened.outcome, JSON.stringify(opened)).toBe('ok');
    expect(opened.page?.url).toBe(`${A}/form.html`);
    expect((await call(h, 'read')).outcome).toBe('ok');
    expect((await call(h, 'tabs', { op: 'new', url: `${A}/landing.html` })).outcome).toBe('ok');
    const own = await call(h, 'tabs', { op: 'list' });
    expect(own.payload?.tabs).toHaveLength(2);
    const other = await call(h, 'tabs', { op: 'list' }, { conversation: CONV2 });
    expect(other.payload?.tabs).toEqual([]);
    expect((await call(h, 'close', { keep_tabs: true })).outcome).toBe('ok');
    expect(h.ctx.pages().some((p) => p.url().endsWith('/form.html'))).toBe(true);
    expect((await call(h, 'tabs', { op: 'list' })).payload?.tabs).toEqual([]);
    expect(await h.sw.evaluate(() => (globalThis as any).__bxTest.attachedCount())).toBe(0);
  });
}

test('分组已成功但命名卡住时保留分组，拖出仍撤销控制', async () => {
  await fault('title');
  expect((await call(h, 'open', { url: `${A}/form.html` })).outcome).toBe('ok');
  const grouped = await h.sw.evaluate(async () => {
    const c = (globalThis as any).chrome;
    const tab = (await c.tabs.query({})).find((t: any) => t.url?.endsWith('/form.html'));
    const groupId = tab.groupId;
    await c.tabs.ungroup(tab.id);
    return groupId;
  });
  expect(grouped).toBeGreaterThanOrEqual(0);
  await expect.poll(async () => (await call(h, 'tabs', { op: 'list' })).payload?.tabs).toEqual([]);
  await expect.poll(() => h.sw.evaluate(() => (globalThis as any).__bxTest.attachedCount())).toBe(0);
});

test('迟到的真实原生分组被按标签解散，不撤销回退页，不污染另一对话', async () => {
  await fault('late');
  expect((await call(h, 'open', { url: `${A}/form.html` })).outcome).toBe('ok');
  await h.sw.evaluate(() => (globalThis as any).__finishGroup());
  await expect.poll(() => h.sw.evaluate(async () => {
    const c = (globalThis as any).chrome;
    const tabs = await c.tabs.query({ url: '*://127.0.0.1/*' });
    return tabs.every((t: any) => t.groupId === -1);
  })).toBe(true);
  expect((await call(h, 'read')).outcome).toBe('ok');
  expect((await call(h, 'tabs', { op: 'list' }, { conversation: CONV2 })).payload?.tabs).toEqual([]);
});

test('动作超时早于分组预算时清理新页，迟到分组不再导航', async () => {
  await fault('hang');
  const request = await send(h, 'open', { url: `${A}/form.html` }, { deadlineMs: 150 });
  const r = await result(h, request);
  expect(r).toMatchObject({ outcome: 'error', code: 'timeout' });
  await expect.poll(async () => (await call(h, 'tabs', { op: 'list' })).payload?.tabs).toEqual([]);
  expect(h.ctx.pages().some((p) => p.url().endsWith('/form.html'))).toBe(false);
  expect(await h.sw.evaluate(() => (globalThis as any).__bxTest.attachedCount())).toBe(0);
});

test('分组中取消请求关闭新页，随后请求可正常执行', async () => {
  await fault('hang');
  const request = await send(h, 'open', { url: `${A}/form.html` });
  await expect.poll(() => h.sw.evaluate(() => (globalThis as any).__groupCalls)).toBeGreaterThan(0);
  await h.sw.evaluate((id) => (globalThis as any).__bxTest.server.deliver({ type: 'cancel', request_id: id }), request);
  expect((await result(h, request)).outcome).toBe('error');
  expect((await call(h, 'tabs', { op: 'list' })).payload?.tabs).toEqual([]);
  expect((await call(h, 'open', { url: `${A}/landing.html` })).outcome).toBe('ok');
  expect((await sent(h, 'result')).filter((f) => f.request_id === request)).toHaveLength(1);
});
