// 平台账号变化（补充约定 4）：ready.account 与上一次连上时不同（同一个浏览器换了平台账号），先清掉上一个账号的
// 对话状态，再让新连接可用（ConnectionManager 的 beforeReady）。
//
// 上一次的账号记在本地存储：后台被回收、浏览器重启之后照样比较——「总是允许」的站点授权也在本地存储里，换了账号
// 要能清到。

import type { KV } from '../storage';

const KEY = 'state.account';

export class AccountWatch {
  constructor(private readonly kv: KV, private readonly clear: (previous: string, current: string) => Promise<void>) {}

  /**
   * 连上时调：账号和上次连上时不同就先清，返回是否清过。第一次连上只记下。清理失败时抛出、不记新账号：
   * 下一次连上再清。
   */
  async connected(account: string): Promise<boolean> {
    const previous = await this.kv.get<string>(KEY);
    if (previous === account) {
      return false;
    }

    if (previous !== undefined) {
      await this.clear(previous, account);
    }

    await this.kv.set(KEY, account);
    return previous !== undefined;
  }
}
