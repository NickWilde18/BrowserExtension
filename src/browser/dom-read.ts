import type { ActionContext } from '../actions/context';
import type { ActionOutput } from '../actions/types';
import { SNAPSHOT_LIMIT } from '../actions/snapshot';
import type { ReadArgs } from '../protocol/args';
import type { PageInfo } from '../protocol/frames';
import { ActionError } from '../protocol/errors';
import { siteOf } from '../policy/url';
import { serverHostPermission } from '../connection/server-settings';

export interface DomReadResult {
  error?: 'unsupported_page' | 'site_changed' | 'element_not_found' | 'action_failed';
  snapshot?: string;
  token?: string;
  page?: PageInfo;
}

export async function readDocument(ctx: ActionContext, args: ReadArgs): Promise<ActionOutput> {
  ctx.throwIfAborted();
  const tabId = await ctx.services.tabs.active(ctx.conversation);
  if (tabId === null || !await ctx.services.tabs.isAccessible(ctx.conversation, tabId)) {
    throw new ActionError('no_tab', 'Share the page from the extension popup first. This device can only read explicitly shared pages.');
  }
  const tab = await chrome.tabs.get(tabId);
  const site = siteOf(tab.url ?? '');
  if (!site) throw new ActionError('unsupported_page', 'Only ordinary web pages shared by the user can be read on this device.');
  await ctx.authorizeSite(site);
  ctx.throwIfAborted();
  if (!await chrome.permissions.contains({ origins: [serverHostPermission(site)] })) {
    throw new ActionError('unsupported_page', 'Grant this site page access from the extension popup before reading it.');
  }
  ctx.throwIfAborted();
  const installed = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
    func: () => typeof (globalThis as any).__browserRead === 'function' });
  ctx.throwIfAborted();
  if (!installed[0]?.result) await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, files: ['dom-agent.js'] });
  ctx.throwIfAborted();
  const rows = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
    func: (input: ReadArgs & { origin: string }): DomReadResult => (globalThis as any).__browserRead(input),
    args: [{ ...args, origin: site }],
  });
  ctx.throwIfAborted();
  const result = rows[0]?.result;
  if (!result || result.error) {
    const code = result?.error ?? 'action_failed';
    const message = code === 'unsupported_page' ? 'This page contains frames or cannot be read safely by this device. A partial snapshot was not returned.'
      : code === 'element_not_found' ? 'The element ref is no longer available. Read the shared page again.'
      : code === 'site_changed' ? 'The page moved to a different site before it could be read.'
      : 'The shared page could not be read.';
    throw new ActionError(code, message);
  }
  // 即使同 URL 重新加载，也用隔离世界的文档令牌拒绝迟到的旧文档快照。
  let currentToken: unknown;
  try {
    const current = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => (globalThis as any).__browserReadToken });
    currentToken = current[0]?.result;
  } catch { throw new ActionError('site_changed', 'The page changed while it was being read.'); }
  ctx.throwIfAborted();
  if (!result.token || result.token !== currentToken || !result.page || result.page.origin !== site) {
    throw new ActionError('site_changed', 'The page changed while it was being read.');
  }
  const text = result.snapshot ?? '';
  return { session: null, page: result.page, payload: { snapshot: text.slice(0, SNAPSHOT_LIMIT), truncated: text.length > SNAPSHOT_LIMIT } };
}
