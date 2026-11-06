// 动作表与请求执行：校验参数 → 执行 → 组结果帧（契约 3.2）。

import { MAX_RESULT_FRAME_BYTES } from '../config';
import { validateArgs } from '../protocol/args';
import { ActionError, toActionError } from '../protocol/errors';
import type { ActionName, PageInfo, RequestFrame, ResultFrame } from '../protocol/frames';
import { siteOf } from '../policy/url';
import { ActionContext, STOPPED_MESSAGE, abortError, abortPromise, currentUrl } from './context';
import type { Services } from './context';
import { upload } from './files';
import { close, navigate, open, tabs } from './navigation';
import { click, dialog, drag, fillForm, hover, pressKey, scroll, select, type } from './operate';
import { consoleMessages, find, network, pdf, read, screenshot, wait } from './read';
import { evaluate } from './script';
import type { ActionHandler, ActionTable } from './types';

const ACTION_TABLE: ActionTable = {
  open,
  navigate,
  tabs,
  close,
  read,
  find,
  screenshot,
  wait,
  console: consoleMessages,
  network,
  pdf,
  click,
  hover,
  type,
  fill_form: fillForm,
  select,
  press_key: pressKey,
  scroll,
  drag,
  dialog,
  upload,
  evaluate,
};

function errorResult(requestId: string, err: ActionError, page?: PageInfo): ResultFrame {
  const r: ResultFrame = { type: 'result', request_id: requestId, outcome: 'error', code: err.code, message: err.message };
  if (page) {
    r.page = page;
  }

  return r;
}

/**
 * 执行一个请求，返回结果帧（不抛异常）。动作之外发生过的事（被取消的下载、被关掉的新标签）附在这个对话这一次
 * 结果的 message 里告诉模型（成功、失败都带）。
 */
export async function runRequest(services: Services, request: RequestFrame, signal: AbortSignal): Promise<ResultFrame> {
  const result = await executeRequest(services, request, signal);
  const notes = services.notices.take(request.conversation);
  if (notes.length) {
    result.message = [result.message, ...notes].filter(Boolean).join(' ');
  }

  return result;
}

async function executeRequest(services: Services, request: RequestFrame, signal: AbortSignal): Promise<ResultFrame> {
  if (services.stopped()) {
    return errorResult(request.request_id, new ActionError('user_stopped', STOPPED_MESSAGE));
  }

  const ctx = new ActionContext(request, services, signal);
  try {
    const adopted = await services.tabs.touch(request.conversation);
    if (adopted !== null) {
      // 用户点「共享此页」时还没有对话在用浏览器：共享给了这个对话，等于授权这一页的站点（限本次对话）。
      const site = siteOf(await currentUrl(adopted).catch(() => ''));
      if (site) {
        await services.sites.grant(request.conversation, site, 'conversation');
      }
    }

    const handler = ACTION_TABLE[request.action] as ActionHandler<ActionName>;
    const args = validateArgs(request.action, request.args);
    // 和中止信号竞速：页面卡住时某个调试命令可能一直不返回，时限一到、被取消或被叫停就立即回结果，
    // 不让这个对话的串行队列被一个挂住的动作堵死。
    const out = await Promise.race([handler(ctx, args as never), abortPromise(ctx.signal)]);
    ctx.throwIfAborted();

    const result: ResultFrame = { type: 'result', request_id: request.request_id, outcome: 'ok' };
    if (out.session && !out.session.detached) {
      result.page = await out.session.pageInfo();
    }

    if (out.payload && Object.keys(out.payload).length) {
      result.payload = out.payload;
    }

    if (out.message) {
      result.message = out.message;
    }

    if (JSON.stringify(result).length > MAX_RESULT_FRAME_BYTES) {
      return errorResult(request.request_id, new ActionError('action_failed', 'The result was too large to send; read a smaller part of the page.'));
    }

    return result;
  } catch (err) {
    const e = ctx.signal.aborted ? abortError(ctx.signal) : toActionError(err);
    const page = await currentPage(services, request.conversation);
    if (ctx.signal.aborted && e.code === 'timeout') {
      // 动作超时或被取消时，调试会话里可能还挂着一条不返回的命令（如冻结页面上的输入事件），
      // 后面同类命令会排在它后面：断开这一页的附着，下一次动作重新附着、换一个新会话。
      const tabId = await services.tabs.active(request.conversation).catch(() => null);
      if (tabId !== null) {
        await services.sessions.detach(tabId).catch(() => false);
      }
    }

    return errorResult(request.request_id, e, page);
  } finally {
    ctx.dispose();
  }
}

/** 出错时也尽量带上当前页（模型据此判断下一步），取不到就不带。 */
async function currentPage(services: Services, conversation: string): Promise<PageInfo | undefined> {
  const tabId = await services.tabs.active(conversation).catch(() => null);
  if (tabId === null) {
    return undefined;
  }

  const s = services.sessions.peek(tabId);
  return s ? s.pageInfo().catch(() => undefined) : undefined;
}
