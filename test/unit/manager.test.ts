import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeServer, FakeTransport } from '../../src/connection/fake-transport';
import { ConnectionManager } from '../../src/connection/manager';
import type { ConnectionFrame, ConnectionStatus } from '../../src/connection/manager';

const READY = { type: 'ready', protocol: 1, heartbeat_seconds: 20, account: 'u@x.edu', max_file_bytes: 1000 };
const RID = '11111111-2222-4333-8444-555555555555';
const CONV = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function setup(random = 0.999) {
  const server = new FakeServer();
  const frames: Array<{ frame: ConnectionFrame; epoch: number }> = [];
  const disconnected: number[] = [];
  const statuses: ConnectionStatus[] = [];
  let keepAlives = 0;
  const m = new ConnectionManager({
    transportFactory: () => new FakeTransport(server),
    hello: async () => ({ type: 'hello', protocol: 1, install_id: CONV, display_name: 'Chrome · Linux', extension_version: '0.1.0' }),
    onFrame: (frame, epoch) => frames.push({ frame, epoch }),
    onDisconnected: (e) => disconnected.push(e),
    onStatus: (s) => statuses.push(s),
    keepAlive: () => {
      keepAlives++;
    },
    timers: {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
      now: () => Date.now(),
    },
    random: () => random,
  });
  return { m, server, frames, disconnected, statuses, keepAlives: () => keepAlives };
}

const tick = async (ms = 0) => {
  await vi.advanceTimersByTimeAsync(ms);
};

describe('ConnectionManager', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('连上先发 hello，收到 ready 才算连上；ready 之前的请求帧丢弃', async () => {
    const { m, server, frames } = setup();
    m.start();
    await tick();
    expect(server.sent[0]).toMatchObject({ type: 'hello', protocol: 1 });
    expect(m.status.state).toBe('connecting');

    server.deliver({ type: 'request', request_id: RID, action: 'read', args: {}, conversation: CONV, deadline_ms: 1, auth_wait_ms: 1 });
    server.deliver(READY);
    expect(m.status).toMatchObject({ state: 'connected', account: 'u@x.edu' });
    expect(m.maxFileBytes).toBe(1000);
    expect(frames).toHaveLength(0);

    server.deliver({ type: 'request', request_id: RID, action: 'read', args: {}, conversation: CONV, deadline_ms: 1, auth_wait_ms: 1 });
    expect(frames).toEqual([expect.objectContaining({ epoch: 1 })]);
  });

  it('ready 超时、断线后按 1s 起翻倍退避重连，封顶 60s', async () => {
    const { m, server, statuses } = setup(0.999);
    m.start();
    await tick();
    await tick(15_000);
    expect(m.status.state).toBe('offline');
    expect(statuses.at(-1)?.lastError).toBe('ready_timeout');

    const delays: number[] = [];
    for (let i = 0; i < 9; i++) {
      const before = server.opens;
      const retryAt = m.status.retryAt ?? 0;
      delays.push(retryAt - Date.now());
      await tick(retryAt - Date.now());
      expect(server.opens).toBe(before + 1);
      server.drop();
      await tick();
    }

    // 1s、2s、4s…… 乘 [0.5, 1) 的抖动（这里 random≈1），封顶 60s。
    expect(delays.slice(0, 7).map((d) => Math.round(d / 1000))).toEqual([1, 2, 4, 8, 16, 32, 60]);
    expect(Math.max(...delays)).toBeLessThanOrEqual(60_000);
  });

  it('closed.replaced 不重连；server_shutdown 立刻重连；unauthenticated 等登录', async () => {
    const { m, server, disconnected, statuses } = setup();
    m.start();
    await tick();
    server.deliver(READY);
    server.deliver({ type: 'closed', reason: 'replaced' });
    expect(m.status.state).toBe('replaced');
    expect(disconnected).toEqual([1]);
    const opens = server.opens;
    await tick(120_000);
    expect(server.opens).toBe(opens);

    m.reconnectNow();
    await tick();
    server.deliver(READY);
    expect(m.epoch).toBe(2);
    server.deliver({ type: 'closed', reason: 'server_shutdown' });
    expect(m.status.retryAt! - Date.now()).toBeLessThan(500);
    await tick(500);
    server.deliver(READY);
    expect(m.status.state).toBe('connected');

    server.failNextOpen = 'unauthenticated';
    server.drop();
    await tick(1000);
    expect(m.status).toMatchObject({ state: 'waiting_login', lastError: 'unauthenticated' });
    // 登录好了（这里 failNextOpen 只生效一次）：下一次重连照常连上。
    await tick(1000);
    server.deliver(READY);
    expect(m.status.state).toBe('connected');
    expect(statuses.some((s) => s.state === 'waiting_login')).toBe(true);
  });

  it('协议版本对不上、心跳超时', async () => {
    const a = setup();
    a.m.start();
    await tick();
    a.server.deliver({ ...READY, protocol: 2 });
    expect(a.m.status.state).toBe('protocol_unsupported');

    const b = setup();
    b.m.start();
    await tick();
    b.server.deliver(READY);
    await tick(59_000);
    expect(b.m.status.state).toBe('connected');
    await tick(11_000);
    expect(b.m.status.state).toBe('offline');
    expect(b.m.status.lastError).toBe('heartbeat_timeout');
    expect(b.disconnected).toEqual([1]);
  });

  it('工作期间每 20 秒保活一次（连着、等重连都算），停在 replaced 后不再保活', async () => {
    const { m, server, keepAlives } = setup();
    m.start();
    await tick();
    server.deliver(READY);
    await tick(60_000);
    expect(keepAlives()).toBe(3);
    server.deliver({ type: 'closed', reason: 'replaced' });
    await tick(60_000);
    expect(keepAlives()).toBe(3);
  });

  it('没有传输层的构建：状态 no_transport，什么都不做', async () => {
    const m = new ConnectionManager({
      transportFactory: null,
      hello: async () => { throw new Error('unused'); },
      onFrame: () => undefined,
      onDisconnected: () => undefined,
      onStatus: () => undefined,
      keepAlive: () => undefined,
    });
    m.start();
    expect(m.status.state).toBe('no_transport');
    await expect(m.send({ type: 'pong' })).rejects.toThrow();
  });
});
