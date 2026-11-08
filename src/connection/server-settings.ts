import type { KV } from '../storage';

const ORIGIN_KEY = 'connection.origin';
const PENDING_KEY = 'connection.pendingOrigin';

/** 唯一允许持久保存的 URL 配置：用户明确选定的平台连接 origin。 */
export function normalizeServerOrigin(raw: string): string {
  const value = raw.trim();
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash || !['', '/'].includes(u.pathname)) {
    throw new Error('invalid_origin');
  }
  return u.origin;
}

export function serverHostPermission(origin: string): string {
  const u = new URL(origin);
  return `${u.protocol}//${u.hostname}/*`;
}

export interface RuntimeSession {
  readonly epoch: string;
  start(): void;
  /** 是否已连接或已进入独立授权状态；无凭据时尚未验证远端可达性。只有切服事务等待它。 */
  waitForConnection(): Promise<boolean>;
  dispose(): Promise<void>;
}

export class ServerSettings<T extends RuntimeSession> {
  origin: string;
  runtime: T | null = null;
  switching = false;
  permissionGranted = false;
  private needsReset = false;
  readonly ready: Promise<void>;

  constructor(private readonly options: {
    local: KV; defaultOrigin: string;
    create(origin: string): T;
    hasPermission(origin: string): Promise<boolean>;
    clear(): Promise<void>;
  }) {
    this.origin = options.defaultOrigin;
    this.ready = this.initialize();
  }

  async select(raw: string, epoch: string): Promise<{ ok: boolean; error?: string }> {
    await this.ready;
    if (this.switching) return { ok: false, error: 'switching' };
    if (epoch !== this.runtime?.epoch) return { ok: false, error: 'stale_epoch' };
    let origin: string;
    try { origin = normalizeServerOrigin(raw); } catch { return { ok: false, error: 'invalid_origin' }; }
    // popup 在用户手势中申请权限；后台只验权限，不能绕过浏览器的拒绝。
    if (!await this.options.hasPermission(origin)) return { ok: false, error: 'permission_denied' };
    if (this.switching) return { ok: false, error: 'switching' };
    if (epoch !== this.runtime?.epoch) return { ok: false, error: 'stale_epoch' };
    if (origin === this.origin && !this.needsReset) {
      this.permissionGranted = true;
      this.runtime.start();
      return { ok: true };
    }
    const previousOrigin = this.origin;
    let targetStarted = false;
    this.switching = true;
    this.needsReset = true;
    try {
      // dispose 同步失效旧 epoch；随后记录切换事务，后台重启也先清旧状态。
      const disposing = this.runtime.dispose();
      // 立即接住拒绝，避免持久写入尚未完成时出现未处理的 Promise rejection。
      const disposed = disposing.then(() => ({ ok: true as const }), () => ({ ok: false as const }));
      await this.options.local.set(PENDING_KEY, origin);
      if (!(await disposed).ok) throw new Error('dispose_failed');
      await this.options.clear();
      await this.options.local.set(ORIGIN_KEY, origin);
      this.origin = origin;
      this.permissionGranted = true;
      this.runtime = this.options.create(origin);
      targetStarted = true;
      this.runtime.start();
      if (!await this.runtime.waitForConnection()) throw new Error('connection_failed');
      await this.options.local.remove(PENDING_KEY);
      this.needsReset = false;
      return { ok: true };
    } catch {
      if (targetStarted) {
        try {
          // 新平台已启动但未握手成功：销毁其运行期并恢复原地址。授权、共享和接管状态不复原。
          await this.runtime!.dispose();
          await this.options.local.set(PENDING_KEY, previousOrigin);
          await this.options.clear();
          await this.options.local.set(ORIGIN_KEY, previousOrigin);
          await this.options.local.remove(PENDING_KEY);
          this.origin = previousOrigin;
          this.permissionGranted = await this.options.hasPermission(previousOrigin);
          this.runtime = this.options.create(previousOrigin);
          this.needsReset = false;
          if (this.permissionGranted) this.runtime.start();
          return { ok: false, error: 'rolled_back' };
        } catch {
          // 存储/清理失败仍保留事务，让下次启动完成恢复；不能向界面宣称已回退。
        }
      }
      return { ok: false, error: 'switch_failed' };
    } finally {
      this.switching = false;
    }
  }

  private async initialize(): Promise<void> {
    const pending = await this.options.local.get<string>(PENDING_KEY);
    const saved = await this.options.local.get<string>(ORIGIN_KEY);
    this.origin = normalizeServerOrigin(pending ?? saved ?? this.options.defaultOrigin);
    if (pending !== undefined) {
      await this.options.clear();
      await this.options.local.set(ORIGIN_KEY, this.origin);
      await this.options.local.remove(PENDING_KEY);
    }
    this.permissionGranted = await this.options.hasPermission(this.origin);
    this.runtime = this.options.create(this.origin);
    if (this.permissionGranted) this.runtime.start();
  }
}
