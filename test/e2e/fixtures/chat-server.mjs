// 端到端测试用的仿 Chat 服务（契约第 2 节）：插件经真实传输连它。
//
// - GET /login 下发与网关同属性的会话 Cookie（HttpOnly; SameSite=Lax; Path=/），模拟用户在平台网页上登录；
// - /chat-service/browser/{stream,frames,uploads,files} 四个接口，校验 Cookie 与 Origin（只认测试插件的 id）；
// - 收到 approval_request 时像现在的 Chat 一样回 ask_user（或先扣着，由测试代码从后来的连接回结论）；
// - 被拒时的响应体与 Chat 一致：400 / 403 是一行 closed，401 / 404 / 429 是 JSON 错误；
// - /__control/* 给测试代码用：下发帧、轮换连接（closed rotate）、断线、让下一次 stream / frames / files 回某个状态、
//   换账号、放上传文件、读状态。
//
// 用法：node chat-server.mjs <端口>，就绪时打印一行 {"ready":true,…}
import http from 'node:http';
import { Readable } from 'node:stream';

const port = Number(process.argv[2] || 18963);
const EXT_ORIGIN = 'chrome-extension://agagklnjfndomhambbpfhenaoclcbpmo';
const COOKIE = 'gfsessionid=sess-ok';
const BASE = '/chat-service/browser/';

const state = {
  requests: [],
  received: [],
  hellos: [],
  files: [],
  streamCount: 0,
  nextStreamStatus: [],
  nextFramesStatus: [],
  nextFilesStatus: [],
  account: 'first.user@example.test',
  holdApprovals: false,
  heldApprovals: [],
};

/** 被拒时的响应：400 / 403 是一行 closed（与 Chat 一致），其余是 JSON 错误、不是帧。 */
function reject(res, status) {
  res.statusCode = status;
  const closed = { 400: 'bad_hello', 403: 'origin_not_allowed' }[status];
  if (closed) {
    res.setHeader('Content-Type', 'application/x-ndjson');
    res.end(JSON.stringify({ type: 'closed', reason: closed }) + '\n');
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ code: status, message: 'rejected' }));
}
const uploads = new Map();
let stream = null;
let pingTimer = null;

function send(frame) {
  if (!stream) {
    return false;
  }

  stream.write(JSON.stringify(frame) + '\n');
  return true;
}

function endStream(destroy) {
  clearInterval(pingTimer);
  const s = stream;
  stream = null;
  if (s) {
    if (destroy) {
      s.socket?.destroy();
    } else {
      s.end();
    }
  }
}

