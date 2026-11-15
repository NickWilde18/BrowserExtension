// 端到端测试用的仿 Chat 服务（契约第 2 节）：插件经真实传输连它。
//
// - GET /login 下发与网关同属性的会话 Cookie（HttpOnly; SameSite=Lax; Path=/），模拟用户在平台网页上登录；
// - /browser-extension/{stream,frames,uploads,files} 四个接口，校验 Cookie 与 Origin（只认测试插件的 id）；
// - 收到 approval_request 时像现在的 Chat 一样回 ask_user（或先扣着，由测试代码从后来的连接回结论）；
// - 被拒时的响应体与 Chat 一致：400 / 403 是一行 closed，401 / 404 / 429 是 JSON 错误；
// - /__control/* 给测试代码用：下发帧、轮换连接（closed rotate）、断线、让下一次 stream / frames / files 回某个状态、
//   换账号、放上传文件、读状态。
//
// 用法：node chat-server.mjs <端口>，就绪时打印一行 {"ready":true,…}
import http from 'node:http';
import { createHash, createPublicKey, randomBytes, timingSafeEqual, verify } from 'node:crypto';
import { Readable } from 'node:stream';

const port = Number(process.argv[2] || 18963);
const codes = new Map();
const credentials = new Map();
const COOKIE = 'gfsessionid=sess-ok';
const BASE = '/browser-extension/';
/** install_id 的规范形态（小写带连字符）；不是的 frames / uploads / files 回 400（与 Chat 一致）。 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const B64URL = /^[A-Za-z0-9_-]+$/;
const SPKI_P256_PREFIX = Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex');

/** 由 raw 公钥推导 install_id（设计稿 539-INST 2.1）：SHA-256 前 16 字节，UUIDv8 + RFC 9562 变体。 */
function installIdOf(raw) {
  const h = createHash('sha256').update(raw).digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

/** 与 Chat 换凭据校验同一顺序（2.4）：长度 → 点在曲线上 → 公钥算出的 id 等于 install_id → P1363 验签。 */
function installProofValid(input) {
  if (typeof input.install_key !== 'string' || typeof input.install_proof !== 'string'
    || !B64URL.test(input.install_key) || !B64URL.test(input.install_proof)) return false;
  const raw = Buffer.from(input.install_key, 'base64url');
  const sig = Buffer.from(input.install_proof, 'base64url');
  if (raw.length !== 65 || sig.length !== 64 || raw[0] !== 4) return false;
  let key;
  try { key = createPublicKey({ key: Buffer.concat([SPKI_P256_PREFIX, raw]), format: 'der', type: 'spki' }); } catch { return false; }
  const expected = Buffer.from(installIdOf(raw));
  const got = Buffer.from(String(input.install_id));
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return false;
  const msg = Buffer.from(`chat-browser-install-proof/v1\n${input.install_id}\n${input.code}`, 'utf8');
  return verify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, sig);
}

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
  exchanges: 0,
  /** 最近一次成功换凭据的公开部分（install_id 与公钥），给测试核对重启前后是否同一把密钥。 */
  lastExchange: null,
  proofRejections: 0,
  authorizations: 0,
  logouts: 0,
  nextAuth: '',
};

