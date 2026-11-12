import { describe, expect, it, vi } from 'vitest';
import { SiteStore } from '../../src/policy/sites';
import { MemoryKV } from '../../src/storage';
import { ActionContext, type Services } from '../../src/actions/context';
import type { RequestFrame } from '../../src/protocol/frames';

class DelayedKV extends MemoryKV {
  private begin!: () => void;
  private release!: () => void;
  readonly started = new Promise<void>((r) => { this.begin = r; });
  private readonly blocked = new Promise<void>((r) => { this.release = r; });
  override async get<T>(key: string): Promise<T | undefined> {
    if (key === 'sites.always') { this.begin(); await this.blocked; }
    return super.get<T>(key);
  }
  finish(): void { this.release(); }
}

describe('授权清理与旧回调的交错', () => {
  it('同时撤销两个站点时两次清理都必须执行', async () => {
    const sites = new SiteStore(new MemoryKV(), new MemoryKV());
    await sites.grant('A', 'https://one.test', 'always');
    await sites.grant('A', 'https://two.test', 'always');
    await sites.grant('A', 'https://one.test', 'conversation');
    await sites.grant('A', 'https://two.test', 'conversation');
    await Promise.all([sites.revoke('https://one.test'), sites.revoke('https://two.test')]);
    expect(await sites.list()).toEqual({ always: [], conversation: {} });
  });
  it('换账号清理时旧grant还在等读存储，不能在clear后重新加回授权', async () => {
    const local = new DelayedKV();
    const sites = new SiteStore(local, new MemoryKV());
    const granting = sites.grant('old', 'https://old.test', 'always');
    await local.started;
    const clearing = sites.clear();
    local.finish();
    await Promise.all([granting, clearing]);
    expect((await local.get<string[]>('sites.always')) ?? []).toEqual([]);
  });

  it('已取消请求收到迟到allow也不得保存授权', async () => {
    const grant = vi.fn(async () => {});
    let allow!: (value: unknown) => void;
    const verdict = new Promise((r) => { allow = r; });
    const services = { sites: { isAllowed: async () => false, grant }, gate: { confirm: () => verdict } } as unknown as Services;
    const request = { type: 'request', request_id: 'r', conversation: 'A', conversation_title: '', action: 'read', args: {}, deadline_ms: 30000, auth_wait_ms: 30000 } as RequestFrame;
    const ctrl = new AbortController();
    const ctx = new ActionContext(request, services, ctrl.signal);
    const pending = ctx.authorizeSite('https://old.test').then(() => 'allowed', () => 'blocked');
    ctrl.abort({ code: 'user_stopped' });
    allow({ result: 'allow', by: 'user', scope: 'always' });
    try {
      expect(await pending).toBe('blocked');
      expect(grant).not.toHaveBeenCalled();
    } finally { ctx.dispose(); }
  });
});
