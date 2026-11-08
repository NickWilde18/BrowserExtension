// 站点授权只存在插件本地；清理/撤销先失效旧代数，防迟到 grant 重新加回权限。
import type { KV } from '../storage';
import { Revocations } from './revocations';

const ALWAYS_KEY = 'sites.always';
const CONVERSATION_KEY = 'sites.conversation';
export type GrantScope = 'always' | 'conversation';
export interface SiteGrants { always: string[]; conversation: Record<string, string[]> }

export class SiteStore {
  /** 撤销与清理同步通知在途读取（browser/read-leases）。 */
  readonly revocations = new Revocations();
  private revision = 0;
  private writing: Promise<void> = Promise.resolve();
  constructor(private readonly local: KV, private readonly session: KV) {}

  async isAllowed(conversation: string, site: string): Promise<boolean> {
    await this.writing;
    const revision = this.revision;
    const always = (await this.local.get<string[]>(ALWAYS_KEY)) ?? [];
    if (revision !== this.revision) return false;
    if (always.includes(site)) return true;
    const byConversation = (await this.session.get<Record<string, string[]>>(CONVERSATION_KEY)) ?? {};
    return revision === this.revision && (byConversation[conversation] ?? []).includes(site);
  }

  grant(conversation: string, site: string, scope: GrantScope): Promise<void> {
    return this.update(async (current) => {
      if (scope === 'always') {
        const always = (await this.local.get<string[]>(ALWAYS_KEY)) ?? [];
        if (!current()) return;
        if (!always.includes(site)) { always.push(site); await this.local.set(ALWAYS_KEY, always); }
        return;
      }
      const byConversation = (await this.session.get<Record<string, string[]>>(CONVERSATION_KEY)) ?? {};
      if (!current()) return;
      const list = byConversation[conversation] ?? [];
      if (!list.includes(site)) {
        list.push(site);
        byConversation[conversation] = list;
        await this.session.set(CONVERSATION_KEY, byConversation);
      }
    });
  }

  revoke(site: string): Promise<void> {
    this.revision++;
    this.revocations.emit({ kind: 'site', site });
    return this.update(async () => {
      const always = (await this.local.get<string[]>(ALWAYS_KEY)) ?? [];
      await this.local.set(ALWAYS_KEY, always.filter((s) => s !== site));
      const byConversation = (await this.session.get<Record<string, string[]>>(CONVERSATION_KEY)) ?? {};
      for (const key of Object.keys(byConversation)) {
        const kept = (byConversation[key] ?? []).filter((s) => s !== site);
        if (kept.length) byConversation[key] = kept;
        else delete byConversation[key];
      }
      await this.session.set(CONVERSATION_KEY, byConversation);
    }, false);
  }

  clear(): Promise<void> {
    this.revision++;
    this.revocations.emit({ kind: 'all' });
    return this.update(async () => {
      await this.local.remove(ALWAYS_KEY);
      await this.session.remove(CONVERSATION_KEY);
    }, false);
  }

  async list(): Promise<SiteGrants> {
    await this.writing;
    const revision = this.revision;
    const always = (await this.local.get<string[]>(ALWAYS_KEY)) ?? [];
    const conversation = (await this.session.get<Record<string, string[]>>(CONVERSATION_KEY)) ?? {};
    return revision === this.revision ? { always, conversation } : { always: [], conversation: {} };
  }

  private update(work: (current: () => boolean) => Promise<void>, skipIfStale = true): Promise<void> {
    const revision = this.revision;
    const current = () => revision === this.revision;
    // 授权可因撤销失效；撤权和清理必须逐项执行，不能被后续撤权跳过。
    const write = this.writing.catch(() => undefined).then(async () => { if (!skipIfStale || current()) await work(current); });
    this.writing = write;
    return write;
  }
}
