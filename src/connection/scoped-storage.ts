// 运行期存储写入栅栏：切换服务器后，旧异步任务不能重新写入授权或标签归属。
import type { KV } from '../storage';

export class ScopedKV implements KV {
  private active = true;
  private writing: Promise<void> = Promise.resolve();

  constructor(private readonly store: KV) {}

  async get<T>(key: string): Promise<T | undefined> {
    if (!this.active) return undefined;
    const value = await this.store.get<T>(key);
    return this.active ? value : undefined;
  }

  set(key: string, value: unknown): Promise<void> {
    const snapshot = structuredClone(value);
    return this.enqueue(() => this.store.set(key, snapshot));
  }

  remove(key: string): Promise<void> {
    return this.enqueue(() => this.store.remove(key));
  }

  /** 同步禁止新写入，并等已开始的底层写入结束；调用方随后清旧状态。 */
  seal(): Promise<void> {
    this.active = false;
    return this.writing;
  }

  private enqueue(write: () => Promise<void>): Promise<void> {
    const next = this.writing.catch(() => undefined).then(async () => {
      if (this.active) await write();
    });
    this.writing = next;
    return next;
  }
}
