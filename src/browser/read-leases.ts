// 在途只读的租约：按对话 + 标签 + 站点登记，授权撤销时只作废匹配的旧读取。
//
// 撤销立即中止匹配的租约，之后的重授只对新请求生效，旧租约不会复活。浏览器调用无法打断时，
// 读取先以撤销错误返回，迟到的页面结果被丢弃。
import type { ActionContext } from '../actions/context';
import { abortError } from '../actions/context';
import { ActionError } from '../protocol/errors';
import type { Revocation } from '../policy/revocations';

export interface ReadScope {
  conversation: string;
  tabId: number;
  site: string;
  /** 原生站点权限的匹配模式。 */
  permission: string;
}

function matchesTab(r: Revocation, scope: ReadScope): boolean {
  if (r.kind === 'all') return true;
  if (r.kind === 'conversation') return r.conversation === scope.conversation;
  return r.kind === 'tab' && r.tabId === scope.tabId && r.conversation === scope.conversation;
}

function matchesSite(r: Revocation, scope: ReadScope): boolean {
  return r.kind === 'all' || (r.kind === 'site' && r.site === scope.site);
}

const SHARE_REVOKED = 'Page access was revoked while it was being read. Share the page again from the extension popup.';
const SITE_REVOKED = 'Permission for this site was revoked while the page was being read.';
const NATIVE_REVOKED = 'Page access for this site was removed in the browser while it was being read.';

export class ReadLease {
  private readonly ctrl = new AbortController();
  private readonly cleanups: Array<() => void> = [];
  private released = false;

  constructor(private readonly ctx: ActionContext, private readonly scope: ReadScope) {
    const { tabs, sites } = ctx.services;
    this.cleanups.push(tabs.revocations.subscribe((r) => {
      if (matchesTab(r, scope)) this.revoke(new ActionError('no_tab', SHARE_REVOKED));
    }));
    this.cleanups.push(sites.revocations.subscribe((r) => {
      if (matchesSite(r, scope)) this.revoke(new ActionError('user_denied', SITE_REVOKED));
    }));
    const removed = chrome.permissions?.onRemoved;
    if (removed) {
      // 移除事件可能只带通配模式，按 contains 判定是否仍覆盖本站点，不影响其他站点。
      const onRemoved = (p: chrome.permissions.Permissions) => {
        if (!p.origins?.length) return;
        void chrome.permissions.contains({ origins: [scope.permission] }).then((still) => {
          if (!still) this.revoke(new ActionError('unsupported_page', NATIVE_REVOKED));
        }, () => this.revoke(new ActionError('unsupported_page', NATIVE_REVOKED)));
      };
      removed.addListener(onRemoved);
      this.cleanups.push(() => removed.removeListener(onRemoved));
    }
    const onOuterAbort = () => this.ctrl.abort(abortError(ctx.signal));
    if (ctx.signal.aborted) onOuterAbort();
    else {
      ctx.signal.addEventListener('abort', onOuterAbort, { once: true });
      this.cleanups.push(() => ctx.signal.removeEventListener('abort', onOuterAbort));
    }
  }

  /** 中止后抛出撤销或停止错误。 */
  check(): void {
    if (this.ctrl.signal.aborted) throw this.ctrl.signal.reason as ActionError;
  }

  /** 让浏览器调用与撤销赛跑；撤销先到时立即抛错，迟到结果被丢弃。 */
  race<T>(job: Promise<T>): Promise<T> {
    const signal = this.ctrl.signal;
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(signal.reason as ActionError);
      if (signal.aborted) {
        job.catch(() => undefined);
        abort();
        return;
      }
      signal.addEventListener('abort', abort, { once: true });
      job.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }

  /** 返回前确认原生权限仍在（不派发移除事件的浏览器也能拦住）。 */
  async confirmNative(): Promise<void> {
    const still = await this.race(chrome.permissions.contains({ origins: [this.scope.permission] }));
    if (!still) this.revoke(new ActionError('unsupported_page', NATIVE_REVOKED));
    this.check();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (const cleanup of this.cleanups.splice(0)) cleanup();
  }

  private revoke(error: ActionError): void {
    if (!this.released && !this.ctrl.signal.aborted) this.ctrl.abort(error);
  }
}
