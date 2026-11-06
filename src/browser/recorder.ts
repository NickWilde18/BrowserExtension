// 附着之后的控制台消息与网络请求记录（契约 4.2 的 console、network）。
//
// 只记附着之后的；网络记录返回前去掉凭据类请求头（policy/headers.ts）；请求体、响应体只在按编号单查时
// 去取，并截断。记录只在内存里，断开附着就丢。

import { stripCredentialHeaders } from '../policy/headers';

export type ConsoleLevel = 'error' | 'warning' | 'info' | 'debug';

export interface ConsoleEntry {
  level: ConsoleLevel;
  text: string;
  source: string;
}

export interface NetworkEntry {
  index: number;
  /** 调试接口的请求 id 与所在会话（取请求体、响应体用）。 */
  requestId: string;
  sessionId: string | undefined;
  method: string;
  url: string;
  type: string;
  status: number;
  mimeType: string;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  hasPostData: boolean;
  failed: string | null;
}

const MAX_CONSOLE = 500;
const MAX_NETWORK = 500;
const MAX_CONSOLE_TEXT = 2000;

export const CONSOLE_RETURN_LIMIT = 200;
export const NETWORK_RETURN_LIMIT = 200;
export const BODY_LIMIT = 20_000;

const LEVEL_RANK: Record<ConsoleLevel, number> = { error: 3, warning: 2, info: 1, debug: 0 };

/** 静态资源（network 的 static=false 时不列）。 */
const STATIC_TYPES = new Set(['Image', 'Stylesheet', 'Script', 'Font', 'Media', 'Manifest', 'TextTrack']);

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

type RemoteObject = { type?: string; value?: unknown; description?: string; unserializableValue?: string };

function describeArg(arg: RemoteObject): string {
  if (arg.unserializableValue !== undefined) {
    return arg.unserializableValue;
  }

  if (arg.type === 'string' && typeof arg.value === 'string') {
    return arg.value;
  }

  if (arg.value !== undefined) {
    try {
      return JSON.stringify(arg.value);
    } catch {
      return String(arg.value);
    }
  }

  return arg.description ?? String(arg.type ?? '');
}

function consoleLevel(type: string): ConsoleLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error';
    case 'warning':
    case 'warn':
      return 'warning';
    case 'debug':
    case 'verbose':
      return 'debug';
    default:
      return 'info';
  }
}

function sourceOf(frame: { url?: string; lineNumber?: number } | undefined): string {
  if (!frame?.url) {
    return '';
  }

  return `${frame.url}:${(frame.lineNumber ?? 0) + 1}`;
}

export class Recorder {
  private readonly consoleEntries: ConsoleEntry[] = [];
  private consoleDropped = 0;
  private readonly network: NetworkEntry[] = [];
  private readonly byRequest = new Map<string, NetworkEntry>();
  private nextIndex = 0;

