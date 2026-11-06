// 连接状态机（与传输方式无关）：hello → ready、心跳超时、指数退避重连、closed.reason 的处理、保活。
// 契约见 Chat 仓 docs/BROWSER_EXTENSION.md 3.1。
//
// # 保活
//
// MV3 后台空闲 30 秒就会被回收，只靠下行数据不算活动（计划 7.1 实测：第 31 秒被回收）；调扩展 API 会
// 重置空闲计时。所以只要管理器在工作（连着、连接中、等重连），就每 20 秒调一次 keepAlive：退避等待
// 期间后台被回收的话，重连的定时器就再也不会触发（计划的权限清单里没有 alarms，没有别的唤醒手段）。
// 停在 replaced / protocol_unsupported 时不再保活，后台照常休眠。

import { KEEPALIVE_INTERVAL_MS, PROTOCOL_VERSION, READY_TIMEOUT_MS } from '../config';
import { parseInbound } from '../protocol/frames';
import type { ApprovalFrame, CancelFrame, HelloFrame, OutboundFrame, RequestFrame } from '../protocol/frames';
import { TransportError } from './transport';
import type { Transport, TransportCloseInfo } from './transport';

export type ConnectionState =
  /** 本构建没有传输层（传输方式待定）。 */
  | 'no_transport'
  | 'connecting'
  | 'connected'
  /** 平台登录态没有或过期：用户在平台网页上重新登录后自动恢复。 */
  | 'waiting_login'
  /** 同一个安装 id 有另一条连接，不自动重连（契约 3.1）。 */
  | 'replaced'
  /** Chat 不支持本插件的协议版本，要升级插件。 */
  | 'protocol_unsupported'
  /** 来源没登记、hello 被拒等配置问题，慢速重试。 */
  | 'error'
  /** 断线，等重连。 */
  | 'offline';

export interface ConnectionStatus {
  state: ConnectionState;
  /** 当前平台账号（ready.account），连上过才有。 */
  account?: string;
  /** 最近一次失败的原因（closed.reason 或传输层原因）。 */
  lastError?: string;
  /** 下次重连的时刻（毫秒时间戳）。 */
  retryAt?: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  now(): number;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  now: () => Date.now(),
};

export type ConnectionFrame = RequestFrame | CancelFrame | ApprovalFrame;

export interface ManagerDeps {
  /** 没有传输层时为 null。 */
  transportFactory: (() => Transport) | null;
  hello: () => Promise<HelloFrame>;
  /** 连接可用期间收到的请求类帧；epoch 标识是哪一条连接（审批只认自己连接上来的）。 */
  onFrame(frame: ConnectionFrame, epoch: number): void;
  /** 一条已可用的连接断开了：在跑的请求、等着的审批据此收尾。 */
  onDisconnected(epoch: number): void;
  onStatus(status: ConnectionStatus): void;
  keepAlive(): void;
  timers?: Timers;
  random?: () => number;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

export class ConnectionManager {
  private readonly timers: Timers;
  private readonly random: () => number;
  private current: Transport | null = null;
  private stateValue: ConnectionStatus = { state: 'offline' };
  private attempt = 0;
  private epochValue = 0;
  private heartbeatMs = 0;
  private lastFrameAt = 0;
  private maxFileBytesValue = 0;
  private readyTimer: unknown = null;
  private retryTimer: unknown = null;
  private watchdog: unknown = null;
  private keepAliveTimer: unknown = null;
  private started = false;

  constructor(private readonly deps: ManagerDeps) {
    this.timers = deps.timers ?? realTimers;
    this.random = deps.random ?? Math.random;
  }

  get status(): ConnectionStatus {
    return { ...this.stateValue };
  }

  /** 当前可用连接的编号；没连上时为 0。 */
  get epoch(): number {
    return this.stateValue.state === 'connected' ? this.epochValue : 0;
  }

  /** ready 里给的单个文件上限；没连上时为 0。 */
  get maxFileBytes(): number {
    return this.maxFileBytesValue;
  }

  /** 当前可用连接的传输（文件进出用）；没连上时为 null。 */
  get transport(): Transport | null {
    return this.stateValue.state === 'connected' ? this.current : null;
  }

  start(): void {
    if (this.started) {
      return;
    }

    this.started = true;
    if (!this.deps.transportFactory) {
      this.setState({ state: 'no_transport' });
      return;
    }

    this.startKeepAlive();
    void this.connect();
  }

  /** 弹窗「重新连接」：不等退避，立刻重连（也用于从 replaced / error 里恢复）。 */
  reconnectNow(): void {
    if (!this.deps.transportFactory) {
      return;
    }

    this.started = true;
    this.teardown();
    this.clearRetry();
    this.attempt = 0;
    this.startKeepAlive();
    void this.connect();
  }

  /** 发一帧；没连上时抛 TransportError('not_connected')。 */
  async send(frame: OutboundFrame): Promise<void> {
    const t = this.transport;
    if (!t) {
      throw new TransportError('not_connected');
    }

    await t.send(frame);
  }

