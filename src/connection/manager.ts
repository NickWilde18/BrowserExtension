// 连接状态机（与传输方式无关）：hello → ready、心跳超时、指数退避重连、closed.reason 的处理、保活。
// 契约见 Chat 仓 docs/BROWSER_EXTENSION.md 3.1。
//
// 连接是插件自己发起的：rotate 之后立刻重连、server_shutdown 之后 0–3 秒随机等一下再连，断线之后按退避重连，每一条新连接上来的请求类帧
// 都照常交出（旧连接上开始的请求，它的 cancel、approval 可能从新连接来）。ready 之后先做完 beforeReady（账号
// 变了先清上一个账号的状态）才算连上。
//
// # 保活
//
// MV3 后台空闲 30 秒就会被回收，只靠下行数据不算活动（计划 7.1 实测：第 31 秒被回收）；调扩展 API 会
// 重置空闲计时。所以只要管理器在工作（连着、连接中、等重连），就每 20 秒调一次 keepAlive：退避等待
// 期间后台被回收的话，重连的定时器就再也不会触发（计划的权限清单里没有 alarms，没有别的唤醒手段）。
// 停在 replaced / protocol_unsupported / 插件没登记（origin_not_allowed）时不再保活，后台照常休眠。

import { KEEPALIVE_INTERVAL_MS, PROTOCOL_VERSION, READY_TIMEOUT_MS } from '../config';
import { parseInbound } from '../protocol/frames';
import type { ApprovalFrame, CancelFrame, HelloFrame, OutboundFrame, ReadyFrame, ReleaseFrame, RequestFrame } from '../protocol/frames';
import { TransportError } from './transport';
import type { Transport, TransportCloseInfo } from './transport';

export type ConnectionState =
  | 'connecting'
  | 'connected'
  /** 平台登录态没有或过期：用户在平台网页上重新登录后自动恢复。 */
  | 'waiting_login'
  /** 同一个安装 id 有另一条连接，不自动重连（契约 3.1）。 */
  | 'replaced'
  /** Chat 不支持本插件的协议版本，要升级插件。 */
  | 'protocol_unsupported'
  /**
   * 配置问题：插件没在平台登记（stream 上的 403，lastError 为 origin_not_allowed）时停住、等用户点「重新连接」；
   * hello 被拒（bad_hello）时慢速重试。
   */
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

export type ConnectionFrame = RequestFrame | CancelFrame | ApprovalFrame | ReleaseFrame;

export interface ManagerDeps {
  /** 每次（重）连新建一个传输。 */
  transportFactory: () => Transport;
  hello: () => Promise<HelloFrame>;
  /**
   * ready 到了、连接可用之前调（账号变了先清上一个账号的状态，补充约定 4）。做完之前这条连接上到的请求类帧先攒着，
   * 做完按到达顺序交出；失败时这条连接不用，按退避重连（重连时再调）。
   */
  beforeReady?(account: string): Promise<void>;
  /** 连接可用期间收到的请求类帧（插件自己发起的下行连接上来的；轮换、重连之后的新连接也算）。 */
  onFrame(frame: ConnectionFrame): void;
  onStatus(status: ConnectionStatus): void;
  keepAlive(): void;
  timers?: Timers;
  random?: () => number;
}

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
/** closed{server_shutdown} 之后重连前随机等待的上限。 */
const SHUTDOWN_JITTER_MS = 3_000;

export class ConnectionManager {
  private readonly timers: Timers;
  private readonly random: () => number;
  private current: Transport | null = null;
  private stateValue: ConnectionStatus = { state: 'offline' };
  private attempt = 0;
  /** 收到 ready、正在做 beforeReady 的那条连接。 */
  private readying: Transport | null = null;
  /** beforeReady 做完之前到的请求类帧。 */
  private held: ConnectionFrame[] = [];
  private heartbeatMs = 0;
  private lastFrameAt = 0;
  private maxFileBytesValue = 0;
  private readyTimer: unknown = null;
  private retryTimer: unknown = null;
  private watchdog: unknown = null;
  private keepAliveTimer: unknown = null;
  private started = false;
  private disposed = false;

  constructor(private readonly deps: ManagerDeps) {
    this.timers = deps.timers ?? realTimers;
    this.random = deps.random ?? Math.random;
  }

  get status(): ConnectionStatus {
    return { ...this.stateValue };
  }

  /** 现在有没有可用的连接。 */
  get connected(): boolean {
    return this.stateValue.state === 'connected';
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
    if (this.started || this.disposed) {
      return;
    }

    this.started = true;
    this.startKeepAlive();
    void this.connect();
  }

  /** 弹窗「重新连接」：不等退避，立刻重连（也用于从 replaced / error 里恢复）。 */
  reconnectNow(): void {
    if (this.disposed) return;
    this.started = true;
    this.teardown();
    this.clearRetry();
    this.attempt = 0;
    this.startKeepAlive();
    void this.connect();
  }

