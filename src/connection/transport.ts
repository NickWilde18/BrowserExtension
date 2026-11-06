// 插件与 Chat 之间的传输层接口。
//
// 真实实现是 fetch 双向通道（fetch-transport.ts，计划第 9 节第 11 条定为 A2）；fake-transport.ts 是测试用的内存实现。
//
// 契约（Chat 仓 docs/BROWSER_EXTENSION.md 第 2 节）里与绑定无关的部分，实现必须满足：
// - 帧是 JSON 对象，open 之后第一帧由插件发 hello（ConnectionManager 负责）；
// - 认证复用浏览器里的平台会话，插件不保存、不转发任何凭据；
// - 实现里只出现平台对外地址（config.PLATFORM_ORIGIN）。

import type { OutboundFrame } from '../protocol/frames';

export interface TransportCloseInfo {
  /** 传输层能判断出的原因（如服务端拒绝认证时为 `unauthenticated`），判断不出时为空。 */
  reason?: string;
}

export interface TransportHandlers {
  /** 收到一帧（未校验的 JSON 值，由 ConnectionManager 校验）。 */
  onFrame(frame: unknown): void;
  /** 连接断开（对端关闭、网络错误）。主动 close() 之后不再回调。 */
  onClose(info: TransportCloseInfo): void;
}

/** 送回 Chat 的文件：下载拦下来的内容、存成的 PDF。 */
export interface OutgoingFile {
  kind: 'download' | 'pdf';
  name: string;
  contentType: string;
  data: Blob;
}

export interface Transport {
  /** 建立连接；失败时 reject（错误里带 TransportError.reason 时按它处理）。 */
  open(handlers: TransportHandlers): Promise<void>;
  send(frame: OutboundFrame): Promise<void>;
  close(): void;
  /** 凭上传描述里的 token 取文件内容（契约 4.6），token 只对这一个请求有效。 */
  fetchUpload(requestId: string, token: string): Promise<Blob>;
  /** 把下载或 PDF 的内容送回 Chat，返回 Chat 存成交付文件后的 file_id（契约 4.6）。 */
  sendFile(requestId: string, file: OutgoingFile): Promise<{ file_id: string }>;
}

/** 传输层报告的失败原因。reason 与 closed.reason 同一套取值（契约 3.1）。 */
export class TransportError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = 'TransportError';
    this.reason = reason;
  }
}
