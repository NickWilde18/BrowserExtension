// 端到端测试辅助：起带插件的浏览器、扮演 Chat 收发帧、操作确认小窗。

import { chromium } from '@playwright/test';
import type { BrowserContext, Page, Worker } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FIXTURE_PORT } from './global-setup';

const here = path.dirname(fileURLToPath(import.meta.url));
export const EXT_DIR = path.resolve(here, '..', '..', 'dist-test');

export const A = `http://127.0.0.1:${FIXTURE_PORT}`;
export const B = `http://localhost:${FIXTURE_PORT}`;
export const CONV = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';
export const CONV2 = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';

export interface Result {
  type: 'result';
  request_id: string;
  outcome: 'ok' | 'error';
  code?: string;
  message?: string;
  page?: { url: string; title: string; origin: string; dialog?: { type: string; message: string; default_prompt?: string } };
  payload?: Record<string, any>;
}

export interface Harness {
  ctx: BrowserContext;
  sw: Worker;
  extId: string;
  close(): Promise<void>;
}

/** 起一个装好插件的浏览器（持久化上下文），连上假 Chat（回 ready），审批默认回 ask_user。 */
export async function launch(opts: { autoApproval?: 'ask_user' | 'allow' | 'block' | 'none'; headless?: boolean; realViewport?: boolean; extensionDir?: string } = {}): Promise<Harness> {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-e2e-'));
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: opts.headless ?? true,
    // realViewport：不做 Playwright 的视口模拟，页面用真实窗口尺寸（与用户的浏览器一致）。
    viewport: opts.realViewport ? null : { width: 1200, height: 800 },
    args: [`--disable-extensions-except=${opts.extensionDir ?? EXT_DIR}`, `--load-extension=${opts.extensionDir ?? EXT_DIR}`],
  });

  // Playwright 自己也连着每个标签页：没有 dialog 监听时它会自动关掉对话框（它的默认行为），插件就看不到
  // 对话框了。挂一个空监听让它不插手，对话框交给插件处理。
  ctx.on('page', (p) => p.on('dialog', () => undefined));

  let [sw] = ctx.serviceWorkers();
  if (!sw) {
    sw = await ctx.waitForEvent('serviceworker', { timeout: 15_000 });
  }

  const extId = new URL(sw.url()).host;
  await sw.evaluate(async (auto) => {
    const t = (globalThis as any).__bxTest;
    const ready = { type: 'ready', protocol: 1, heartbeat_seconds: 20, account: 'tester@example.edu', max_file_bytes: 20 * 1024 * 1024 };
    (globalThis as any).__autoApproval = auto;
    t.server.onSent((f: any) => {
      const decision = (globalThis as any).__autoApproval;
      if (f.type === 'approval_request' && decision !== 'none') {
        queueMicrotask(() => t.server.deliver({ type: 'approval', request_id: f.request_id, approval_id: f.approval_id, kind: f.kind, decision, reason: decision === 'block' ? 'test reason' : undefined }));
      }

      // 扮演 Chat：每次（重）连都回 ready。
      if (f.type === 'hello' && t.status().state === 'connecting') {
        queueMicrotask(() => t.server.deliver(ready));
      }
    });

    // 心跳：不发的话超过 3 个心跳间隔，插件按心跳超时断线重连。
    setInterval(() => t.server.deliver({ type: 'ping' }), 20_000);

    // 第一次的 hello 可能在挂监听之前就发了：补回一次 ready。
    for (let i = 0; i < 100; i++) {
      if (t.server.sent.some((f: any) => f.type === 'hello')) {
        break;
      }

      await new Promise((r) => setTimeout(r, 50));
    }

    t.server.deliver(ready);
    for (let i = 0; i < 100 && t.status().state !== 'connected'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
  }, opts.autoApproval ?? 'ask_user');

  return {
    ctx,
    sw,
    extId,
    async close() {
      await ctx.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

let seq = 0;

/** 生成请求 id（UUID 形状）。 */
export function rid(): string {
  seq++;
  const hex = seq.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

/** 扮演 Chat 发一个请求，等它的结果帧。 */
export async function call(h: Harness, action: string, args: Record<string, unknown> = {},
  opts: { conversation?: string; deadlineMs?: number; authWaitMs?: number; requestId?: string; title?: string } = {}): Promise<Result> {
  const requestId = opts.requestId ?? rid();
  return h.sw.evaluate(async ({ requestId, action, args, conversation, deadlineMs, authWaitMs, title }) => {
    const t = (globalThis as any).__bxTest;
    t.server.deliver({ type: 'request', request_id: requestId, action, args, conversation, conversation_title: title, deadline_ms: deadlineMs, auth_wait_ms: authWaitMs });
    for (;;) {
      const found = t.server.sent.find((f: any) => f.type === 'result' && f.request_id === requestId);
      if (found) {
        return found;
      }

      await new Promise((r) => setTimeout(r, 25));
    }
  }, { requestId, action, args, conversation: opts.conversation ?? CONV, deadlineMs: opts.deadlineMs ?? 30_000, authWaitMs: opts.authWaitMs ?? 60_000, title: opts.title });
}

/** 发请求但不等结果（与确认小窗交互的用例用）。 */
export async function send(h: Harness, action: string, args: Record<string, unknown> = {},
  opts: { conversation?: string; deadlineMs?: number; authWaitMs?: number } = {}): Promise<string> {
  const requestId = rid();
  await h.sw.evaluate(({ requestId, action, args, conversation, deadlineMs, authWaitMs }) => {
    (globalThis as any).__bxTest.server.deliver({ type: 'request', request_id: requestId, action, args, conversation, deadline_ms: deadlineMs, auth_wait_ms: authWaitMs });
  }, { requestId, action, args, conversation: opts.conversation ?? CONV, deadlineMs: opts.deadlineMs ?? 30_000, authWaitMs: opts.authWaitMs ?? 60_000 });
  return requestId;
}

export async function result(h: Harness, requestId: string): Promise<Result> {
  return h.sw.evaluate(async (requestId) => {
    const t = (globalThis as any).__bxTest;
    for (;;) {
      const found = t.server.sent.find((f: any) => f.type === 'result' && f.request_id === requestId);
      if (found) {
        return found;
      }

      await new Promise((r) => setTimeout(r, 25));
    }
  }, requestId);
}

/** 插件发出的帧（按类型过滤）。 */
export async function sent(h: Harness, type?: string): Promise<any[]> {
  return h.sw.evaluate((type) => (globalThis as any).__bxTest.server.sent.filter((f: any) => !type || f.type === type), type);
}

/** 等确认小窗出现，返回它的页面。 */
export async function approvalWindow(h: Harness): Promise<Page> {
  const existing = h.ctx.pages().find((p) => p.url().includes('/approval.html'));
  const page = existing ?? await h.ctx.waitForEvent('page', { predicate: (p) => p.url().includes('/approval.html'), timeout: 20_000 });
  await page.waitForLoadState('domcontentloaded');
  await page.locator('#buttons button').first().waitFor({ timeout: 10_000 });
  return page;
}

/** 在确认小窗里点一个按钮（按文字）。 */
/** 确认会同步关窗，CDP 的按键或点击回执可能晚于关窗；只接纳已确认关窗的这一种回执错误。 */
export async function actOnPrompt(page: Page, action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    if (!page.isClosed() || !(error instanceof Error) || !error.message.includes('Target page, context or browser has been closed')) {
      throw error;
    }
  }
}

export async function answer(h: Harness, label: string | RegExp): Promise<void> {
  const page = await approvalWindow(h);
  await actOnPrompt(page, () => page.locator('#buttons button', { hasText: label }).click());
}

/** 预先给对话授权站点（跳过站点授权小窗）。 */
export async function allowSite(h: Harness, site: string, conversation = CONV): Promise<void> {
  await h.sw.evaluate(({ site, conversation }) => (globalThis as any).__bxTest.sites.grant(conversation, site, 'conversation'), { site, conversation });
}

/** AI 当前标签对应的 Playwright 页面。 */
export async function aiPage(h: Harness, urlPart: string): Promise<Page> {
  for (let i = 0; i < 50; i++) {
    const p = h.ctx.pages().find((x) => x.url().includes(urlPart));
    if (p) {
      return p;
    }

    await new Promise((r) => setTimeout(r, 100));
  }

  throw new Error(`no page with ${urlPart}`);
}

/** 从快照文本里按行内容找编号。 */
export function refOf(snapshot: string, needle: string | RegExp): string {
  for (const line of snapshot.split('\n')) {
    const ok = typeof needle === 'string' ? line.includes(needle) : needle.test(line);
    const m = /\[ref=([^\]]+)\]/.exec(line);
    if (ok && m?.[1]) {
      return m[1];
    }
  }

  throw new Error(`no ref for ${String(needle)} in:\n${snapshot}`);
}
