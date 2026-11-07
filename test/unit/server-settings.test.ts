import { describe, expect, it, vi } from 'vitest';
import { ScopedKV } from '../../src/connection/scoped-storage';
import { normalizeServerOrigin, serverHostPermission, ServerSettings, type RuntimeSession } from '../../src/connection/server-settings';
import { MemoryKV } from '../../src/storage';

function setup(local = new MemoryKV()) {
  const calls: string[] = [];
  let n = 0;
  const clear = vi.fn(async () => { calls.push('clear'); });
  const hasPermission = vi.fn(async () => true);
  const create = vi.fn((origin: string): RuntimeSession => {
    const epoch = `epoch-${++n}`;
    calls.push(`create ${origin}`);
    return { epoch, start: vi.fn(() => { calls.push(`start ${epoch}`); }), dispose: vi.fn(async () => { calls.push(`dispose ${epoch}`); }) };
  });
  const settings = new ServerSettings({ local, defaultOrigin: 'https://first.test', clear, hasPermission, create });
  return { settings, calls, clear, hasPermission, create, local };
}

describe('单活动服务器设置', () => {
  it('完整origin区分端口，但权限按协议和hostname；拒绝非origin配置', () => {
    expect(normalizeServerOrigin(' https://example.test:8443/ ')).toBe('https://example.test:8443');
    expect(serverHostPermission('https://example.test:8443')).toBe('https://example.test/*');
    for (const invalid of ['file:///a', 'https://u:p@example.test', 'https://example.test/path', 'https://example.test/?token=x', 'https://example.test/#x']) {
      expect(() => normalizeServerOrigin(invalid)).toThrow();
    }
  });

  it('同hostname换端口也先销毁旧运行期和授权，再保存并启动新运行期', async () => {
    const { settings, calls, local } = setup();
    await settings.ready;
    calls.length = 0;
    expect(await settings.select('https://first.test:8443', 'epoch-1')).toEqual({ ok: true });
    expect(calls).toEqual(['dispose epoch-1', 'clear', 'create https://first.test:8443', 'start epoch-2']);
    expect(await local.get('connection.origin')).toBe('https://first.test:8443');
    expect(await local.get('connection.pendingOrigin')).toBeUndefined();
  });

  it('权限拒绝或旧epoch不改变连接和授权，不重试权限', async () => {
    const { settings, clear, hasPermission } = setup();
    await settings.ready;
    hasPermission.mockResolvedValue(false);
    expect(await settings.select('https://other.test', 'epoch-1')).toMatchObject({ ok: false, error: 'permission_denied' });
    expect(await settings.select('https://other.test', 'obsolete')).toMatchObject({ ok: false, error: 'stale_epoch' });
    expect(clear).not.toHaveBeenCalled();
    expect(settings.origin).toBe('https://first.test');
    expect(hasPermission).toHaveBeenCalledTimes(2);
  });

  it('后台在切换事务中重启时先清旧状态，再连接已选目标', async () => {
    const local = new MemoryKV();
    await local.set('connection.origin', 'https://first.test');
    await local.set('connection.pendingOrigin', 'https://second.test');
    const { settings, calls } = setup(local);
    await settings.ready;
    expect(calls).toEqual(['clear', 'create https://second.test', 'start epoch-1']);
    expect(settings.origin).toBe('https://second.test');
  });

  it('两个设置页同时通过权限检查，也只允许一次切换提交', async () => {
    const { settings, hasPermission, create } = setup();
    await settings.ready;
    const release: Array<(value: boolean) => void> = [];
    hasPermission.mockImplementation(() => new Promise<boolean>((resolve) => { release.push(resolve); }));
    const first = settings.select('https://second.test', 'epoch-1');
    const second = settings.select('https://third.test', 'epoch-1');
    await vi.waitFor(() => expect(release).toHaveLength(2));
    release.forEach((resolve) => resolve(true));
    const results = await Promise.all([first, second]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(create).toHaveBeenCalledTimes(2);
  });

  it('切换失败后选回原来源也重建运行期，不把已销毁连接当作恢复成功', async () => {
    const { settings, clear, create } = setup();
    await settings.ready;
    clear.mockRejectedValueOnce(new Error('storage failure'));
    expect(await settings.select('https://second.test', 'epoch-1')).toMatchObject({ ok: false });
    expect(await settings.select('https://first.test', 'epoch-1')).toEqual({ ok: true });
    expect(create).toHaveBeenCalledTimes(2);
    expect(settings.runtime?.epoch).toBe('epoch-2');
  });

  it('清理失败不启动新连接，保留事务供恢复', async () => {
    const { settings, clear, local, create } = setup();
    await settings.ready;
    clear.mockRejectedValue(new Error('storage failure'));
    expect(await settings.select('https://second.test', 'epoch-1')).toMatchObject({ ok: false, error: 'switch_failed' });
    expect(create).toHaveBeenCalledTimes(1);
    expect(await local.get('connection.pendingOrigin')).toBe('https://second.test');
  });
});

describe('旧运行期存储栅栏', () => {
  it('失效后排队和迟到写入不生效，已经开始的写入完成后再清理', async () => {
    const store = new MemoryKV();
    let finish!: () => void;
    const original = store.set.bind(store);
    store.set = vi.fn(async (key, value) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      await original(key, value);
    });
    const old = new ScopedKV(store);
    const started = old.set('grant', 'old');
    await vi.waitFor(() => expect(store.set).toHaveBeenCalled());
    const queued = old.set('grant', 'queued');
    const sealed = old.seal();
    finish();
    await Promise.all([started, queued, sealed]);
    await store.remove('grant');
    await old.set('grant', 'late');
    expect(await store.get('grant')).toBeUndefined();
    expect(await old.get('grant')).toBeUndefined();
    expect(store.set).toHaveBeenCalledTimes(1);
  });
});