  private async connect(): Promise<void> {
    const factory = this.deps.transportFactory;
    if (!factory) {
      return;
    }

    this.attempt++;
    this.setState({ state: 'connecting', account: this.stateValue.account });

    const t = factory();
    this.current = t;

    try {
      await t.open({
        onFrame: (raw) => this.handleRaw(t, raw),
        onClose: (info) => this.handleTransportClose(t, info),
      });
    } catch (err) {
      if (this.current === t) {
        this.handleReason(err instanceof TransportError ? err.reason : 'network');
      }

      return;
    }

    if (this.current !== t) {
      t.close();
      return;
    }

    try {
      await t.send(await this.deps.hello());
    } catch (err) {
      if (this.current === t) {
        this.handleReason(err instanceof TransportError ? err.reason : 'network');
      }

      return;
    }

    this.readyTimer = this.timers.setTimeout(() => {
      if (this.current === t && this.stateValue.state === 'connecting') {
        this.handleReason('ready_timeout');
      }
    }, READY_TIMEOUT_MS);
  }

  private handleRaw(t: Transport, raw: unknown): void {
    if (this.current !== t) {
      return;
    }

    const frame = parseInbound(raw);
    if (!frame) {
      return;
    }

    this.lastFrameAt = this.timers.now();

    switch (frame.type) {
      case 'ready':
        if (this.stateValue.state !== 'connecting') {
          return;
        }

        if (frame.protocol !== PROTOCOL_VERSION) {
          this.handleReason('protocol_unsupported');
          return;
        }

        this.clearReady();
        this.attempt = 0;
        this.epochValue++;
        this.heartbeatMs = frame.heartbeat_seconds * 1000;
        this.maxFileBytesValue = frame.max_file_bytes;
        this.setState({ state: 'connected', account: frame.account });
        this.startWatchdog(t);
        return;
      case 'ping':
        return;
      case 'closed':
        this.handleReason(frame.reason);
        return;
      default:
        if (this.stateValue.state === 'connected') {
          this.deps.onFrame(frame, this.epochValue);
        }
    }
  }

  private handleTransportClose(t: Transport, info: TransportCloseInfo): void {
    if (this.current !== t) {
      return;
    }

    this.handleReason(info.reason ?? 'network');
  }

  /** 按原因收尾并决定下一步（契约 3.1 的 closed.reason，加上传输层的原因）。 */
  private handleReason(reason: string): void {
    this.teardown();

    switch (reason) {
      case 'replaced':
        this.stopKeepAlive();
        this.setState({ state: 'replaced', lastError: reason, account: this.stateValue.account });
        return;
      case 'protocol_unsupported':
        this.stopKeepAlive();
        this.setState({ state: 'protocol_unsupported', lastError: reason });
        return;
      case 'server_shutdown':
        // Chat 副本退出：立刻重连（加一点抖动，免得所有插件同时打过来）。
        this.attempt = 0;
        this.scheduleRetry(Math.floor(this.random() * 500), 'offline', reason);
        return;
      case 'unauthenticated':
        this.scheduleRetry(this.backoff(), 'waiting_login', reason);
        return;
      case 'origin_not_allowed':
      case 'bad_hello':
        this.scheduleRetry(MAX_BACKOFF_MS, 'error', reason);
        return;
      default:
        this.scheduleRetry(this.backoff(), 'offline', reason);
    }
  }

  /** 1 秒起、每次翻倍、封顶 60 秒，乘 [0.5, 1) 的抖动。 */
  private backoff(): number {
    const base = Math.min(MAX_BACKOFF_MS, MIN_BACKOFF_MS * 2 ** Math.max(0, this.attempt - 1));
    return Math.floor(base * (0.5 + this.random() * 0.5));
  }

  private scheduleRetry(delay: number, state: ConnectionState, reason: string): void {
    this.clearRetry();
    const retryAt = this.timers.now() + delay;
    this.setState({ state, lastError: reason, retryAt, account: this.stateValue.account });
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private startWatchdog(t: Transport): void {
    this.stopWatchdog();
    const limit = this.heartbeatMs * 3;
    this.watchdog = this.timers.setInterval(() => {
      if (this.current === t && this.timers.now() - this.lastFrameAt > limit) {
        this.handleReason('heartbeat_timeout');
      }
    }, Math.max(1000, Math.floor(this.heartbeatMs / 2)));
  }

  private startKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      return;
    }

    this.keepAliveTimer = this.timers.setInterval(() => this.deps.keepAlive(), KEEPALIVE_INTERVAL_MS);
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer !== null) {
      this.timers.clearInterval(this.keepAliveTimer);
      this.keepAliveTimer = null;
    }
  }

  private stopWatchdog(): void {
    if (this.watchdog !== null) {
      this.timers.clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  private clearReady(): void {
    if (this.readyTimer !== null) {
      this.timers.clearTimeout(this.readyTimer);
      this.readyTimer = null;
    }
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) {
      this.timers.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /** 关掉当前传输；如果它是一条已可用的连接，通知上层收尾。 */
  private teardown(): void {
    const wasConnected = this.stateValue.state === 'connected';
    const epoch = this.epochValue;

    this.clearReady();
    this.stopWatchdog();

    const t = this.current;
    this.current = null;
    t?.close();

    if (wasConnected) {
      this.maxFileBytesValue = 0;
      this.deps.onDisconnected(epoch);
    }
  }

  private setState(status: ConnectionStatus): void {
    this.stateValue = status;
    this.deps.onStatus(this.status);
  }
}
