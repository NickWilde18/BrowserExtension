// 回合结束释放调试附着：保留网页、区分并行对话与新旧回合。
import { expect, test } from '@playwright/test';

import { A, CONV, CONV2, allowSite, launch, result, rid, sent } from './helpers';
import type { Harness } from './helpers';

const TURN = '10000000-0000-4000-8000-000000000001';
const NEXT = '10000000-0000-4000-8000-000000000002';
const OTHER = '10000000-0000-4000-8000-000000000003';
let h: Harness;

test.beforeEach(async () => {
  h = await launch();
  await allowSite(h, A);
  await allowSite(h, A, CONV2);
});

test.afterEach(async () => h.close());

async function sendTurn(action: string, args: Record<string, unknown>, turn = TURN, conversation = CONV) {
  const requestId = rid();
  await h.sw.evaluate((frame) => (globalThis as any).__bxTest.server.deliver(frame), {
    type: 'request', request_id: requestId, turn_id: turn, action, args, conversation,
    conversation_title: '回合释放测试', deadline_ms: 30_000, auth_wait_ms: 60_000,
  });
  return requestId;
}

async function act(action: string, args: Record<string, unknown> = {}, turn = TURN, conversation = CONV) {
  const r = await result(h, await sendTurn(action, args, turn, conversation));
  expect(r.outcome, JSON.stringify(r)).toBe('ok');
  return r;
}

async function release(turn = TURN, conversation = CONV) {
  await h.sw.evaluate((frame) => (globalThis as any).__bxTest.server.deliver(frame), {
    type: 'release', turn_id: turn, conversation,
  });
}

const attached = () => h.sw.evaluate(() => (globalThis as any).__bxTest.attachedCount());

test('回答结束释放本轮所有标签，保留网页与另一对话的附着', async () => {
  await act('open', { url: `${A}/form.html` });
  await act('tabs', { op: 'new', url: `${A}/landing.html` });
  await act('open', { url: `${A}/crosssite.html` }, OTHER, CONV2);
  expect(await attached()).toBe(3);
  const pages = h.ctx.pages().length;

  await release();
  await expect.poll(attached, { timeout: 3000 }).toBe(1);
  expect(h.ctx.pages()).toHaveLength(pages);
  expect(await sent(h, 'released')).toEqual(expect.arrayContaining([
    expect.objectContaining({ turn_id: TURN, conversation: CONV }),
  ]));
  await act('read', {}, OTHER, CONV2);
  await release(OTHER, CONV2);
  await expect.poll(attached).toBe(0);
});

test('迟到的旧回合释放不打断新回合，结束后旧请求不再执行', async () => {
  await act('open', { url: `${A}/form.html` });
  await act('read', {}, NEXT);
  await release();
  await expect.poll(async () => (await sent(h, 'released')).some((f) => f.turn_id === TURN)).toBe(true);
  expect(await attached()).toBe(1);
  await release();
  expect(await attached()).toBe(1);

  const late = await result(h, await sendTurn('tabs', { op: 'new', url: `${A}/landing.html` }));
  expect(late.outcome).toBe('error');
  expect(h.ctx.pages().some((p) => p.url().includes('/landing.html'))).toBe(false);
  await act('read', {}, NEXT);
  await release(NEXT);
  await expect.poll(attached).toBe(0);
});

test('停止回合取消等待中的确认，保留连接并允许下一轮', async () => {
  await act('open', { url: `${A}/form.html` });
  const pending = await sendTurn('evaluate', { function: '() => document.title' });
  await expect.poll(() => h.ctx.pages().filter((p) => p.url().includes('/approval.html')).length).toBe(1);
  await release();
  expect((await result(h, pending)).outcome).toBe('error');
  await expect.poll(attached).toBe(0);
  await expect.poll(() => h.ctx.pages().filter((p) => p.url().includes('/approval.html')).length).toBe(0);
  expect(await h.sw.evaluate(() => (globalThis as any).__bxTest.status().state)).toBe('connected');
  await act('read', {}, NEXT);
  await release(NEXT);
  await expect.poll(attached).toBe(0);
});
