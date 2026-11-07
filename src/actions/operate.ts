// 操作：click、hover、type、fill_form、select、press_key、scroll、drag、dialog（契约 4.3）。

import { insertText, modifierMask, mouseClick, mouseMove, mouseWheel, pressChord, typeSlowly } from '../browser/input';
import { parseChord } from '../browser/keys';
import type { AgentElementInfo } from '../browser/page-agent';
import type { TabSession } from '../browser/tab-session';
import type {
  ClickArgs, DialogArgs, DragArgs, FillFormArgs, FormField, HoverArgs, PressKeyArgs, ScrollArgs, SelectArgs, TypeArgs,
} from '../protocol/args';
import { ActionError } from '../protocol/errors';
import type { ActionContext } from './context';
import { downloadsPayload } from './navigation';
import { refPoint, targetPoint } from './target';
import type { ActionOutput } from './types';

/** 每个改页面的动作共同的开头：当前 AI 标签、站点授权、没有挡着的对话框。 */
async function prepare(ctx: ActionContext): Promise<{ s: TabSession; site: string | null }> {
  const s = await ctx.currentSession();
  const site = await ctx.ensureSite(s);
  s.assertNoDialog();
  return { s, site };
}

export async function click(ctx: ActionContext, a: ClickArgs): Promise<ActionOutput> {
  const { s, site } = await prepare(ctx);
  const point = await targetPoint(s, a.target);
  await ctx.checkSiteUnchanged(s, site);
  await ctx.guarded(s, () => mouseClick(s, point.x, point.y, a.button, a.count, modifierMask(a.modifiers)));
  return { session: s, payload: await downloadsPayload(ctx) };
}

export async function hover(ctx: ActionContext, a: HoverArgs): Promise<ActionOutput> {
  const { s, site } = await prepare(ctx);
  const point = await targetPoint(s, a.target);
  await ctx.checkSiteUnchanged(s, site);
  await mouseMove(s, point.x, point.y);
  return { session: s };
}

/** 密码框的逐次确认：返回 allow / self；拒绝抛 user_denied。 */
async function confirmPassword(ctx: ActionContext, site: string | null, field: string): Promise<{ mode: 'allow' } | { mode: 'self'; promptId: string }> {
  const r = await ctx.services.gate.confirm(ctx, {
    kind: 'password',
    site: site ?? '',
    reviewDetail: { field },
    promptDetail: { field },
  });

  if (r.result === 'allow') {
    return { mode: 'allow' };
  }

  if (r.result === 'self') {
    return { mode: 'self', promptId: r.promptId };
  }

  ctx.throwIfAborted();
  throw new ActionError(r.why === 'timeout' ? 'approval_timeout' : 'user_denied', r.why === 'timeout'
    ? 'The user did not answer in time whether the assistant may type into the password field.'
    : 'The user did not allow the assistant to type into the password field.');
}

/** 「我自己输入」：切到那个标签、把焦点放进字段，等用户在小窗里点「完成」。 */
async function letUserType(ctx: ActionContext, s: TabSession, ref: string, promptId: string): Promise<void> {
  try {
    const tab = await chrome.tabs.update(s.tabId, { active: true });
    if (tab?.windowId !== undefined) {
      await chrome.windows.update(tab.windowId, { focused: true });
    }
  } catch {
    // 标签页刚被关掉：下面等用户的那一步会按小窗的结果收尾。
  }

  await s.call(s.frameForRef(ref), 'focus', [ref]).catch(() => undefined);

  ctx.pauseDeadline();
  const started = Date.now();
  try {
    const outcome = await ctx.services.prompts.waitSelfInput(promptId, Math.max(1000, ctx.authWait.remainingMs()));
    if (outcome !== 'done') {
      ctx.throwIfAborted();
      throw new ActionError(outcome === 'timeout' ? 'approval_timeout' : 'user_denied', outcome === 'timeout'
        ? 'The confirmation timed out while the user was typing. Changes already made cannot be undone; read the page first and do not retry automatically.'
        : 'The user did not finish typing the password.');
    }
  } finally {
    ctx.authWait.consume(Date.now() - started);
    ctx.resumeDeadline();
  }
}

