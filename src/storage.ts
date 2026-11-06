// chrome.storage 的薄封装：local 跨重启保留（安装 id、显示名、总是允许的站点、开关），
// session 只活到浏览器关闭（本次对话的站点授权、标签组登记）。抽成接口是为了单测能换成内存实现。

export interface KV {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
}

class ChromeKV implements KV {
  constructor(private readonly area: chrome.storage.StorageArea) {}

  async get<T>(key: string): Promise<T | undefined> {
    const got = await this.area.get(key);
    return got[key] as T | undefined;
  }

  async set(key: string, value: unknown): Promise<void> {
    await this.area.set({ [key]: value });
  }

  async remove(key: string): Promise<void> {
    await this.area.remove(key);
  }
}

/** 内存实现，给单测与测试构建用。 */
export class MemoryKV implements KV {
  private readonly data = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    const v = this.data.get(key);
    return v === undefined ? undefined : (structuredClone(v) as T);
  }

  async set(key: string, value: unknown): Promise<void> {
    this.data.set(key, structuredClone(value));
  }

  async remove(key: string): Promise<void> {
    this.data.delete(key);
  }
}

export function localKV(): KV {
  return new ChromeKV(chrome.storage.local);
}

export function sessionKV(): KV {
  return new ChromeKV(chrome.storage.session);
}
