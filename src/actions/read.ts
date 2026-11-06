// 读：read、find、screenshot、wait、console、network、pdf（契约 4.2）。

import type { AgentFindMatch } from '../browser/page-agent';
import { BODY_LIMIT } from '../browser/recorder';
import type { ConsoleArgs, FindArgs, NetworkArgs, ReadArgs, ScreenshotArgs, WaitArgs } from '../protocol/args';
import { ActionError } from '../protocol/errors';
import type { ActionContext } from './context';
import { decodeBase64, sanitizeFilename } from './context';
import { snapshotLines, snapshotText } from './snapshot';
import type { ActionOutput } from './types';

export async function read(ctx: ActionContext, a: ReadArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  await ctx.ensureSite(s);
  s.assertNoDialog();
  const { text, truncated } = await snapshotText(s, a.ref, a.depth, a.boxes);
  return { session: s, payload: { snapshot: text, truncated } };
}

export async function find(ctx: ActionContext, a: FindArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  await ctx.ensureSite(s);
  s.assertNoDialog();

  // 先取一次整页快照：装好每个框架的代理、给元素编号（find 只在编过号的元素里找）。
  await snapshotLines(s, s.mainFrameId, null, undefined, false);

  let total = 0;
  const matches: AgentFindMatch[] = [];
  for (const frameId of s.frameIds()) {
    try {
      const r = await s.call<{ matches: AgentFindMatch[]; total: number }>(frameId, 'find', [a.text, a.regex]);
      total += r.total;
      matches.push(...r.matches);
    } catch (err) {
      // 子框架可能在这期间被移除，跳过；主框架出错要报出来，不能静默当成「没找到」。
      if (frameId === s.mainFrameId) {
        throw err;
      }
    }
  }

  return { session: s, payload: { matches: matches.slice(0, 50), total } };
}

/** 截图的上限：原始字节超过它时改用 JPEG 再截一次（结果帧最多 8 MiB，base64 再大三分之一）。 */
const SCREENSHOT_MAX_BYTES = 5 * 1024 * 1024;
/** 整页截图的高度上限（CSS 像素）。 */
const FULL_PAGE_MAX_HEIGHT = 16_384;

/** 从 PNG / JPEG 字节里读宽高。 */
export function imageSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }

  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i++;
        continue;
      }

      const marker = bytes[i + 1] ?? 0;
      const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: ((bytes[i + 5] ?? 0) << 8) | (bytes[i + 6] ?? 0), width: ((bytes[i + 7] ?? 0) << 8) | (bytes[i + 8] ?? 0) };
      }

      i += 2 + len;
    }
  }

  return { width: 0, height: 0 };
}

export async function screenshot(ctx: ActionContext, a: ScreenshotArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  await ctx.ensureSite(s);
  s.assertNoDialog();

  const dpr = await s.call<number>(s.mainFrameId, 'devicePixelRatio');
  const metrics = await s.cdp.send<{
    cssLayoutViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
    cssContentSize: { width: number; height: number };
  }>('Page.getLayoutMetrics');
  const vp = metrics.cssLayoutViewport;

  // 输出按 CSS 像素（scale = 1/dpr）：给能看图的模型的坐标以截图为准。
  let clip = { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 1 / dpr };
  let beyond = false;

  if (a.ref) {
    const frameId = s.frameForRef(a.ref);
    const box = await s.call<{ x: number; y: number; width: number; height: number }>(frameId, 'box', [a.ref]);
    const off = await s.frameOffset(frameId);
    const after = await s.cdp.send<{ cssLayoutViewport: { pageX: number; pageY: number } }>('Page.getLayoutMetrics');
    if (box.width <= 0 || box.height <= 0) {
      throw new ActionError('action_failed', 'That element is not visible on the page (it has no size).');
    }

    clip = { x: after.cssLayoutViewport.pageX + off.x + box.x, y: after.cssLayoutViewport.pageY + off.y + box.y, width: box.width, height: box.height, scale: 1 / dpr };
    beyond = true;
  } else if (a.fullPage) {
    clip = { x: 0, y: 0, width: metrics.cssContentSize.width, height: Math.min(metrics.cssContentSize.height, FULL_PAGE_MAX_HEIGHT), scale: 1 / dpr };
    beyond = true;
  }

  let shot = await s.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: beyond });
  let mime = 'image/png';
  if (shot.data.length * 0.75 > SCREENSHOT_MAX_BYTES) {
    shot = await s.cdp.send<{ data: string }>('Page.captureScreenshot', { format: 'jpeg', quality: 80, clip, captureBeyondViewport: beyond });
    mime = 'image/jpeg';
  }

  const { width, height } = imageSize(decodeBase64(shot.data.slice(0, 4096 - (4096 % 4))));
  return { session: s, payload: { image: { mime, data: shot.data, width, height } } };
}

