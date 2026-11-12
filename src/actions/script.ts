// 页面内脚本：evaluate（契约 4.5）。每次都要逐次确认（kind=script），小窗显示站点和脚本全文，并写明
// 「脚本能读本站的登录信息并发往外站」。脚本在页面主世界里跑（页面自己的变量都看得到），超时用
// Runtime.terminateExecution 打断。

import { CdpError } from '../browser/cdp';
import type { EvaluateArgs } from '../protocol/args';
import { ActionError } from '../protocol/errors';
import type { ActionContext } from './context';
import type { ActionOutput } from './types';

const VALUE_LIMIT = 20_000;

type RemoteValue = { type?: string; value?: unknown; unserializableValue?: string; description?: string };

function render(result: RemoteValue): string {
  if (result.type === 'undefined') {
    return 'undefined';
  }

  if (result.unserializableValue !== undefined) {
    return result.unserializableValue;
  }

  try {
    return JSON.stringify(result.value) ?? 'undefined';
  } catch {
    return result.description ?? String(result.value);
  }
}

export async function evaluate(ctx: ActionContext, a: EvaluateArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  const site = await ctx.ensureSite(s);
  s.assertNoDialog();

  const r = await ctx.services.gate.confirm(ctx, {
    kind: 'script',
    site: site ?? '',
    reviewDetail: { source: a.fn },
    promptDetail: { source: a.fn },
  });
  if (r.result !== 'allow') {
    ctx.throwIfAborted();
    throw new ActionError(r.result === 'deny' && r.why === 'timeout' ? 'approval_timeout' : 'user_denied', r.result === 'deny' && r.why === 'timeout'
      ? 'The user did not answer in time whether the assistant may run the script.'
      : 'The user did not allow the script to run.');
  }

  await ctx.checkSiteUnchanged(s, site);

  const frameId = a.ref ? s.frameForRef(a.ref) : s.mainFrameId;
  const sessionId = s.frameSession(frameId);
  const mainCtx = s.mainContextOf(frameId);
  if (mainCtx === null) {
    throw new ActionError('action_failed', 'The page is still loading; try again in a moment.');
  }

  const params: Record<string, unknown> = {
    functionDeclaration: a.fn,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  };

  if (a.ref) {
    const iso = await s.callObject(frameId, 'element', [a.ref]);
    const desc = await s.cdp.send<{ node: { backendNodeId: number } }>('DOM.describeNode', { objectId: iso }, sessionId);
    const main = await s.cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode',
      { backendNodeId: desc.node.backendNodeId, executionContextId: mainCtx }, sessionId);
    if (!main.object.objectId) {
      throw new ActionError('element_not_found', 'That element is no longer on the page. Call browser_read again.');
    }

    params.objectId = main.object.objectId;
    params.arguments = [{ objectId: main.object.objectId }];
  } else {
    params.executionContextId = mainCtx;
    params.arguments = [];
  }

  const terminate = () => {
    void s.cdp.send('Runtime.terminateExecution', {}, sessionId).catch(() => undefined);
  };
  ctx.signal.addEventListener('abort', terminate, { once: true });

  type CallResult = { result: RemoteValue; exceptionDetails?: { text?: string; exception?: { description?: string } } };
  let res: CallResult | undefined;
  try {
    res = await ctx.guarded(s, () => s.cdp.send<CallResult>('Runtime.callFunctionOn', params, sessionId));
  } catch (err) {
    if (err instanceof CdpError) {
      throw new ActionError('action_failed', 'function must be a JavaScript function, like () => document.title or (element) => element.textContent.');
    }

    throw err;
  } finally {
    ctx.signal.removeEventListener('abort', terminate);
  }

  if (!res) {
    return { session: s, payload: { value: 'undefined', truncated: false }, message: 'A dialog opened while the script was running; handle it with browser_dialog.' };
  }

  if (res.exceptionDetails) {
    const text = (res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? 'Error').split('\n')[0] ?? 'Error';
    throw new ActionError('action_failed', `The script threw an error: ${text.slice(0, 300)}`);
  }

  const value = render(res.result);
  return {
    session: s,
    payload: value.length > VALUE_LIMIT ? { value: value.slice(0, VALUE_LIMIT), truncated: true } : { value, truncated: false },
  };
}