async function body(req) {
  const chunks = [];
  for await (const c of req) {
    chunks.push(c);
  }

  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${port}`);

  if (url.pathname === '/login') {
    res.setHeader('Set-Cookie', `${COOKIE}; Path=/; HttpOnly; SameSite=Lax`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end('<!doctype html><title>Platform</title><p>signed in</p>');
    return;
  }

  if (url.pathname.startsWith('/__control/')) {
    const op = url.pathname.slice('/__control/'.length);
    res.setHeader('Content-Type', 'application/json');
    switch (op) {
      case 'state':
        res.end(JSON.stringify({ ...state, streamOpen: stream !== null }));
        return;
      case 'send':
        res.end(JSON.stringify({ ok: send(JSON.parse(url.searchParams.get('frame'))) }));
        return;
      case 'rotate':
        send({ type: 'closed', reason: 'rotate' });
        endStream(false);
        res.end('{"ok":true}');
        return;
      case 'drop':
        endStream(true);
        res.end('{"ok":true}');
        return;
      case 'next-stream':
        state.nextStreamStatus.push(Number(url.searchParams.get('status')));
        res.end('{"ok":true}');
        return;
      case 'next-frames':
        state.nextFramesStatus.push(Number(url.searchParams.get('status')));
        res.end('{"ok":true}');
        return;
      case 'next-files':
        state.nextFilesStatus.push(Number(url.searchParams.get('status')));
        res.end('{"ok":true}');
        return;
      case 'account':
        // 之后的 ready 用这个账号（同一个浏览器换了平台账号）。
        state.account = url.searchParams.get('value');
        res.end('{"ok":true}');
        return;
      case 'hold-approvals':
        state.holdApprovals = url.searchParams.get('on') === '1';
        res.end('{"ok":true}');
        return;
      case 'approve': {
        // 从当前这条连接回一个扣着的审批（它的请求是在更早的连接上收到的）。
        const held = state.heldApprovals.shift();
        const ok = held ? send({ type: 'approval', request_id: held.request_id, approval_id: held.approval_id, kind: held.kind, decision: url.searchParams.get('decision') }) : false;
        res.end(JSON.stringify({ ok }));
        return;
      }
      case 'upload':
        uploads.set(url.searchParams.get('token'), { data: Buffer.from(url.searchParams.get('b64'), 'base64'), type: url.searchParams.get('type') });
        res.end('{"ok":true}');
        return;
      default:
        res.statusCode = 404;
        res.end('{}');
        return;
    }
  }

  if (!url.pathname.startsWith(BASE)) {
    res.statusCode = 404;
    res.end();
    return;
  }

  const name = url.pathname.slice(BASE.length);
  const cookie = req.headers.cookie ?? '';
  state.requests.push({
    path: url.pathname,
    method: req.method,
    origin: req.headers.origin ?? null,
    cookie: cookie.includes(COOKIE),
    xService: 'x-service' in req.headers,
  });

  if (req.method !== 'POST' || !['stream', 'frames', 'uploads', 'files'].includes(name)) {
    res.statusCode = 404;
    res.end();
    return;
  }

  // 网关：没有登录态就 401。
  if (!cookie.includes(COOKIE)) {
    reject(res, 401);
    return;
  }

  // Chat：只认登记的插件来源。
  if (req.headers.origin !== EXT_ORIGIN) {
    reject(res, 403);
    return;
  }

  if (name === 'stream') {
    const raw = await body(req);
    const forced = state.nextStreamStatus.shift();
    if (forced) {
      reject(res, forced);
      return;
    }

    let hello;
    try {
      hello = JSON.parse(raw.toString());
    } catch {
      hello = null;
    }

    if (hello?.type !== 'hello' || hello.protocol !== 1) {
      res.statusCode = 400;
      res.end(JSON.stringify({ type: 'closed', reason: hello?.protocol !== 1 ? 'protocol_unsupported' : 'bad_hello' }) + '\n');
      return;
    }

    endStream(false);
    state.hellos.push(hello);
    state.streamCount++;
    res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    stream = res;
    req.on('close', () => {
      if (stream === res) {
        stream = null;
        clearInterval(pingTimer);
      }
    });
    send({ type: 'ready', protocol: 1, heartbeat_seconds: 20, account: state.account, max_file_bytes: 20971520 });
    pingTimer = setInterval(() => send({ type: 'ping' }), 20000);
    return;
  }

  if (name === 'frames') {
    const raw = await body(req);
    const forced = state.nextFramesStatus.shift();
    if (forced) {
      reject(res, forced);
      return;
    }

    const { install_id: installId, frame } = JSON.parse(raw.toString());
    state.received.push({ installId, frame });
    if (frame?.type === 'approval_request') {
      if (state.holdApprovals) {
        state.heldApprovals.push(frame);
      } else {
        setTimeout(() => send({ type: 'approval', request_id: frame.request_id, approval_id: frame.approval_id, kind: frame.kind, decision: 'ask_user' }), 0);
      }
    }

    res.statusCode = 204;
    res.end();
    return;
  }

  if (name === 'uploads') {
    const { token } = JSON.parse((await body(req)).toString());
    const up = uploads.get(token);
    if (!up) {
      res.statusCode = 404;
      res.end();
      return;
    }

    res.setHeader('Content-Type', up.type);
    res.end(up.data);
    return;
  }

  // files：multipart/form-data
  const forcedFiles = state.nextFilesStatus.shift();
  if (forcedFiles) {
    await body(req);
    reject(res, forcedFiles);
    return;
  }

  const form = await new Request(`http://x${url.pathname}`, { method: 'POST', headers: req.headers, body: Readable.toWeb(req), duplex: 'half' }).formData();
  const file = form.get('file');
  const bytes = Buffer.from(await file.arrayBuffer());
  const fileId = `00000000-0000-4000-b000-${String(state.files.length + 1).padStart(12, '0')}`;
  state.files.push({
    file_id: fileId,
    install_id: form.get('install_id'),
    request_id: form.get('request_id'),
    name: form.get('name'),
    content_type: form.get('content_type'),
    size: bytes.length,
    text: bytes.toString('utf8'),
  });
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ file_id: fileId }));
});

server.listen(port, '127.0.0.1', () => process.stdout.write(JSON.stringify({ ready: true, port }) + '\n'));
