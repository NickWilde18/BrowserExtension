// 真实传输（契约第 2 节，已定 A2：fetch 双向通道）：一条下行长 fetch 加若干上行 POST。
//
// 插件发起的 WebSocket 握手带不上 SameSite=Lax 的平台会话 Cookie，fetch 带得上（计划 7.1 实测），所以：
// - stream：POST hello，响应是 NDJSON 下行流，一行一帧；
// - frames：上行帧（result、progress、approval_request）；
// - uploads：凭令牌取上传文件的内容；
// - files：下载、PDF 的内容 multipart 送回，拿 file_id。
//
// 四个接口都在 `<平台对外地址>/chat-service/browser/` 下，一律 POST、credentials: "include"（浏览器带上平台的会话
// Cookie，网关据此注入身份；插件的 POST 带 Origin，Chat 据此认插件）。**不带 X-Service 头**：网关按路径选服务名，
// 带了就落回首段、扣用户的共用额度。插件里只有平台对外地址。

import type { OutboundFrame } from '../protocol/frames';
import { TransportError } from './transport';
import type { OutgoingFile, Transport, TransportHandlers } from './transport';

/** frames 回 413 时换上的结果说明（补充约定 3）。 */
export const RESULT_TOO_LARGE_MESSAGE = 'The result was too large to send.';

/** 失败状态 → 原因（契约 2.1 的表；与 closed.reason 同一套取值，连接状态机按它决定下一步）。 */
function reasonForStatus(status: number): string {
  switch (status) {
    case 401:
      return 'unauthenticated';
    case 403:
      return 'origin_not_allowed';
    case 404:
      return 'not_enabled';
    case 413:
      return 'file_too_large';
    case 429:
      return 'rate_limited';
    case 400:
      return 'bad_hello';
    default:
      return 'network';
  }
}

export class FetchTransport implements Transport {
  private handlers: TransportHandlers | null = null;
  private ctrl: AbortController | null = null;
  private installId = '';
  private closed = false;

  constructor(private readonly origin: string) {}

  async open(handlers: TransportHandlers): Promise<void> {
    // 连接在发 hello 时才真正建立（hello 是 stream 的请求体）。
    this.handlers = handlers;
  }

  async send(frame: OutboundFrame): Promise<void> {
    if (this.closed) {
      throw new TransportError('network', 'closed');
    }

    if (frame.type === 'hello') {
      await this.openStream(frame);
      return;
    }

    let res = await this.postFrame(frame);
    if (res.status === 413 && frame.type === 'result') {
      // 结果超过 frames 的上限（9 MiB，补充约定 3）：换成一个错误结果再发一次。截图、快照等大结果在动作里已按
      // 契约第 4 节截断，正常走不到这里。
      res = await this.postFrame({ type: 'result', request_id: frame.request_id, outcome: 'error', code: 'action_failed', message: RESULT_TOO_LARGE_MESSAGE });
    }

    // 403 / 404：请求不属于这个安装、或已经结束（多半是 Chat 已放弃的请求），丢弃这一帧。
    if (res.ok || res.status === 403 || res.status === 404) {
      return;
    }

    throw new TransportError(res.status === 413 ? 'frame_too_large' : reasonForStatus(res.status));
  }

  close(): void {
    this.closed = true;
    this.handlers = null;
    this.ctrl?.abort();
  }

  async fetchUpload(_requestId: string, token: string): Promise<Blob> {
    const res = await this.post('uploads', JSON.stringify({ install_id: this.installId, token }), 'application/json');
    if (res.ok) {
      const bytes = await res.arrayBuffer();
      return new Blob([bytes], { type: res.headers.get('content-type') ?? '' });
    }

    throw new TransportError(res.status === 403 || res.status === 404 ? 'not_found' : reasonForStatus(res.status));
  }

  async sendFile(requestId: string, file: OutgoingFile): Promise<{ file_id: string }> {
    const form = new FormData();
    form.append('install_id', this.installId);
    form.append('request_id', requestId);
    form.append('name', file.name);
    form.append('content_type', file.contentType);
    form.append('file', file.data, file.name);

    // 不写 Content-Type：multipart 的边界由浏览器生成。
    const res = await this.post('files', form, null);
    if (res.ok) {
      const body = await res.json().catch(() => null) as { file_id?: unknown } | null;
      if (typeof body?.file_id === 'string' && body.file_id !== '') {
        return { file_id: body.file_id };
      }

      throw new TransportError('network', 'files response without file_id');
    }

    throw new TransportError(res.status === 403 || res.status === 404 ? 'not_found' : reasonForStatus(res.status));
  }

  private postFrame(frame: OutboundFrame): Promise<Response> {
    return this.post('frames', JSON.stringify({ install_id: this.installId, frame }), 'application/json');
  }

  private url(name: 'stream' | 'frames' | 'uploads' | 'files'): string {
    return `${this.origin}/chat-service/browser/${name}`;
  }

  private async post(name: 'frames' | 'uploads' | 'files', body: BodyInit, contentType: string | null): Promise<Response> {
    const init: RequestInit = { method: 'POST', credentials: 'include', cache: 'no-store', body };
    if (contentType) {
      init.headers = { 'Content-Type': contentType };
    }

    try {
      return await fetch(this.url(name), init);
    } catch {
      throw new TransportError('network');
    }
  }

  /** 发 hello 打开下行流；200 之后在后台逐行读，其余状态按契约 2.1 换成原因抛出。 */
  private async openStream(hello: Extract<OutboundFrame, { type: 'hello' }>): Promise<void> {
    this.installId = hello.install_id;
    this.ctrl = new AbortController();

    let res: Response;
    try {
      res = await fetch(this.url('stream'), {
        method: 'POST',
        credentials: 'include',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(hello),
        signal: this.ctrl.signal,
      });
    } catch {
      throw new TransportError('network');
    }

    if (res.status !== 200 || !res.body) {
      let reason = reasonForStatus(res.status);
      // 补充约定 2：400 的响应体是一行 closed{bad_hello | protocol_unsupported}，403 是一行
      // closed{origin_not_allowed}（与按状态码得到的相同）；401（未登录）、404（功能没开）、429（网关限流）的响应体是
      // JSON 错误、不是帧，只看状态码。400 只认这两个原因：被拒的连接不能因为响应体里写了别的（如 rotate）就立刻重连。
      if (res.status === 400) {
        const first = (await res.text().catch(() => '')).split('\n')[0] ?? '';
        try {
          const f = JSON.parse(first) as { type?: unknown; reason?: unknown };
          if (f.type === 'closed' && (f.reason === 'bad_hello' || f.reason === 'protocol_unsupported')) {
            reason = f.reason;
          }
        } catch {
          // 响应体不是一帧：按 bad_hello。
        }
      }

      throw new TransportError(reason);
    }

    void this.read(res.body);
  }

  private async read(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    const emit = (line: string): void => {
      const text = line.trim();
      if (text === '' || this.closed) {
        return;
      }

      let frame: unknown;
      try {
        frame = JSON.parse(text);
      } catch {
        // 坏的一行丢掉，不影响后面的帧。
        return;
      }

      this.handlers?.onFrame(frame);
    };

    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        buf += decoder.decode(value, { stream: true });
        // 一个块里可能有几行，也可能只有半行：拼到换行再解析。
        let nl = buf.indexOf('\n');
        while (nl >= 0) {
          emit(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf('\n');
        }
      }

      emit(buf + decoder.decode());
    } catch {
      // 网络断开或被 close() 中止。
    }

    if (!this.closed) {
      this.handlers?.onClose({});
    }
  }
}
