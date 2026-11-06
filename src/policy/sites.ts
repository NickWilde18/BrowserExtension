// 站点授权记录，只存在插件本地，按来源记，服务端不知道（计划 4.5「站点授权」）。
//
// - 总是允许：storage.local，跨浏览器重启保留，用户在弹窗里撤销。
// - 仅本次对话：storage.session，按对话 id 记，浏览器关掉就没了。
// - 用户点「共享此页」也记一条本次对话的授权。
//
// 「总是允许此站点」不免掉密码框、上传、下载、脚本这四类的逐次确认（那四类不经这里判）。

import type { KV } from '../storage';

const ALWAYS_KEY = 'sites.always';
const CONVERSATION_KEY = 'sites.conversation';

export type GrantScope = 'always' | 'conversation';

export interface SiteGrants {
  always: string[];
  conversation: Record<string, string[]>;
}

export class SiteStore {
  constructor(private readonly local: KV, private readonly session: KV) {}

  /** 这个对话能不能在这个站点上动作。 */
  async isAllowed(conversation: string, site: string): Promise<boolean> {
    const always = (await this.local.get<string[]>(ALWAYS_KEY)) ?? [];
    if (always.includes(site)) {
      return true;
    }

    const byConversation = (await this.session.get<Record<string, string[]>>(CONVERSATION_KEY)) ?? {};
    return (byConversation[conversation] ?? []).includes(site);
  }

  async grant(conversation: string, site: string, scope: GrantScope): Promise<void> {
    if (scope === 'always') {
      const always = (await this.local.get<string[]>(ALWAYS_KEY)) ?? [];
      if (!always.includes(site)) {
        always.push(site);
        await this.local.set(ALWAYS_KEY, always);
      }

      return;
    }

    const byConversation = (await this.session.get<Record<string, string[]>>(CONVERSATION_KEY)) ?? {};
    const list = byConversation[conversation] ?? [];
    if (!list.includes(site)) {
      list.push(site);
      byConversation[conversation] = list;
      await this.session.set(CONVERSATION_KEY, byConversation);
    }
  }

  /** 撤销一个站点：总是允许与各对话里的授权一起删。 */
  async revoke(site: string): Promise<void> {
    const always = (await this.local.get<string[]>(ALWAYS_KEY)) ?? [];
    await this.local.set(ALWAYS_KEY, always.filter((s) => s !== site));

    const byConversation = (await this.session.get<Record<string, string[]>>(CONVERSATION_KEY)) ?? {};
    for (const key of Object.keys(byConversation)) {
      const kept = (byConversation[key] ?? []).filter((s) => s !== site);
      if (kept.length === 0) {
        delete byConversation[key];
      } else {
        byConversation[key] = kept;
      }
    }

    await this.session.set(CONVERSATION_KEY, byConversation);
  }

  async list(): Promise<SiteGrants> {
    return {
      always: (await this.local.get<string[]>(ALWAYS_KEY)) ?? [],
      conversation: (await this.session.get<Record<string, string[]>>(CONVERSATION_KEY)) ?? {},
    };
  }
}
