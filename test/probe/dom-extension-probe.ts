// 仅 --test-hooks 且显式 --probe-url 时打包；用独立临时配置验证真实扩展 API，不进入生产包。
import type { ResultFrame } from '../../src/protocol/frames';
declare const __PROBE_URL__: string;
(async () => {
  const output: Record<string, unknown> = { actualExtension: true, transport: 'fake', pageGrant: 'test-harness' };
  let created: number | undefined;
  const wait = async <T>(read: () => T | Promise<T>, valid: (value: T) => boolean): Promise<T> => {
    for (let i = 0; i < 150; i++) {
      const value = await read();
      if (valid(value)) return value;
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error('probe condition timed out');
  };
  try {
    const test = await wait(() => (globalThis as any).__bxTest, (v) => !!v?.server);
    const ready = { type: 'ready', protocol: 1, heartbeat_seconds: 20, account: 'probe@example.invalid', max_file_bytes: 1000000 };
    test.server.onSent((frame: any) => { if (frame.type === 'hello') queueMicrotask(() => test.server.deliver(ready)); });
    await wait(() => test.server.sent.some((f: any) => f.type === 'hello'), Boolean);
    test.server.deliver(ready);
    await wait(() => test.status().state, (s) => s === 'connected');
    output.capabilities = test.server.sent.find((f: any) => f.type === 'hello').capabilities;
    let sequence = 0;
    const conversation = '20000000-0000-4000-8000-000000000001';
    const request = async (action: string, args: Record<string, unknown> = {}) => {
      const id = `10000000-0000-4000-8000-${(++sequence).toString(16).padStart(12, '0')}`;
      test.server.deliver({ type: 'request', request_id: id, action, args, conversation, conversation_title: '合成只读探针', deadline_ms: 15000, auth_wait_ms: 10000 });
      return wait<ResultFrame>(() => test.server.sent.find((f: any) => f.type === 'result' && f.request_id === id), Boolean);
    };
    const fixture = new URL(__PROBE_URL__).searchParams.get('fixture');
    if (!fixture) throw new Error('fixture origin missing');
    const tab = await chrome.tabs.create({ url: `${fixture}/form.html`, active: true });
    created = tab.id;
    if (created === undefined) throw new Error('probe tab missing');
    await wait(() => chrome.tabs.get(created!), (t) => t.status === 'complete' && t.url === `${fixture}/form.html`);
    const unsupported = await request('open', { url: `${fixture}/form.html` });
    output.unsupportedActionRejected = unsupported.code === 'unsupported_action';
    await request('read');
    await test.tabs.share(created);
    await test.sites.grant(conversation, fixture, 'conversation');
    const read = await request('read');
    const snapshot = String(read.payload?.snapshot ?? '');
    output.readCode = read.code ?? null;
    output.readPassed = read.outcome === 'ok' && snapshot.includes('textbox "Name"');
    const ref = /textbox "Name".*\[ref=([^\]]+)\]/.exec(snapshot)?.[1];
    if (ref) {
      const subtree = await request('read', { ref, boxes: true, depth: 2 });
      output.subtreePassed = subtree.outcome === 'ok';
    } else output.subtreePassed = false;
    const updated = await chrome.tabs.update(created, { url: `${fixture}/iframe.html` });
    output.frameUpdate = { path: updated?.url ? new URL(updated.url).pathname : null, status: updated?.status ?? null };
    const loaded = await wait(() => chrome.tabs.get(created!), (t) => t.status === 'complete' && t.url === `${fixture}/iframe.html`);
    output.frameWait = { path: loaded.url ? new URL(loaded.url).pathname : null, status: loaded.status ?? null };
    const beforeFrame = await wait(() => chrome.scripting.executeScript({ target: { tabId: created!, frameIds: [0] },
      func: () => ({ path: location.pathname, state: document.readyState, frames: document.querySelectorAll('iframe,frame').length }) }),
      (rows) => rows[0]?.result?.path === '/iframe.html' && rows[0].result.state === 'complete' && rows[0].result.frames >= 2);
    output.frameDocumentBeforeRead = beforeFrame[0]?.result;
    const framed = await request('read');
    output.frameResult = { outcome: framed.outcome, code: framed.code ?? null,
      path: framed.page?.url ? new URL(framed.page.url).pathname : null,
      snapshotHasFrames: String(framed.payload?.snapshot ?? '').includes('- iframe') };
    output.framesRejected = framed.code === 'unsupported_page';
    output.noPartialSnapshot = framed.payload?.snapshot === undefined;
    const observed = await chrome.scripting.executeScript({ target: { tabId: created, frameIds: [0] },
      func: () => ({ path: location.pathname, frames: document.querySelectorAll('iframe,frame').length }) });
    output.frameDocumentAfterRead = observed[0]?.result;
    output.noDebugPermission = !chrome.runtime.getManifest().permissions?.includes('debugger');
    output.passed = output.readPassed === true && output.subtreePassed === true && output.framesRejected === true
      && output.noPartialSnapshot === true && output.unsupportedActionRejected === true && output.noDebugPermission === true;
  } catch (error) {
    output.passed = false;
    output.error = error instanceof Error ? error.message.slice(0, 600) : 'probe failed';
  } finally {
    if (created !== undefined) await chrome.tabs.remove(created).catch(() => undefined);
    await fetch(__PROBE_URL__, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(output) });
  }
})();