/** 把文字填进一个字段（Playwright 的 fill 语义：选中原有内容后整段替换）。 */
async function fillField(ctx: ActionContext, s: TabSession, ref: string, text: string, slowly: boolean): Promise<void> {
  const frameId = s.frameForRef(ref);
  const res = await s.call<string>(frameId, 'fill', [ref, text]);
  if (res === 'done') {
    return;
  }

  if (res !== 'needsinput') {
    throw new ActionError('element_not_found', 'That element is no longer on the page. Call browser_read again.');
  }

  if (text === '') {
    await pressChord(s, 'Delete', 1);
  } else if (slowly) {
    await pressChord(s, 'Delete', 1);
    await typeSlowly(s, text, ctx.signal);
  } else {
    await insertText(s, text);
  }
}

export async function type(ctx: ActionContext, a: TypeArgs): Promise<ActionOutput> {
  const { s, site } = await prepare(ctx);
  const info = await s.call<AgentElementInfo>(s.frameForRef(a.ref), 'info', [a.ref]);

  if (info.password) {
    const how = await confirmPassword(ctx, site, info.field);
    if (how.mode === 'self') {
      await letUserType(ctx, s, a.ref, how.promptId);
      return { session: s, payload: { password_field: true }, message: 'The user typed the password into the field themselves.' };
    }
  }

  await ctx.checkSiteUnchanged(s, site);
  await ctx.guarded(s, async () => {
    await fillField(ctx, s, a.ref, a.text, a.slowly);
    if (a.submit) {
      await pressChord(s, 'Enter', 1);
    }
  });

  const payload = await downloadsPayload(ctx);
  if (info.password) {
    payload.password_field = true;
  }

  return { session: s, payload };
}

const TRUE_VALUES = new Set(['true', 'checked', 'on', 'yes', '1']);

async function fillOne(ctx: ActionContext, s: TabSession, f: FormField, info: AgentElementInfo): Promise<void> {
  switch (f.type) {
    case 'checkbox':
    case 'radio': {
      if (!info.checkable) {
        throw new ActionError('action_failed', `"${f.element}" is not a checkbox or radio button.`);
      }

      const want = TRUE_VALUES.has(f.value.trim().toLowerCase());
      if (want !== info.checked) {
        if (f.type === 'radio' && !want) {
          throw new ActionError('action_failed', `"${f.element}" is a radio button; select another option instead of unchecking it.`);
        }

        const p = await refPoint(s, f.ref);
        await mouseClick(s, p.x, p.y, 'left', 1, 0);
      }

      return;
    }
    case 'combobox': {
      if (info.select) {
        const res = await s.call<string[] | string>(s.frameForRef(f.ref), 'selectOptions', [f.ref, [f.value]]);
        if (typeof res === 'string') {
          throw new ActionError('action_failed', `"${f.value}" is not one of the options of "${f.element}".`);
        }

        return;
      }

      await fillField(ctx, s, f.ref, f.value, false);
      return;
    }
    default:
      await fillField(ctx, s, f.ref, f.value, false);
  }
}

export async function fillForm(ctx: ActionContext, a: FillFormArgs): Promise<ActionOutput> {
  const { s, site } = await prepare(ctx);

  const infos: AgentElementInfo[] = [];
  for (const f of a.fields) {
    infos.push(await s.call<AgentElementInfo>(s.frameForRef(f.ref), 'info', [f.ref]));
  }

  const passwordRefs = a.fields.filter((_, i) => infos[i]?.password).map((f) => f.ref);
  let selfTyped = false;
  let selfPrompt: string | null = null;
  if (passwordRefs.length) {
    const fieldNames = infos.filter((x) => x.password).map((x) => x.field).filter(Boolean);
    const how = await confirmPassword(ctx, site, fieldNames.join(', '));
    if (how.mode === 'self') {
      selfTyped = true;
      selfPrompt = how.promptId;
    }
  }

  await ctx.checkSiteUnchanged(s, site);
  await ctx.guarded(s, async () => {
    for (const [i, f] of a.fields.entries()) {
      const info = infos[i];
      if (!info || (selfTyped && info.password)) {
        continue;
      }

      await fillOne(ctx, s, f, info);
    }
  });

  if (selfPrompt !== null && passwordRefs[0] !== undefined) {
    await letUserType(ctx, s, passwordRefs[0], selfPrompt);
  }

  const payload = await downloadsPayload(ctx);
  if (passwordRefs.length) {
    payload.password_fields = passwordRefs;
  }

  return selfTyped
    ? { session: s, payload, message: 'The user typed the password themselves; the other fields were filled.' }
    : { session: s, payload };
}