  /**
   * 平台会话变了（会话 Cookie 变化，见 cookie-watch.ts）：断开当前连接、立刻重连，让网关按此刻的会话重新校验；等登录
   * 的退避也不再等。停在 replaced、protocol_unsupported、插件没登记（origin_not_allowed）时不动：换个会话解决不了，
   * 要用户在弹窗里处理。
   */
  sessionChanged(): void {
    const { state, lastError } = this.stateValue;
    if (!this.started || state === 'replaced' || state === 'protocol_unsupported' || (state === 'error' && lastError === 'origin_not_allowed')) {
      return;
    }

    this.reconnectNow();
  }

  /** 永久结束本服务器运行期；旧回调和旧重试不能重新建立连接。 */
  dispose(): void {
    this.disposed = true;
    this.started = false;
    this.teardown();
    this.clearRetry();
    this.stopKeepAlive();
    this.setState({ state: 'offline' });
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
    if (this.disposed) return;
    this.attempt++;
    this.setState({ state: 'connecting', account: this.stateValue.account });

    const t = this.deps.transportFactory();
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

    if (this.current !== t || this.disposed) return;
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
      case 'ready': {
        if (this.stateValue.state !== 'connecting' || this.readying === t) {
          return;
        }

        if (frame.protocol !== PROTOCOL_VERSION) {
          this.handleReason('protocol_unsupported');
          return;
        }

        const hook = this.deps.beforeReady;
        if (!hook) {
          this.becomeConnected(t, frame);
          return;
        }

        this.readying = t;
        let pending: Promise<void>;
        try {
          pending = hook.call(this.deps, frame.account);
        } catch (err) {
          pending = Promise.reject(err);
        }

        void pending.then(() => true, () => false).then((ok) => this.readyDone(t, frame, ok));
        return;
      }
      case 'ping':
        return;
      case 'closed':
        this.handleReason(frame.reason);
        return;
      default:
        if (this.readying === t) {
          this.held.push(frame);
        } else if (this.stateValue.state === 'connected') {
          this.deps.onFrame(frame);
        }
    }
  }

  /** beforeReady 做完：成功就算连上，把期间攒着的帧按到达顺序交出。 */
  private readyDone(t: Transport, frame: ReadyFrame, ok: boolean): void {
    if (this.readying !== t) {
      // 做的过程中这条连接已经断了（或 ready 超时）：攒着的帧已随它丢掉。
      return;
    }

    this.readying = null;
    if (!ok) {
      // 上一个账号的状态没清掉：这条连接不用（免得新账号沿用上一个账号的授权），按退避重连，重连时再清。
      this.handleReason('account_switch_failed');
      return;
    }

    this.becomeConnected(t, frame);
    for (const f of this.held.splice(0)) {
      this.deps.onFrame(f);
    }
  }

  private becomeConnected(t: Transport, frame: ReadyFrame): void {
    this.clearReady();
    this.attempt = 0;
    this.heartbeatMs = frame.heartbeat_seconds * 1000;
    this.maxFileBytesValue = frame.max_file_bytes;
    this.setState({ state: 'connected', account: frame.account });
    this.startWatchdog(t);
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
      case 'rotate':
        // 下行连接到了寿命（契约 2.2，Chat 每条连接最多 5 分钟）：立刻重连，不退避、不算失败次数；各连接到点的时刻本来
        // 就错开。Chat 这时保留在线标记，空档里发来的请求改投到新连接（补充约定 5）。
        this.attempt = 0;
        this.scheduleRetry(0, 'offline', reason);
        return;
      case 'server_shutdown':
        // Chat 副本退出：那个副本上的插件同时断开，在 0–3 秒里随机等一下再重连，免得同一时刻一起连上来（契约 2.2）。
        // 不退避、不算失败次数；Chat 同样保留在线标记、改投空档里的请求。
        this.attempt = 0;
        this.scheduleRetry(Math.floor(this.random() * SHUTDOWN_JITTER_MS), 'offline', reason);
        return;
      case 'unauthenticated':
        // 没有登录态（stream 回 401；Chat 不发 closed{unauthenticated}）：提示用户在平台网页上重新登录，之后按退避
        // 重试（登录好了下一次就连上）。
        this.scheduleRetry(this.backoff(), 'waiting_login', reason);
        return;
      case 'origin_not_allowed':
        // 插件 id 没在平台登记（stream 上的 403）：停止并提示，重试也不会好；弹窗「重新连接」再试。
        this.stopKeepAlive();
        this.setState({ state: 'error', lastError: reason, account: this.stateValue.account });
        return;
      case 'bad_hello':
        this.scheduleRetry(MAX_BACKOFF_MS, 'error', reason);
        return;
      default:
        // 网络断开、心跳超时、404（功能没开）、429（限流）等：按退避重试。
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

  /**
   * 关掉当前传输。在跑的请求、等着的审批不在这里收尾：它们的 cancel、approval 可能从下一条连接来（补充约定 1），
   * 结果在断线期间进 background 的待发队列。
   */
  private teardown(): void {
    this.clearReady();
    this.stopWatchdog();
    this.readying = null;
    this.held = [];
    this.maxFileBytesValue = 0;

    const t = this.current;
    this.current = null;
    t?.close();
  }

  private setState(status: ConnectionStatus): void {
    this.stateValue = status;
    this.deps.onStatus(this.status);
  }
}
