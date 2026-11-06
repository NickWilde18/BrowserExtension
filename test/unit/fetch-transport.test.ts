// 真实传输（契约第 2 节 A2：一条下行长 fetch + 上行 POST）。fetch 换成假的，钉住路径、方法、头与状态码的处理。
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FetchTransport } from '../../src/connection/fetch-transport';
import { TransportError } from '../../src/connection/transport';
import type { HelloFrame } from '../../src/protocol/frames';

const ORIGIN = 'https://platform.test';
const BASE = `${ORIGIN}/chat-service/browser/`;
const PATHS = new Set(['stream', 'frames', 'uploads', 'files'].map((p) => BASE + p));
const INSTALL = '66666666-7777-4888-9999-aaaaaaaaaaaa';
const HELLO: HelloFrame = { type: 'hello', protocol: 1, install_id: INSTALL, display_name: 'Chrome · Linux', extension_version: '0.1.0' };

interface Call { url: string; init: RequestInit }

function mockFetch(respond: (url: string, init: RequestInit) => Response | Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return respond(url, init);
  }));
  return calls;
}

/** 按给定的块依次吐出的 NDJSON 流（块边界故意切在半行里）。 */
function ndjson(chunks: string[]): { response: Response; end: () => void } {
  let ctrl!: ReadableStreamDefaultController<Uint8Array>;
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({ start(c) { ctrl = c; for (const ch of chunks) c.enqueue(enc.encode(ch)); } });
  return { response: new Response(body, { status: 200, headers: { 'Content-Type': 'application/x-ndjson' } }), end: () => ctrl.close() };
}

function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(new Headers(init.headers).entries());
}

const tick = () => new Promise((r) => setTimeout(r, 5));