export async function wait(ctx: ActionContext, a: WaitArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  await ctx.ensureSite(s);

  const limitMs = Math.min(ctx.remainingMs() - 500, (a.seconds ?? 30) * 1000);
  const until = Date.now() + Math.max(0, limitMs);

  if (a.text === undefined && a.textGone === undefined) {
    await sleep(until - Date.now(), ctx.signal);
    ctx.throwIfAborted();
    return { session: s, payload: { satisfied: true } };
  }

  for (;;) {
    ctx.throwIfAborted();
    if (s.dialog) {
      return { session: s, payload: { satisfied: false } };
    }

    let present = false;
    let gone = true;
    for (const frameId of s.frameIds()) {
      try {
        if (a.text !== undefined && await s.call<boolean>(frameId, 'hasText', [a.text])) {
          present = true;
        }

        if (a.textGone !== undefined && await s.call<boolean>(frameId, 'hasText', [a.textGone])) {
          gone = false;
        }
      } catch {
        // 框架正在导航：下一轮再看。
      }
    }

    const ok = (a.text === undefined || present) && (a.textGone === undefined || gone);
    if (ok) {
      return { session: s, payload: { satisfied: true } };
    }

    if (Date.now() >= until) {
      return { session: s, payload: { satisfied: false } };
    }

    await sleep(Math.min(250, until - Date.now()), ctx.signal);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal.aborted) {
      resolve();
      return;
    }

    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }

    signal.addEventListener('abort', done, { once: true });
  });
}

export async function consoleMessages(ctx: ActionContext, a: ConsoleArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  await ctx.ensureSite(s);
  const { messages, dropped } = s.recorder.consoleMessages(a.level);
  return { session: s, payload: { messages, dropped } };
}

function clipBody(text: string): { body: string; truncated: boolean } {
  return text.length > BODY_LIMIT ? { body: text.slice(0, BODY_LIMIT), truncated: true } : { body: text, truncated: false };
}

const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|x-www-form-urlencoded|.*\+json|.*\+xml))/;

export async function network(ctx: ActionContext, a: NetworkArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  await ctx.ensureSite(s);

  if (a.index === undefined) {
    return { session: s, payload: { requests: s.recorder.networkList(a.filter, a.includeStatic) } };
  }

  const entry = s.recorder.entry(a.index);
  if (!entry) {
    throw new ActionError('invalid_args', `There is no request ${a.index}; list the requests first.`);
  }

  const request = s.recorder.detail(entry);
  let truncated = false;

  if (entry.hasPostData) {
    try {
      const post = await s.cdp.send<{ postData: string }>('Network.getRequestPostData', { requestId: entry.requestId }, entry.sessionId);
      const c = clipBody(post.postData);
      request.request_body = c.body;
      truncated ||= c.truncated;
    } catch {
      // 请求体已经不在浏览器里了。
    }
  }

  try {
    const res = await s.cdp.send<{ body: string; base64Encoded: boolean }>('Network.getResponseBody', { requestId: entry.requestId }, entry.sessionId);
    let text: string;
    if (!res.base64Encoded) {
      text = res.body;
    } else if (TEXT_MIME.test(entry.mimeType)) {
      text = new TextDecoder().decode(decodeBase64(res.body));
    } else {
      text = `[binary content, ${Math.floor(res.body.length * 0.75)} bytes]`;
    }

    const c = clipBody(text);
    request.response_body = c.body;
    truncated ||= c.truncated;
  } catch {
    // 响应体没有（重定向、失败的请求）或已被浏览器丢掉。
  }

  request.truncated = truncated;
  return { session: s, payload: { request } };
}

export async function pdf(ctx: ActionContext): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  await ctx.ensureSite(s);
  s.assertNoDialog();

  const transport = ctx.services.transport();
  if (!transport) {
    throw new ActionError('action_failed', 'The PDF could not be sent to the conversation because the browser is not connected.');
  }

  const res = await s.cdp.send<{ data: string }>('Page.printToPDF', { printBackground: true, preferCSSPageSize: true });
  const bytes = decodeBase64(res.data);
  if (bytes.length > ctx.services.maxFileBytes()) {
    throw new ActionError('file_too_large', 'The PDF of this page is larger than the size limit for files in the conversation.');
  }

  const info = await s.pageInfo();
  const name = `${sanitizeFilename(info.title || 'page').slice(0, 120)}.pdf`;
  const { file_id } = await transport.sendFile(ctx.requestId, { kind: 'pdf', name, contentType: 'application/pdf', data: new Blob([bytes], { type: 'application/pdf' }) });
  return { session: s, payload: { files: [{ file_id, kind: 'pdf', name, size: bytes.length, content_type: 'application/pdf' }] } };
}
