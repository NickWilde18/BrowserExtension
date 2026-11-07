// 不经导航的下载拦截（计划 4.5「下载」、4.7「下载交回到哪」；导航类下载在 navguard.ts 的响应阶段截下）。
//
// AI 自己开的标签里的下载一律不落进用户的下载目录：
// - AI 的动作执行期间：先取消浏览器自己的下载，再交给动作做逐次确认，允许后在页面里带着登录态把文件重新取一次、
//   送回 Chat 存成交付文件；
// - 动作之外（页面延迟触发、用户自己点的）：没有请求可以交回 Chat，只取消，交给 onStray 记下来，在这个对话的
//   下一个结果里告诉模型。
// 用户共享进来的页面、AI 标签之外的标签里的下载不碰。
//
// 下载归属：附着着的标签页会报 Page.downloadWillBegin（带网址，来自哪个标签页是确定的），用它和
// chrome.downloads.onCreated 的网址对上；没附着时按下载的来源页（referrer）认，只有打开这个网址的标签全是 AI
// 自己开的标签时才算（否则可能是用户在自己的标签里打开了同一个页面）。

export interface DownloadSeen {
  url: string;
  filename: string;
  contentType: string;
  /** 浏览器知道的大小；不知道时为 null。 */
  size: number | null;
  /** 下载的来源页（referrer），没有时为空。 */
  referrer: string;
}

export interface DownloadHooks {
  /** 这个标签是不是某个对话里 AI 自己开的标签；是就返回对话 id。 */
  ownedBy(tabId: number): Promise<string | null>;
  /** 按来源页网址找 AI 标签：打开这个网址的标签全是 AI 自己开的才返回其中一个，否则 null。 */
  aiTabFor(referrer: string): Promise<number | null>;
  /** 动作之外 AI 标签里的下载，已取消。 */
  stray(conversation: string, d: DownloadSeen): void;
}

interface Hint {
  tabId: number;
  url: string;
  suggestedFilename: string;
  at: number;
}

const HINT_TTL_MS = 15_000;

/** 网址里取文件名的最后手段。 */
function nameFromUrl(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    return last ? decodeURIComponent(last) : 'download';
  } catch {
    return 'download';
  }
}

/** 取消浏览器自己的这次下载，并从下载列表里抹掉；已经下完的删掉文件。 */
async function discard(item: chrome.downloads.DownloadItem): Promise<void> {
  try {
    await chrome.downloads.cancel(item.id);
  } catch {
    // 取消不了说明已经下完。
  }

  try {
    const [now] = await chrome.downloads.search({ id: item.id });
    if (now?.state === 'complete') {
      await chrome.downloads.removeFile(item.id);
    }
  } catch {
    // 文件已经不在。
  }

  try {
    await chrome.downloads.erase({ id: item.id });
  } catch {
    // 列表里已经没有。
  }
}

export class DownloadWatcher {
  private readonly armed = new Map<number, (d: DownloadSeen) => void>();
  private hints: Hint[] = [];
  private disposed = false;
  private readonly listener = (item: chrome.downloads.DownloadItem) => { void this.onCreated(item); };

  constructor(private readonly hooks: DownloadHooks) {
    chrome.downloads.onCreated.addListener(this.listener);
  }

  dispose(): void {
    this.disposed = true;
    this.armed.clear();
    this.hints = [];
    chrome.downloads.onCreated.removeListener(this.listener);
  }

  /** 动作开始时登记：这个标签页里出现的下载交给 onDownload。返回撤销登记。 */
  arm(tabId: number, onDownload: (d: DownloadSeen) => void): () => void {
    if (this.disposed) return () => {};
    this.armed.set(tabId, onDownload);
    return () => {
      if (this.armed.get(tabId) === onDownload) {
        this.armed.delete(tabId);
      }
    };
  }

  /** 附着的标签页报来 Page.downloadWillBegin。 */
  hint(tabId: number, url: string, suggestedFilename: string): void {
    if (this.disposed) return;
    const now = Date.now();
    this.hints = this.hints.filter((h) => now - h.at < HINT_TTL_MS);
    this.hints.push({ tabId, url, suggestedFilename, at: now });
  }

  private async onCreated(item: chrome.downloads.DownloadItem): Promise<void> {
    const now = Date.now();
    const hint = this.hints.find((h) => now - h.at < HINT_TTL_MS && (h.url === item.url || h.url === item.finalUrl));
    if (hint) {
      this.hints = this.hints.filter((h) => h !== hint);
    }

    const tabId = hint?.tabId ?? (item.referrer ? await this.hooks.aiTabFor(item.referrer) : null);
    if (tabId === null || tabId === undefined) {
      return;
    }

    const handler = this.armed.get(tabId);
    const owner = handler ? null : await this.hooks.ownedBy(tabId);
    if (this.disposed || (!handler && owner === null)) {
      // 附着着、但不是 AI 自己开的标签（用户共享进来的页面），动作之外的下载照常。
      return;
    }

    await discard(item);
    if (this.disposed) return;

    const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize > 0 ? item.fileSize : null;
    const filename = hint?.suggestedFilename || item.filename.split(/[\\/]/).pop() || nameFromUrl(item.finalUrl || item.url);
    const seen: DownloadSeen = { url: item.finalUrl || item.url, filename, contentType: item.mime || '', size, referrer: item.referrer || '' };

    if (handler) {
      handler(seen);
    } else if (owner !== null) {
      this.hooks.stray(owner, seen);
    }
  }
}