function expectCleanRequests(calls: Call[]): void {
  for (const c of calls) {
    expect(PATHS.has(c.url), c.url).toBe(true);
    expect(new URL(c.url).pathname).not.toContain('//');
    expect(c.init.method).toBe('POST');
    expect(c.init.credentials).toBe('include');
    expect(Object.keys(headersOf(c.init)).map((k) => k.toLowerCase())).not.toContain('x-service');
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FetchTransport', () => {
  it('hello 作为 stream 的请求体发出；下行 NDJSON 逐行成帧，跨块的半行拼好再解析；流结束报断开', async () => {
    const s = ndjson(['{"type":"ready","protocol":1,"heartbeat_seconds":20,"acc', 'ount":"u@x","max_file_bytes":9}\n{"type":"pi', 'ng"}\n']);
    const calls = mockFetch(() => s.response);
    const frames: unknown[] = [];
    const closes: unknown[] = [];
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: (f) => frames.push(f), onClose: (i) => closes.push(i) });
    await t.send(HELLO);
    await tick();
    expect(frames).toEqual([
      { type: 'ready', protocol: 1, heartbeat_seconds: 20, account: 'u@x', max_file_bytes: 9 },
      { type: 'ping' },
    ]);
    expect(calls[0]?.url).toBe(BASE + 'stream');
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(HELLO);
    expect(headersOf(calls[0]!.init)['content-type']).toBe('application/json');
    s.end();
    await tick();
    expect(closes).toEqual([{}]);
    expectCleanRequests(calls);
  });

  it('坏的一行丢掉，不影响后面的帧', async () => {
    const s = ndjson(['not json\n{"type":"ping"}\n']);
    mockFetch(() => s.response);
    const frames: unknown[] = [];
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: (f) => frames.push(f), onClose: () => undefined });
    await t.send(HELLO);
    await tick();
    expect(frames).toEqual([{ type: 'ping' }]);
  });

  it.each([
    [401, '', 'unauthenticated'],
    [403, '', 'origin_not_allowed'],
    [404, '', 'not_enabled'],
    [429, '', 'rate_limited'],
    [400, '{"type":"closed","reason":"protocol_unsupported"}\n', 'protocol_unsupported'],
    [400, '{"type":"closed","reason":"bad_hello"}\n', 'bad_hello'],
    [503, '', 'network'],
  ])('stream 回 %i → 原因 %s', async (status, body, reason) => {
    mockFetch(() => new Response(body, { status }));
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: () => undefined, onClose: () => undefined });
    await expect(t.send(HELLO)).rejects.toEqual(new TransportError(reason as string));
  });

  // 补充约定 2：400 / 403 的响应体是一行 closed；401（未登录）/ 404（功能没开）/ 429（限流）的响应体是 JSON 错误、
  // 不是帧，只看状态码（哪怕长得像一帧 closed 也不读）。
  it.each([
    [403, '{"type":"closed","reason":"origin_not_allowed"}\n', 'origin_not_allowed'],
    [401, '{"code":401,"message":"unauthenticated"}', 'unauthenticated'],
    [401, '{"type":"closed","reason":"replaced"}\n', 'unauthenticated'],
    [404, '{"code":404,"message":"not found"}', 'not_enabled'],
    [429, '{"type":"closed","reason":"rotate"}\n', 'rate_limited'],
    // 被拒的连接不能因为响应体里写了 rotate 就立刻重连：400 只认 bad_hello / protocol_unsupported。
    [400, '{"type":"closed","reason":"rotate"}\n', 'bad_hello'],
  ])('stream 被拒：%i，响应体 %s → 原因 %s', async (status, body, reason) => {
    mockFetch(() => new Response(body, { status }));
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: () => undefined, onClose: () => undefined });
    await expect(t.send(HELLO)).rejects.toEqual(new TransportError(reason as string));
  });

  it('frames 回 413（结果超过 9 MiB，补充约定 3）：把这个结果换成 action_failed 的错误结果再发一次', async () => {
    const s = ndjson([]);
    const statuses = [413, 204];
    const calls = mockFetch((url) => (url.endsWith('/stream') ? s.response : new Response(null, { status: statuses.shift() ?? 204 })));
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: () => undefined, onClose: () => undefined });
    await t.send(HELLO);
    const big = { type: 'result' as const, request_id: '11111111-2222-4333-8444-555555555555', outcome: 'ok' as const, payload: { snapshot: 'x' } };
    await t.send(big);
    const posted = calls.filter((c) => c.url.endsWith('/frames')).map((c) => JSON.parse(String(c.init.body)));
    expect(posted).toEqual([
      { install_id: INSTALL, frame: big },
      { install_id: INSTALL, frame: { type: 'result', request_id: big.request_id, outcome: 'error', code: 'action_failed', message: 'The result was too large to send.' } },
    ]);
    expectCleanRequests(calls);
  });

  it('frames 回 413 的不是结果帧：报错，不重发', async () => {
    const s = ndjson([]);
    const calls = mockFetch((url) => (url.endsWith('/stream') ? s.response : new Response(null, { status: 413 })));
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: () => undefined, onClose: () => undefined });
    await t.send(HELLO);
    await expect(t.send({ type: 'progress', request_id: '11111111-2222-4333-8444-555555555555', stage: 'working' })).rejects.toBeInstanceOf(TransportError);
    expect(calls.filter((c) => c.url.endsWith('/frames'))).toHaveLength(1);
  });

  it('上行帧发到 frames（带 install_id）；403 / 404 丢弃这一帧不报错；其余失败报错', async () => {
    const s = ndjson([]);
    const statuses = [204, 403, 404, 500];
    const calls = mockFetch((url) => (url.endsWith('/stream') ? s.response : new Response(null, { status: statuses.shift() ?? 204 })));
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: () => undefined, onClose: () => undefined });
    await t.send(HELLO);
    const frame = { type: 'result' as const, request_id: '11111111-2222-4333-8444-555555555555', outcome: 'ok' as const };
    await t.send(frame);
    await t.send(frame);
    await t.send(frame);
    await expect(t.send(frame)).rejects.toBeInstanceOf(TransportError);
    const posted = calls.filter((c) => c.url.endsWith('/frames'));
    expect(posted).toHaveLength(4);
    expect(JSON.parse(String(posted[0]?.init.body))).toEqual({ install_id: INSTALL, frame });
    expectCleanRequests(calls);
  });

  it('上传：uploads 按令牌取原始字节；404 报 not_found', async () => {
    const s = ndjson([]);
    let first = true;
    const calls = mockFetch((url) => {
      if (url.endsWith('/stream')) {
        return s.response;
      }

      if (first) {
        first = false;
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { 'Content-Type': 'image/png' } });
      }

      return new Response(null, { status: 404 });
    });
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: () => undefined, onClose: () => undefined });
    await t.send(HELLO);
    const blob = await t.fetchUpload('r1', 'tok-1');
    expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
    expect(blob.type).toBe('image/png');
    expect(JSON.parse(String(calls.find((c) => c.url.endsWith('/uploads'))?.init.body))).toEqual({ install_id: INSTALL, token: 'tok-1' });
    await expect(t.fetchUpload('r1', 'tok-2')).rejects.toEqual(new TransportError('not_found'));
    expectCleanRequests(calls);
  });

  it('送回文件：files 用 multipart，拿回 file_id；413 报 file_too_large', async () => {
    const s = ndjson([]);
    const forms: FormData[] = [];
    let n = 0;
    const calls = mockFetch(async (url, init) => {
      if (url.endsWith('/stream')) {
        return s.response;
      }

      forms.push(init.body as FormData);
      return n++ === 0 ? Response.json({ file_id: 'f-1' }) : new Response(null, { status: 413 });
    });
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: () => undefined, onClose: () => undefined });
    await t.send(HELLO);
    const data = new Blob(['a,b\n'], { type: 'text/csv' });
    await expect(t.sendFile('11111111-2222-4333-8444-555555555555', { kind: 'download', name: '表.csv', contentType: 'text/csv', data })).resolves.toEqual({ file_id: 'f-1' });
    const form = forms[0]!;
    expect(form.get('install_id')).toBe(INSTALL);
    expect(form.get('request_id')).toBe('11111111-2222-4333-8444-555555555555');
    expect(form.get('name')).toBe('表.csv');
    expect(form.get('content_type')).toBe('text/csv');
    expect(await (form.get('file') as Blob).text()).toBe('a,b\n');
    // multipart 的边界由浏览器生成：不能自己写 Content-Type。
    expect(headersOf(calls.find((c) => c.url.endsWith('/files'))!.init)['content-type']).toBeUndefined();
    await expect(t.sendFile('r', { kind: 'pdf', name: 'x.pdf', contentType: 'application/pdf', data })).rejects.toEqual(new TransportError('file_too_large'));
    expectCleanRequests(calls);
  });

  it('close 之后中止下行流，不再报断开', async () => {
    const s = ndjson([]);
    let signal: AbortSignal | undefined;
    mockFetch((_url, init) => {
      signal = init.signal ?? undefined;
      return s.response;
    });
    const closes: unknown[] = [];
    const t = new FetchTransport(ORIGIN);
    await t.open({ onFrame: () => undefined, onClose: (i) => closes.push(i) });
    await t.send(HELLO);
    t.close();
    await tick();
    expect(signal?.aborted).toBe(true);
    expect(closes).toEqual([]);
  });
});