  /** 调试接口事件入口（TabSession 转进来）。 */
  onEvent(method: string, params: Record<string, unknown>, sessionId: string | undefined): void {
    switch (method) {
      case 'Runtime.consoleAPICalled': {
        const args = (params.args as RemoteObject[] | undefined) ?? [];
        const stack = params.stackTrace as { callFrames?: Array<{ url?: string; lineNumber?: number }> } | undefined;
        this.pushConsole({
          level: consoleLevel(String(params.type ?? 'log')),
          text: clip(args.map(describeArg).join(' '), MAX_CONSOLE_TEXT),
          source: sourceOf(stack?.callFrames?.[0]),
        });
        return;
      }
      case 'Runtime.exceptionThrown': {
        const d = params.exceptionDetails as { text?: string; exception?: RemoteObject; url?: string; lineNumber?: number } | undefined;
        const text = [d?.text, d?.exception?.description].filter(Boolean).join(' ');
        this.pushConsole({ level: 'error', text: clip(text, MAX_CONSOLE_TEXT), source: sourceOf(d) });
        return;
      }
      case 'Log.entryAdded': {
        const e = params.entry as { level?: string; text?: string; url?: string; lineNumber?: number } | undefined;
        if (!e) {
          return;
        }

        this.pushConsole({ level: consoleLevel(e.level ?? 'info'), text: clip(e.text ?? '', MAX_CONSOLE_TEXT), source: sourceOf(e) });
        return;
      }
      case 'Network.requestWillBeSent': {
        const req = params.request as { url?: string; method?: string; headers?: Record<string, string>; hasPostData?: boolean } | undefined;
        const requestId = String(params.requestId ?? '');
        const key = `${sessionId ?? ''}|${requestId}`;
        // 重定向：同一个 requestId 再发一次，旧的那条记成重定向结果、新开一条。
        const prev = this.byRequest.get(key);
        if (prev && params.redirectResponse) {
          const rr = params.redirectResponse as { status?: number; headers?: Record<string, string>; mimeType?: string };
          prev.status = rr.status ?? prev.status;
          prev.responseHeaders = rr.headers ?? {};
          prev.mimeType = rr.mimeType ?? '';
        }

        const entry: NetworkEntry = {
          index: this.nextIndex++,
          requestId,
          sessionId,
          method: req?.method ?? 'GET',
          url: req?.url ?? '',
          type: String(params.type ?? 'Other'),
          status: 0,
          mimeType: '',
          requestHeaders: req?.headers ?? {},
          responseHeaders: {},
          hasPostData: !!req?.hasPostData,
          failed: null,
        };
        this.byRequest.set(key, entry);
        this.network.push(entry);
        if (this.network.length > MAX_NETWORK) {
          const old = this.network.shift();
          if (old && this.byRequest.get(`${old.sessionId ?? ''}|${old.requestId}`) === old) {
            this.byRequest.delete(`${old.sessionId ?? ''}|${old.requestId}`);
          }
        }

        return;
      }
      case 'Network.responseReceived': {
        const entry = this.byRequest.get(`${sessionId ?? ''}|${String(params.requestId ?? '')}`);
        const res = params.response as { status?: number; headers?: Record<string, string>; mimeType?: string } | undefined;
        if (entry && res) {
          entry.status = res.status ?? 0;
          entry.responseHeaders = res.headers ?? {};
          entry.mimeType = res.mimeType ?? '';
        }

        return;
      }
      case 'Network.loadingFailed': {
        const entry = this.byRequest.get(`${sessionId ?? ''}|${String(params.requestId ?? '')}`);
        if (entry) {
          entry.failed = String(params.errorText ?? 'failed');
        }

        return;
      }
      default:
    }
  }

  consoleMessages(min: ConsoleLevel): { messages: ConsoleEntry[]; dropped: number } {
    const rank = LEVEL_RANK[min];
    const matching = this.consoleEntries.filter((e) => LEVEL_RANK[e.level] >= rank);
    const messages = matching.slice(-CONSOLE_RETURN_LIMIT);
    return { messages, dropped: this.consoleDropped + (matching.length - messages.length) };
  }

  /** 网络请求列表（不含头与正文）。 */
  networkList(filter: string | undefined, includeStatic: boolean): Array<{ index: number; method: string; url: string; status: number; type: string }> {
    const list = this.network.filter((e) => (includeStatic || !STATIC_TYPES.has(e.type)) && (!filter || e.url.includes(filter)));
    return list.slice(-NETWORK_RETURN_LIMIT).map((e) => ({
      index: e.index,
      method: e.method,
      url: e.url,
      status: e.failed ? 0 : e.status,
      type: e.type,
    }));
  }

  entry(index: number): NetworkEntry | undefined {
    return this.network.find((e) => e.index === index);
  }

  /** 单条请求的详情（头已去凭据），正文由调用方另取后填入。 */
  detail(e: NetworkEntry): Record<string, unknown> {
    return {
      method: e.method,
      url: e.url,
      status: e.failed ? 0 : e.status,
      request_headers: stripCredentialHeaders(e.requestHeaders),
      response_headers: stripCredentialHeaders(e.responseHeaders),
    };
  }

  private pushConsole(e: ConsoleEntry): void {
    this.consoleEntries.push(e);
    if (this.consoleEntries.length > MAX_CONSOLE) {
      this.consoleEntries.shift();
      this.consoleDropped++;
    }
  }
}
