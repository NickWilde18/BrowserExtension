// 内存假传输：单测与端到端测试构建用，测试代码扮演 Chat 收发帧。生产构建不打包它（background 只在
// TEST_HOOKS 时引用）。

import type { OutboundFrame } from '../protocol/frames';
import { TransportError } from './transport';
import type { OutgoingFile, Transport, TransportHandlers } from './transport';

export interface StoredFile {
  requestId: string;
  file_id: string;
  kind: OutgoingFile['kind'];
  name: string;
  contentType: string;
  size: number;
  /** 内容的 base64（测试读回比对用）。 */
  base64: string;
}

/** 测试控制面：多个 FakeTransport 实例（每次重连一个）共享它。 */
export class FakeServer {
  readonly sent: OutboundFrame[] = [];
  readonly files: StoredFile[] = [];
  readonly uploads = new Map<string, { data: Uint8Array; type: string }>();
  /** 下一次 open 失败时用的原因（测试模拟未登录等），用一次清掉。 */
  failNextOpen: string | null = null;
  current: FakeTransport | null = null;
  opens = 0;
  private listeners: Array<(frame: OutboundFrame) => void> = [];

  /** Chat → 插件：投递一帧。 */
  deliver(frame: unknown): void {
    this.current?.handlers?.onFrame(frame);
  }

  /** 模拟 Chat 断开连接。 */
  drop(reason?: string): void {
    const t = this.current;
    this.current = null;
    t?.handlers?.onClose(reason === undefined ? {} : { reason });
  }

  onSent(fn: (frame: OutboundFrame) => void): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  record(frame: OutboundFrame): void {
    this.sent.push(frame);
    for (const l of this.listeners) {
      l(frame);
    }
  }
}

export class FakeTransport implements Transport {
  handlers: TransportHandlers | null = null;
  private closed = false;

  constructor(private readonly server: FakeServer) {}

  async open(handlers: TransportHandlers): Promise<void> {
    this.server.opens++;
    if (this.server.failNextOpen) {
      const reason = this.server.failNextOpen;
      this.server.failNextOpen = null;
      throw new TransportError(reason);
    }

    this.handlers = handlers;
    this.server.current = this;
  }

  async send(frame: OutboundFrame): Promise<void> {
    if (this.closed || this.server.current !== this) {
      throw new TransportError('network', 'not connected');
    }

    this.server.record(frame);
  }

  close(): void {
    this.closed = true;
    if (this.server.current === this) {
      this.server.current = null;
    }

    this.handlers = null;
  }

  async fetchUpload(_requestId: string, token: string): Promise<Blob> {
    const up = this.server.uploads.get(token);
    if (!up) {
      throw new TransportError('not_found', 'unknown upload token');
    }

    return new Blob([up.data.slice().buffer], { type: up.type });
  }

  async sendFile(requestId: string, file: OutgoingFile): Promise<{ file_id: string }> {
    const bytes = new Uint8Array(await file.data.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    const fileId = crypto.randomUUID();
    this.server.files.push({
      requestId,
      file_id: fileId,
      kind: file.kind,
      name: file.name,
      contentType: file.contentType,
      size: bytes.length,
      base64: btoa(binary),
    });

    return { file_id: fileId };
  }
}
