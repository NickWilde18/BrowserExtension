// 实测用的常驻探测进程（计划第 7 节第 2、4 项）：在 Xvfb 里起有界面的 Chrome（真实窗口尺寸、不做视口
// 模拟），加载测试构建，扮演 Chat；开一个本机控制端口，逐步下指令。
//
// 用法（在 xvfb-run 里）：node test/probe/browser-probe.mjs <控制端口> <夹具端口>
// 控制接口（都是 GET，参数放查询串，返回 JSON）：
//   /call?action=…&args=<JSON>[&conv=…]   发一个请求，等结果
//   /sw?expr=<JS 表达式>                   在插件后台求值（可用 __bxTest）
//   /page?match=<网址片段>&expr=<JS>        在某个标签页里求值
//   /front?match=<网址片段>                 把某个标签页切到前台
//   /shot?out=<文件>                        用 ffmpeg 截整个屏幕
//   /quit
import { createRequire } from 'node:module';
import { spawn, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const require = createRequire(path.join(root, 'package.json'));
const { chromium } = require('@playwright/test');

const controlPort = Number(process.argv[2] || 18970);
const fixturePort = Number(process.argv[3] || 18961);
const extDir = path.join(root, 'dist-test');
const CONV = '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0';

const fixture = spawn(process.execPath, [path.join(root, 'test/e2e/fixtures/server.mjs'), String(fixturePort)], { stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((r) => fixture.stdout.once('data', r));

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-probe-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: false,
  viewport: null,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--window-position=0,0', '--window-size=1280,900'],
});
ctx.on('page', (p) => p.on('dialog', () => undefined));

let [sw] = ctx.serviceWorkers();
if (!sw) {
  sw = await ctx.waitForEvent('serviceworker');
}

await sw.evaluate(async () => {
  const t = globalThis.__bxTest;
  const ready = { type: 'ready', protocol: 1, heartbeat_seconds: 20, account: 'probe@example.edu', max_file_bytes: 20971520 };
  t.server.onSent((f) => {
    if (f.type === 'approval_request') {
      queueMicrotask(() => t.server.deliver({ type: 'approval', request_id: f.request_id, approval_id: f.approval_id, kind: f.kind, decision: 'ask_user' }));
    }

    // 扮演 Chat：每次（重）连都回 ready。
    if (f.type === 'hello') {
      queueMicrotask(() => t.server.deliver(ready));
    }
  });
  // 心跳：不发的话 60 秒后插件按心跳超时重连。
  setInterval(() => t.server.deliver({ type: 'ping' }), 20000);
  for (let i = 0; i < 100 && !t.server.sent.some((f) => f.type === 'hello'); i++) {
    await new Promise((r) => setTimeout(r, 50));
  }
  t.server.deliver(ready);
});

let seq = 0;
async function call(action, args, conv) {
  seq++;
  const requestId = `00000000-0000-4000-9000-${seq.toString(16).padStart(12, '0')}`;
  return sw.evaluate(async ({ requestId, action, args, conv }) => {
    const t = globalThis.__bxTest;
    t.server.deliver({ type: 'request', request_id: requestId, action, args, conversation: conv, deadline_ms: 30000, auth_wait_ms: 60000 });
    for (;;) {
      const r = t.server.sent.find((f) => f.type === 'result' && f.request_id === requestId);
      if (r) {
        return r;
      }
      await new Promise((res) => setTimeout(res, 25));
    }
  }, { requestId, action, args, conv });
}

function findPage(match) {
  return ctx.pages().find((p) => p.url().includes(match));
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const q = (k) => u.searchParams.get(k);
  try {
    let out;
    switch (u.pathname) {
      case '/call':
        out = await call(q('action'), JSON.parse(q('args') || '{}'), q('conv') || CONV);
        if (out?.payload?.image?.data) {
          const file = path.join(os.tmpdir(), `bx-probe-shot-${seq}.png`);
          fs.writeFileSync(file, Buffer.from(out.payload.image.data, 'base64'));
          out.payload.image.data = `<saved ${file}>`;
        }
        break;
      case '/sw':
        out = await sw.evaluate((expr) => (0, eval)(expr), q('expr'));
        break;
      case '/page':
        out = await findPage(q('match'))?.evaluate((expr) => (0, eval)(expr), q('expr'));
        break;
      case '/front':
        await findPage(q('match'))?.bringToFront();
        out = { ok: true };
        break;
      case '/shot':
        execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', '1280x900', '-i', process.env.DISPLAY, '-frames:v', '1', q('out')]);
        out = { ok: true, file: q('out') };
        break;
      case '/quit':
        res.end('{}');
        await ctx.close();
        fixture.kill();
        process.exit(0);
      default:
        out = { error: 'unknown' };
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(out ?? null));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(err) }));
  }
});

server.listen(controlPort, '127.0.0.1', () => console.log(JSON.stringify({ ready: true, controlPort, fixturePort })));