export async function select(ctx: ActionContext, a: SelectArgs): Promise<ActionOutput> {
  const { s, site } = await prepare(ctx);
  await ctx.checkSiteUnchanged(s, site);
  const res = await ctx.guarded(s, () => s.call<string[] | string>(s.frameForRef(a.ref), 'selectOptions', [a.ref, a.values]));
  if (typeof res === 'string') {
    if (res === 'error:optionnotenabled') {
      throw new ActionError('action_failed', 'That option is disabled.');
    }

    throw new ActionError('action_failed', 'None of the given values match an option of that dropdown; read the page to see its options.');
  }

  return { session: s, payload: await downloadsPayload(ctx) };
}

export async function pressKey(ctx: ActionContext, a: PressKeyArgs): Promise<ActionOutput> {
  parseChord(a.key);
  const { s, site } = await prepare(ctx);
  await ctx.checkSiteUnchanged(s, site);
  await ctx.guarded(s, () => pressChord(s, a.key, a.repeat));
  return { session: s, payload: await downloadsPayload(ctx) };
}

export async function scroll(ctx: ActionContext, a: ScrollArgs): Promise<ActionOutput> {
  const { s } = await prepare(ctx);
  if ('ref' in a) {
    await s.call(s.frameForRef(a.ref), 'scrollIntoView', [a.ref]);
    return { session: s };
  }

  const dx = a.direction === 'left' ? -a.amount : a.direction === 'right' ? a.amount : 0;
  const dy = a.direction === 'up' ? -a.amount : a.direction === 'down' ? a.amount : 0;
  await mouseWheel(s, a.point.x, a.point.y, dx, dy);
  await new Promise((r) => setTimeout(r, 150));
  return { session: s };
}

export async function drag(ctx: ActionContext, a: DragArgs): Promise<ActionOutput> {
  const { s, site } = await prepare(ctx);
  const from = await targetPoint(s, a.start);
  const to = await targetPoint(s, a.end);
  await ctx.checkSiteUnchanged(s, site);

  await ctx.guarded(s, async () => {
    // 页面里的 HTML5 拖放：截下浏览器的拖拽，再在终点派发 dragEnter / dragOver / drop（Playwright 的做法）。
    let dragData: unknown = null;
    const off = s.on((m, p) => {
      if (m === 'Input.dragIntercepted') {
        dragData = p.data;
      }
    });

    await s.cdp.send('Input.setInterceptDrags', { enabled: true });
    try {
      await mouseMove(s, from.x, from.y);
      await s.cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      const steps = 8;
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps;
        const y = from.y + ((to.y - from.y) * i) / steps;
        await mouseMove(s, x, y, 0, 1);
      }

      if (dragData !== null) {
        for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
          await s.cdp.send('Input.dispatchDragEvent', { type, x: to.x, y: to.y, data: dragData });
        }
      }

      await s.cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
    } finally {
      off();
      await s.cdp.send('Input.setInterceptDrags', { enabled: false }).catch(() => undefined);
    }
  });

  return { session: s, payload: await downloadsPayload(ctx) };
}

export async function dialog(ctx: ActionContext, a: DialogArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  const d = s.dialog;
  if (!d) {
    throw new ActionError('action_failed', 'No dialog is open on the page.');
  }

  const params: Record<string, unknown> = { accept: a.accept };
  if (a.promptText !== undefined) {
    params.promptText = a.promptText;
  }

  // 确定离开页面这类对话框会接着导航：同样经过跨站拦截。
  await ctx.guarded(s, async () => {
    await s.cdp.send('Page.handleJavaScriptDialog', params, d.sessionId);
    // 关闭事件稍后才到；这里先清掉，后面才会等「确定离开」之后的导航。
    s.dialog = null;
  });
  return { session: s, payload: await downloadsPayload(ctx) };
}
