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
      await this.options.local.remove(PENDING_KEY);
      this.origin = origin;
      this.permissionGranted = true;
      this.runtime = this.options.create(origin);
      this.needsReset = false;
      this.runtime.start();
      return { ok: true };
    } catch {
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
