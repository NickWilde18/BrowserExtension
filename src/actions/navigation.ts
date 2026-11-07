// 导航：open、navigate、tabs、close（契约 4.1）。

import type { TabSession } from '../browser/tab-session';
import { checkOpenableUrl, siteOf } from '../policy/url';
import type { CloseArgs, NavigateArgs, OpenArgs, TabsArgs } from '../protocol/args';
import { ActionError } from '../protocol/errors';
import type { ActionContext } from './context';
import type { ActionOutput } from './types';

/** 导航并等加载完；导航本身失败时抛 action_failed（被导航拦截拦下的由 guarded 报 user_denied）。 */
async function navigateTo(ctx: ActionContext, s: TabSession, url: string): Promise<void> {
  await ctx.guarded(s, async () => {
    const res = await s.cdp.send<{ errorText?: string }>('Page.navigate', { url });
    if (res.errorText && res.errorText !== 'net::ERR_ABORTED' && res.errorText !== 'net::ERR_BLOCKED_BY_CLIENT') {
      throw new ActionError('action_failed', `The page could not be loaded (${res.errorText}).`);
    }
  });
}

export async function open(ctx: ActionContext, a: OpenArgs): Promise<ActionOutput> {
  const url = checkOpenableUrl(a.url);
  const site = siteOf(url);
  if (site) {
    // 导航本身就会带着用户的登录态访问那个站点，所以授权在导航之前。
    await ctx.authorizeSite(site);
  }

  let tabId = await ctx.services.tabs.active(ctx.conversation);
  if (a.newTab || tabId === null) {
    tabId = await ctx.services.tabs.createTab(ctx.conversation, ctx.signal);
  }

  const s = await ctx.attach(tabId);
  s.assertNoDialog();
  await navigateTo(ctx, s, url);
  return { session: s, payload: await downloadsPayload(ctx) };
}

export async function navigate(ctx: ActionContext, a: NavigateArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  s.assertNoDialog();

  if (a.direction === 'reload') {
    await ctx.ensureSite(s);
    await ctx.guarded(s, async () => {
      await s.cdp.send('Page.reload', {});
    });
    return { session: s };
  }

  const hist = await s.cdp.send<{ currentIndex: number; entries: Array<{ id: number; url: string }> }>('Page.getNavigationHistory');
  const target = hist.entries[hist.currentIndex + (a.direction === 'back' ? -1 : 1)];
  if (!target) {
    throw new ActionError('action_failed', a.direction === 'back' ? 'There is no earlier page to go back to.' : 'There is no later page to go forward to.');
  }

  const site = siteOf(target.url);
  if (site) {
    await ctx.authorizeSite(site);
  }

  await ctx.guarded(s, async () => {
    await s.cdp.send('Page.navigateToHistoryEntry', { entryId: target.id });
  });
  return { session: s };
}

async function tabList(ctx: ActionContext): Promise<Array<Record<string, unknown>>> {
  const ids = await ctx.services.tabs.list(ctx.conversation);
  const active = await ctx.services.tabs.active(ctx.conversation);
  const shared = new Set((await ctx.services.tabs.get(ctx.conversation))?.shared ?? []);
  const out: Array<Record<string, unknown>> = [];

  for (const [index, id] of ids.entries()) {
    try {
      const tab = await chrome.tabs.get(id);
      out.push({ index, title: tab.title ?? '', url: tab.url ?? tab.pendingUrl ?? '', active: id === active, shared: shared.has(id) });
    } catch {
      // 刚关掉的标签：登记会在 onRemoved 里清掉。
    }
  }

  return out;
}

export async function tabs(ctx: ActionContext, a: TabsArgs): Promise<ActionOutput> {
  const ids = await ctx.services.tabs.list(ctx.conversation);

  switch (a.op) {
    case 'list': {
      const active = await ctx.services.tabs.active(ctx.conversation);
      const s = active !== null ? ctx.services.sessions.peek(active) ?? null : null;
      return { session: s, payload: { tabs: await tabList(ctx) } };
    }
    case 'new': {
      let url: string | null = null;
      if (a.url !== undefined && a.url.trim() !== '') {
        url = checkOpenableUrl(a.url);
        const site = siteOf(url);
        if (site) {
          await ctx.authorizeSite(site);
        }
      }

      const tabId = await ctx.services.tabs.createTab(ctx.conversation, ctx.signal);
      const s = await ctx.attach(tabId);
      if (url) {
        await navigateTo(ctx, s, url);
      }

      return { session: s, payload: { tabs: await tabList(ctx) } };
    }
    case 'select': {
      const tabId = ids[a.index ?? -1];
      if (tabId === undefined) {
        throw new ActionError('no_tab', `There is no tab ${a.index}; use browser_tabs list to see the tabs.`);
      }

      await ctx.services.tabs.setActive(ctx.conversation, tabId);
      const s = await ctx.attach(tabId);
      return { session: s, payload: { tabs: await tabList(ctx) } };
    }
    case 'close': {
      const tabId = a.index !== undefined ? ids[a.index] : await ctx.services.tabs.active(ctx.conversation);
      if (tabId === undefined || tabId === null) {
        throw new ActionError('no_tab', a.index !== undefined ? `There is no tab ${a.index}.` : 'There is no open tab to close.');
      }

      await ctx.services.sessions.detach(tabId);
      await ctx.services.tabs.closeTab(ctx.conversation, tabId);
      const active = await ctx.services.tabs.active(ctx.conversation);
      const s = active !== null ? ctx.services.sessions.peek(active) ?? null : null;
      return { session: s, payload: { tabs: await tabList(ctx) } };
    }
    default:
      throw new ActionError('invalid_args', 'Unknown tabs operation.');
  }
}

export async function close(ctx: ActionContext, a: CloseArgs): Promise<ActionOutput> {
  // 先断开附着（顶部提示条随之消失），再关标签或解散标签组。
  let detached = 0;
  for (const tabId of await ctx.services.tabs.list(ctx.conversation)) {
    if (await ctx.services.sessions.detach(tabId)) {
      detached++;
    }
  }

  const { closed } = await ctx.services.tabs.release(ctx.conversation, a.keepTabs);
  return { session: null, payload: { detached, closed_tabs: closed } };
}

/**
 * 动作期间拦下的下载 → payload 里的 files / download_denied / download_failed（契约 3.2）。文件超过上限时抛
 * file_too_large；其余没取回来的，动作本身已经生效：结果仍是 ok，原因记进 ctx.notes、接在 message 后面。
 */
export async function downloadsPayload(ctx: ActionContext): Promise<Record<string, unknown>> {
  const outcomes = await ctx.downloadOutcomes();
  const payload: Record<string, unknown> = {};
  const files = outcomes.flatMap((o) => (o.file ? [o.file] : []));
  if (files.length) {
    payload.files = files;
  }

  if (outcomes.some((o) => o.denied)) {
    payload.download_denied = true;
  }
  if (outcomes.some((o) => o.timedOut)) {
    payload.download_timed_out = true;
    ctx.notes.push('Download confirmation timed out. The action may already have taken effect; do not repeat it automatically.');
  }

  const err = outcomes.find((o) => o.error)?.error;
  if (err) {
    throw err;
  }

  const failed = [...new Set(outcomes.flatMap((o) => (o.failed ? [o.failed] : [])))];
  if (failed.length) {
    payload.download_failed = true;
    ctx.notes.push(...failed);
  }

  return payload;
}
