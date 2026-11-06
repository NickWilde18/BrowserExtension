// 下载拦截（计划 4.5「下载」、4.7「下载交回到哪」）。
//
// AI 的动作执行期间，AI 标签里触发的下载由插件拦下：先取消浏览器自己的下载（不落进用户的下载目录），
// 再交给动作去做逐次确认，允许后在页面里带着登录态把文件重新取一次、送回 Chat 存成交付文件。
//
// 下载归属：调试接口的 Page.downloadWillBegin 带着网址（来自哪个附着的标签页是确定的），用它和
// chrome.downloads.onCreated 的网址对上；对不上的不是 AI 触发的，不碰（用户自己的下载照常）。

export interface DownloadSeen {
  url: string;
  filename: string;
  contentType: string;
  /** 浏览器知道的大小；不知道时为 null。 */
  size: number | null;
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

export class DownloadWatcher {
  private readonly armed = new Map<number, (d: DownloadSeen) => void>();
  private hints: Hint[] = [];

  constructor() {
    chrome.downloads.onCreated.addListener((item) => {
      void this.onCreated(item);
    });
  }

  /** 动作开始时登记：这个标签页里出现的下载交给 onDownload。返回撤销登记。 */
  arm(tabId: number, onDownload: (d: DownloadSeen) => void): () => void {
    this.armed.set(tabId, onDownload);
    return () => {
      if (this.armed.get(tabId) === onDownload) {
        this.armed.delete(tabId);
      }
    };
  }

  /** 附着的标签页报来 Page.downloadWillBegin。 */
  hint(tabId: number, url: string, suggestedFilename: string): void {
    const now = Date.now();
    this.hints = this.hints.filter((h) => now - h.at < HINT_TTL_MS);
    this.hints.push({ tabId, url, suggestedFilename, at: now });
  }

  private async onCreated(item: chrome.downloads.DownloadItem): Promise<void> {
    const now = Date.now();
    const hint = this.hints.find((h) => now - h.at < HINT_TTL_MS && (h.url === item.url || h.url === item.finalUrl));
    if (!hint) {
      return;
    }

    const handler = this.armed.get(hint.tabId);
    if (!handler) {
      return;
    }

    this.hints = this.hints.filter((h) => h !== hint);

    try {
      await chrome.downloads.cancel(item.id);
    } catch {
      // 已经下完：删掉文件。
      try {
        await chrome.downloads.removeFile(item.id);
      } catch {
        // 文件已经不在。
      }
    }

    try {
      await chrome.downloads.erase({ id: item.id });
    } catch {
      // 列表里已经没有。
    }

    const size = item.totalBytes > 0 ? item.totalBytes : item.fileSize > 0 ? item.fileSize : null;
    const filename = hint.suggestedFilename || item.filename.split(/[\\/]/).pop() || nameFromUrl(item.finalUrl || item.url);

    handler({ url: item.finalUrl || item.url, filename, contentType: item.mime || '', size });
  }
}
