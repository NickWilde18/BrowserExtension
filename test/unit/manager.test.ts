import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeServer, FakeTransport } from '../../src/connection/fake-transport';
import { ConnectionManager } from '../../src/connection/manager';
import type { ConnectionFrame, ConnectionStatus } from '../../src/connection/manager';

const READY = { type: 'ready', protocol: 1, heartbeat_seconds: 20, account: 'u@x.edu', max_file_bytes: 1000 };
const RID = '11111111-2222-4333-8444-555555555555';
const CONV = '66666666-7777-4888-9999-aaaaaaaaaaaa';

function setup(random = 0.999) {
  const server = new FakeServer();
  const frames: ConnectionFrame[] = [];
  const statuses: ConnectionStatus[] = [];
  let keepAlives = 0;
  const m = new ConnectionManager({
    transportFactory: () => new FakeTransport(server),
    hello: async () => ({ type: 'hello', protocol: 1, install_id: CONV, display_name: 'Chrome · Linux', extension_version: '0.1.0' }),
    onFrame: (frame) => frames.push(frame),
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
  return { m, server, frames, statuses, keepAlives: () => keepAlives };
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
    // 还没 ready：上行帧不发，报 not_connected（结果进 background 的待发队列）。
    await expect(m.send({ type: 'pong' })).rejects.toMatchObject({ reason: 'not_connected' });

    server.deliver({ type: 'request', request_id: RID, action: 'read', args: {}, conversation: CONV, deadline_ms: 1, auth_wait_ms: 1 });
    server.deliver(READY);
    expect(m.status).toMatchObject({ state: 'connected', account: 'u@x.edu' });
    expect(m.maxFileBytes).toBe(1000);
    expect(frames).toHaveLength(0);

    server.deliver({ type: 'request', request_id: RID, action: 'read', args: {}, conversation: CONV, deadline_ms: 1, auth_wait_ms: 1 });
    expect(frames).toEqual([expect.objectContaining({ type: 'request', request_id: RID })]);
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

  it('closed.replaced 不重连；server_shutdown 3 秒内重连（不退避）；unauthenticated 等登录', async () => {
    const { m, server, statuses } = setup();
    m.start();
    await tick();
    server.deliver(READY);
    server.deliver({ type: 'closed', reason: 'replaced' });
    expect(m.status.state).toBe('replaced');
    expect(m.connected).toBe(false);
    const opens = server.opens;
    await tick(120_000);
    expect(server.opens).toBe(opens);

    m.reconnectNow();
    await tick();
    server.deliver(READY);
    expect(m.connected).toBe(true);
    const beforeShutdown = server.opens;
    server.deliver({ type: 'closed', reason: 'server_shutdown' });
    await tick(3000);
    expect(server.opens).toBe(beforeShutdown + 1);
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
    expect(b.m.connected).toBe(false);
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

  it('closed.rotate（连接到了 5 分钟寿命）：立刻重连，不退避、不算失败次数', async () => {
    const { m, server } = setup(0.999);
    m.start();
    await tick();
    server.deliver(READY);
    // 先攒几次失败，确认 rotate 不沿用退避。
    for (let i = 0; i < 3; i++) {
      server.drop();
      await tick(m.status.retryAt! - Date.now());
    }

    server.deliver(READY);
    const opens = server.opens;
    server.deliver({ type: 'closed', reason: 'rotate' });
    await tick(0);
    expect(server.opens).toBe(opens + 1);
    expect(m.status.state).toBe('connecting');
  });

  it('closed.server_shutdown（Chat 副本退出）：在 0–3 秒里随机等一下再重连，不退避、不算失败次数', async () => {
    // 那个副本上的插件同时断开：不错开的话会同一时刻一起连上来。random 取两头各测一次。
    for (const [random, delay] of [[0, 0], [0.999, 2997]] as const) {
      const { m, server } = setup(random);
      m.start();
      await tick();
      server.deliver(READY);
      const opens = server.opens;
      server.deliver({ type: 'closed', reason: 'server_shutdown' });
      expect(m.status).toMatchObject({ state: 'offline', lastError: 'server_shutdown' });
      expect(m.status.retryAt! - Date.now()).toBe(delay);
      if (delay > 0) {
        await tick(delay - 1);
        expect(server.opens).toBe(opens);
      }

      await tick(1);
      expect(server.opens).toBe(opens + 1);
    }
  });

  it('stream 上 403（来源没登记）：停止重连并提示，弹窗「重新连接」才再试', async () => {
    const { m, server, keepAlives } = setup();
    server.failNextOpen = 'origin_not_allowed';
    m.start();
    await tick();
    expect(m.status).toMatchObject({ state: 'error', lastError: 'origin_not_allowed' });
    const opens = server.opens;
    await tick(300_000);
    expect(server.opens).toBe(opens);
    expect(keepAlives()).toBe(0);
    m.reconnectNow();
    await tick();
    expect(server.opens).toBe(opens + 1);
  });

  // 平台会话 Cookie 变了（同一台浏览器上退出登录、重新登录、换人登录，见 cookie-watch.ts）：网关只在请求开始时校验会话，
  // 已经开着的下行连接要插件自己断开重连，网关才按此刻的会话重新判。
  it('会话变了：连着时立刻断开重连；等登录时不等退避；停在 replaced、protocol_unsupported、插件没登记时不动', async () => {
    const { m, server } = setup(0.999);
    m.start();
    await tick();
    server.deliver(READY);
    expect(m.connected).toBe(true);

    let opens = server.opens;
    m.sessionChanged();
    await tick(0);
    expect(server.opens).toBe(opens + 1);
    expect(m.status.state).toBe('connecting');
    server.deliver(READY);
    expect(m.connected).toBe(true);

    // 退出登录之后：重连拿到 401，在退避里等登录。重新登录（会话 Cookie 又变了）就立刻重连，不等退避。
    server.failNextOpen = 'unauthenticated';
    m.sessionChanged();
    await tick(0);
    expect(m.status).toMatchObject({ state: 'waiting_login', lastError: 'unauthenticated' });
    expect(m.status.retryAt! - Date.now()).toBeGreaterThan(0);
    opens = server.opens;
    m.sessionChanged();
    await tick(0);
    expect(server.opens).toBe(opens + 1);
    server.deliver(READY);
    expect(m.connected).toBe(true);

    for (const [label, stopIt] of [
      ['replaced', () => server.deliver({ type: 'closed', reason: 'replaced' })],
      ['protocol_unsupported', () => server.deliver({ type: 'closed', reason: 'protocol_unsupported' })],
    ] as const) {
      stopIt();
      expect(m.status.state, label).toBe(label);
      opens = server.opens;
      m.sessionChanged();
      await tick(120_000);
      expect(server.opens, label).toBe(opens);
      m.reconnectNow();
      await tick(0);
      server.deliver(READY);
      expect(m.connected, label).toBe(true);
    }

    server.failNextOpen = 'origin_not_allowed';
    m.reconnectNow();
    await tick(0);
    expect(m.status).toMatchObject({ state: 'error', lastError: 'origin_not_allowed' });
    opens = server.opens;
    m.sessionChanged();
    await tick(120_000);
    expect(server.opens).toBe(opens);
  });

  describe('ready 之后先做完 beforeReady（账号变了先清上一个账号的状态，补充约定 4）才算连上', () => {
    function withHook(hook: (account: string) => Promise<void>) {
      const server = new FakeServer();
      const frames: ConnectionFrame[] = [];
      const m = new ConnectionManager({
        transportFactory: () => new FakeTransport(server),
        hello: async () => ({ type: 'hello', protocol: 1, install_id: CONV, display_name: 'Chrome · Linux', extension_version: '0.1.0' }),
        beforeReady: hook,
        onFrame: (frame) => frames.push(frame),
        onStatus: () => undefined,
        keepAlive: () => undefined,
        random: () => 0.5,
      });
      return { server, frames, m };
    }

    it('做完之前不算连上，期间到的请求类帧攒着，做完按到达顺序交出', async () => {
      const accounts: string[] = [];
      let release!: () => void;
      const { server, frames, m } = withHook((account) => {
        accounts.push(account);
        return new Promise<void>((r) => {
          release = r;
        });
      });
      m.start();
      await tick();
      server.deliver(READY);
      server.deliver({ type: 'request', request_id: RID, action: 'read', args: {}, conversation: CONV, deadline_ms: 1, auth_wait_ms: 1 });
      server.deliver({ type: 'cancel', request_id: RID });
      expect(accounts).toEqual([READY.account]);
      expect(m.status.state).toBe('connecting');
      expect(m.connected).toBe(false);
      expect(frames).toEqual([]);

      release();
      await tick();
      expect(m.status).toMatchObject({ state: 'connected', account: READY.account });
      expect(frames.map((f) => f.type)).toEqual(['request', 'cancel']);
    });

    it('做的过程中连接断了：攒着的帧丢掉，不算连上，按断线重连', async () => {
      let release!: () => void;
      const { server, frames, m } = withHook(() => new Promise<void>((r) => {
        release = r;
      }));
      m.start();
      await tick();
      server.deliver(READY);
      server.deliver({ type: 'cancel', request_id: RID });
      server.drop();
      release();
      await tick();
      expect(m.status.state).toBe('offline');
      expect(frames).toEqual([]);
    });

    it('清理失败：这条连接不用（免得新账号沿用上一个账号的授权），按退避重连，重连时再清', async () => {
      let calls = 0;
      const { server, frames, m } = withHook(async () => {
        calls++;
        if (calls === 1) {
          throw new Error('storage');
        }
      });
      m.start();
      await tick();
      server.deliver(READY);
      server.deliver({ type: 'cancel', request_id: RID });
      await tick();
      expect(m.status).toMatchObject({ state: 'offline', lastError: 'account_switch_failed' });
      expect(frames).toEqual([]);

      await tick(m.status.retryAt! - Date.now());
      server.deliver(READY);
      await tick();
      expect(calls).toBe(2);
      expect(m.status.state).toBe('connected');
    });
  });
});
