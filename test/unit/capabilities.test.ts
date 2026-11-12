import { afterEach, describe, expect, it, vi } from 'vitest';
import { runRequest } from '../../src/actions';
import { createExecutionBackend } from '../../src/browser/backend';
import { ACTIONS } from '../../src/protocol/frames';
import { Identity, MemoryKeyStore } from '../../src/identity';
import { MemoryKV } from '../../src/storage';
import type { Services } from '../../src/actions/context';
import type { RequestFrame } from '../../src/protocol/frames';

const request: RequestFrame = { type: 'request', request_id: '10000000-0000-4000-8000-000000000001', conversation: '20000000-0000-4000-8000-000000000001', conversation_title: '', action: 'read', args: {}, deadline_ms: 1000, auth_wait_ms: 1000 };

afterEach(() => vi.unstubAllGlobals());

describe('设备动作能力边界', () => {
  it('hello 区分旧版缺字段、空能力和只读能力', async () => {
    vi.stubGlobal('chrome', { runtime: { getManifest: () => ({ version: '0.1.0' }) } });
    const identity = new Identity(new MemoryKV(), new MemoryKeyStore());
    await identity.setDisplayName('Test browser');
    expect(await identity.hello()).not.toHaveProperty('capabilities');
    expect(await identity.hello([])).toMatchObject({ capabilities: { actions: [] } });
    expect(await identity.hello(['read'])).toMatchObject({ capabilities: { actions: ['read'] } });
  });
  it('安全前置 API 不完整时声明空能力，完整只读前置只声明 read', () => {
    vi.stubGlobal('chrome', { tabs: { get: vi.fn() }, permissions: { contains: vi.fn() } });
    expect(createExecutionBackend(vi.fn()).actions).toEqual([]);
    vi.stubGlobal('chrome', { tabs: { get: vi.fn() }, permissions: { contains: vi.fn() }, scripting: { executeScript: vi.fn() } });
    expect(createExecutionBackend(vi.fn()).actions).toEqual(['read']);
  });

  it('完整调试 API 保留既有动作表和执行入口', () => {
    const execute = vi.fn();
    vi.stubGlobal('chrome', { debugger: { attach: vi.fn(), sendCommand: vi.fn(), detach: vi.fn(),
      onEvent: { addListener: vi.fn() }, onDetach: { addListener: vi.fn() } } });
    const backend = createExecutionBackend(execute);
    expect(backend.actions).toEqual(ACTIONS);
    expect(backend.execute).toBe(execute);
  });
  it('即使旧服务器下发未声明动作，也先拒绝，不触碰标签或权限', async () => {
    const touch = vi.fn(async () => null);
    const execute = vi.fn();
    const services = { backend: { actions: [], execute },
      tabs: { touch, active: vi.fn(async () => null) }, stopped: () => false,
      notices: { take: () => [], add: () => {} },
    } as unknown as Services;
    const result = await runRequest(services, request, new AbortController().signal);
    expect(result).toMatchObject({ outcome: 'error', code: 'unsupported_action' });
    expect(touch).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });
});
