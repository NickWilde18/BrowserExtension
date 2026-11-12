// 安装密钥实测探针（设计稿 539-INST 第 3 节）的后台脚本。只在 test/probe/install-key.mjs 生成的临时扩展里用，
// 不进生产包。每次后台启动（首次安装、重启浏览器、后台被回收后被闹钟唤醒、升级）都跑一遍：
// 取 IndexedDB 里的 CryptoKeyPair，没有就生成并存进去；检查不可导出、签名格式，结果发给本机收集器。
// 收集器地址由运行脚本写进 probe-config.js。
import { COLLECTOR, WAKE_MINUTES } from './probe-config.js';

const api = globalThis.browser ?? globalThis.chrome;
const boot = crypto.randomUUID();
const PREFIX = 'chat-browser-install-proof/v1';

function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('install-key-probe', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('keys');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, run) {
  return new Promise((resolve, reject) => {
    const t = db.transaction('keys', mode);
    const req = run(t.objectStore('keys'));
    let value;
    req.onsuccess = () => { value = req.result; };
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(t.error ?? req.error);
    t.onabort = () => reject(t.error ?? new Error('aborted'));
  });
}

async function installId(raw) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', raw)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const hex = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function exportError(key, format) {
  try { await crypto.subtle.exportKey(format, key); return null; } catch (e) { return e?.name ?? String(e); }
}

async function report(body) {
  const res = await fetch(COLLECTOR, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
  const reply = await res.json().catch(() => ({}));
  // 运行脚本已把扩展文件换成新版本：重载即浏览器的扩展更新流程。
  if (reply.reload) api.runtime.reload();
}

async function probe(trigger) {
  const out = {
    trigger, boot, version: api.runtime.getManifest().version, userAgent: navigator.userAgent,
    context: typeof ServiceWorkerGlobalScope !== 'undefined' && globalThis instanceof ServiceWorkerGlobalScope ? 'service_worker' : 'event_page',
  };
  try {
    const db = await openDb();
    let pair = await tx(db, 'readonly', (s) => s.get('install'));
    out.found = pair !== undefined;
    if (!pair) {
      pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
      out.generated = true;
      try { await tx(db, 'readwrite', (s) => s.put(pair, 'install')); out.stored = true; } catch (e) { out.stored = false; out.storeError = String(e); }
      // 从库里重新读一次，后面全用读回来的对象（验证 structured clone 往返）。
      pair = await tx(db, 'readonly', (s) => s.get('install'));
    }
    out.isCryptoKey = pair?.privateKey instanceof CryptoKey && pair?.publicKey instanceof CryptoKey;
    const priv = pair.privateKey;
    out.privateKey = { type: priv.type, extractable: priv.extractable, usages: [...priv.usages], algorithm: priv.algorithm };
    out.publicKey = { type: pair.publicKey.type, extractable: pair.publicKey.extractable, usages: [...pair.publicKey.usages] };
    const raw = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
    out.rawLength = raw.length;
    out.rawFirstByte = raw[0];
    out.install_key = b64url(raw);
    out.install_id = await installId(raw);
    out.exportErrors = { pkcs8: await exportError(priv, 'pkcs8'), jwk: await exportError(priv, 'jwk') };
    out.code = `probe-${boot}`;
    const message = new TextEncoder().encode(`${PREFIX}\n${out.install_id}\n${out.code}`);
    const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, priv, message));
    out.signatureLength = sig.length;
    out.install_proof = b64url(sig);
  } catch (e) {
    out.error = `${e?.name ?? ''}: ${e?.message ?? String(e)}`;
  }
  await report(out);
  // 每次启动排一个闹钟；后台空闲被回收后由它唤醒，收集器看到同一浏览器进程里出现新的 boot 即为「回收后再唤醒」。
  if (trigger === 'boot') await api.alarms.create('wake', { delayInMinutes: WAKE_MINUTES });
}

api.runtime.onInstalled.addListener((details) => { void report({ trigger: 'installed', boot, reason: details.reason, version: api.runtime.getManifest().version }); });
// 浏览器启动时唤起后台（MV3 service worker 不会无故启动）。
api.runtime.onStartup.addListener(() => undefined);
api.alarms.onAlarm.addListener(() => { void probe('alarm'); });
void probe('boot');