/** 被拒时的响应：400 / 403 是一行 closed（与 Chat 一致），其余是 JSON 错误、不是帧。 */
function reject(res, status) {
  res.statusCode = status;
  const closed = { 400: 'bad_hello', 403: 'forbidden' }[status];
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

  if (url.pathname === '/chat/browser-extension/authorize') {
    state.authorizations++;
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const query = url.search.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    res.end(`<!doctype html><title>Authorize browser</title><form method="post" action="/chat/browser/authorize/${query}"><button name="decision" value="allow">Authorize browser</button><button name="decision" value="deny">Decline authorization</button></form>`);
    return;
  }
  if (url.pathname === '/chat/browser/authorize/' && req.method === 'POST') {
    const params = url.searchParams;
    const decision = new URLSearchParams((await body(req)).toString()).get('decision');
    const redirect = params.get('redirect_uri') || `http://127.0.0.1:${port}/chat/browser-extension/callback`;
    const callback = new URL(redirect);
    callback.searchParams.set('state', state.nextAuth === 'wrong_state' ? 'wrong-state' : params.get('state'));
    state.nextAuth = '';
    if (decision !== 'allow') callback.searchParams.set('error', 'access_denied');
    else {
      const code = randomBytes(32).toString('base64url');
      codes.set(code, { installId: params.get('install_id'), challenge: params.get('code_challenge'), redirect: params.get('redirect_uri') || '' });
      callback.searchParams.set('code', code);
    }
    res.writeHead(302, { Location: callback.href }); res.end(); return;
  }
  if (url.pathname === '/chat/browser-extension/callback') {
    res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Authorization complete</title>Return to your extension.'); return;
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
      case 'revoke':
        credentials.clear();
        send({ type: 'closed', reason: 'revoked' });
        endStream(false);
        res.end('{"ok":true}');
        return;
      case 'next-auth':
        state.nextAuth = url.searchParams.get('mode');
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
        // truncate=1：只发一部分字节就断开（Content-Length 是完整大小），模拟对象存储读到一半断了。
        uploads.set(url.searchParams.get('token'), { data: Buffer.from(url.searchParams.get('b64'), 'base64'), type: url.searchParams.get('type'), truncate: url.searchParams.get('truncate') === '1' });
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
  const credential = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  state.requests.push({
    path: url.pathname, method: req.method,
    cookie: Boolean(req.headers.cookie),
    authenticated: credentials.has(credential),
    xService: 'x-service' in req.headers,
  });

  if (req.method !== 'POST' || !['stream', 'frames', 'uploads', 'files', 'token', 'logout'].includes(name)) {
    res.statusCode = 404; res.end(); return;
  }
  if (name === 'token') {
    const input = JSON.parse((await body(req)).toString());
    const grant = codes.get(input.code); codes.delete(input.code);
    if (!grant || grant.installId !== input.install_id || grant.redirect !== input.redirect_uri
      || createHash('sha256').update(input.code_verifier).digest('base64url') !== grant.challenge) {
      reject(res, 400); return;
    }
    // 授权码已在上面取出并删掉：签名不对也不能拿同一个码重试。
    if (!installProofValid(input)) { state.proofRejections++; reject(res, 400); return; }
    state.lastExchange = { install_id: input.install_id, install_key: input.install_key };
    const value = randomBytes(32).toString('base64url');
    credentials.set(value, grant.installId);
    state.exchanges++;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ credential: value, account: state.account })); return;
  }
  // 每个请求校验独立凭据，不依赖 Cookie 或 Origin 白名单。
  if (!credentials.has(credential)) { reject(res, 401); return; }
  if (name === 'logout') {
    const input = JSON.parse((await body(req)).toString());
    if (input.install_id !== credentials.get(credential)) { reject(res, 403); return; }
    credentials.delete(credential); state.logouts++;
    send({ type: 'closed', reason: 'revoked' }); endStream(false);
    res.setHeader('Content-Type', 'application/json'); res.end('{}'); return;
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
    if (!CANONICAL_UUID.test(installId ?? '')) {
      reject(res, 400);
      return;
    }

    state.received.push({ installId, frame });
    if (frame?.type === 'approval_request') {
      if (state.holdApprovals) {
        state.heldApprovals.push(frame);
      } else {
        setTimeout(() => send({ type: 'approval', request_id: frame.request_id, approval_id: frame.approval_id, kind: frame.kind, decision: 'ask_user' }), 0);
      }
    }

    // 与 Chat 一致：统一响应中间件给空响应补 JSON，成功是 200 {}。
    res.setHeader('Content-Type', 'application/json');
    res.end('{}');
    return;
  }

  if (name === 'uploads') {
    const { install_id: installId, token } = JSON.parse((await body(req)).toString());
    if (!CANONICAL_UUID.test(installId ?? '')) {
      reject(res, 400);
      return;
    }

    const up = uploads.get(token);
    if (!up) {
      reject(res, 404);
      return;
    }

    res.writeHead(200, { 'Content-Type': up.type, 'Content-Length': String(up.data.length) });
    if (up.truncate) {
      res.write(up.data.subarray(0, Math.floor(up.data.length / 2)));
      res.socket?.destroy();
      return;
    }

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
  if (!CANONICAL_UUID.test(String(form.get('install_id') ?? ''))) {
    reject(res, 400);
    return;
  }

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
