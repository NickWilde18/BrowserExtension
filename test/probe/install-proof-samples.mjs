// 生成浏览器真签的换凭据持有证明样本（设计稿 539-INST 3.5），供 Chat 侧回归测试当固定数据。
//
// 用法：node test/probe/install-proof-samples.mjs [firefox 探针结果.json]
// - Chromium：用 Playwright 起插件测试构建（dist-test-fetch，先 pnpm build:test），在后台里调用插件自己的
//   identity.prove()，即生产代码的签名路径；同一把密钥签两个授权码，再重启浏览器签一个。
// - Firefox：取 test/probe/install-key.mjs 在 Firefox 事件后台里真签的样本（同样的 WebCrypto 调用，探针扩展）。
// 每个样本写入前都用 Node 按 Chat 侧同一判据（install_id 由公钥算出、P1363 验签）复核。
import { chromium } from '@playwright/test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const extDir = path.join(root, 'dist-test-fetch');
const out = path.join(root, 'test/fixtures/install-proof/samples.json');
const [firefoxProbe] = process.argv.slice(2);

function installIdOf(raw) {
  const h = crypto.createHash('sha256').update(raw).digest().subarray(0, 16);
  h[6] = (h[6] & 0x0f) | 0x80;
  h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}
function check(s) {
  const raw = Buffer.from(s.install_key, 'base64url');
  const sig = Buffer.from(s.install_proof, 'base64url');
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), raw]), format: 'der', type: 'spki' });
  const ok = raw.length === 65 && sig.length === 64 && installIdOf(raw) === s.install_id
    && crypto.verify('sha256', Buffer.from(`chat-browser-install-proof/v1\n${s.install_id}\n${s.code}`), { key, dsaEncoding: 'ieee-p1363' }, sig);
  if (!ok) throw new Error(`sample does not verify: ${JSON.stringify(s)}`);
  return s;
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-install-proof-'));
const samples = [];
try {
  let ctx;
  let userAgent = '';
  const sign = async (step) => {
    ctx = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
      args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`] });
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
    userAgent = await sw.evaluate(() => navigator.userAgent);
    const codes = step === 'first-run' ? [crypto.randomBytes(32).toString('base64url'), crypto.randomBytes(32).toString('base64url')]
      : [crypto.randomBytes(32).toString('base64url')];
    for (const code of codes) {
      const proof = await sw.evaluate((c) => globalThis.__bxTest.identity.prove(c), code);
      samples.push(check({ browser: 'chromium', step, source: 'extension identity.prove (dist-test-fetch)', userAgent, code,
        install_id: proof.install_id, install_key: proof.install_key, install_proof: proof.install_proof }));
    }
    await ctx.close();
  };
  await sign('first-run');
  await sign('after-browser-restart');
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}

if (firefoxProbe) {
  const probe = JSON.parse(fs.readFileSync(firefoxProbe, 'utf8'));
  if (!probe.passed) throw new Error('firefox probe did not pass');
  const pick = { install: 'first-run', restart: 'after-browser-restart', upgrade: 'after-upgrade' };
  for (const [k, step] of Object.entries(pick)) {
    const r = probe.steps[k].report;
    samples.push(check({ browser: 'firefox', step, source: 'test/probe/install-key.mjs (event page)', userAgent: r.userAgent, code: r.code,
      install_id: r.install_id, install_key: r.install_key, install_proof: r.install_proof }));
  }
}

const doc = {
  description: '浏览器真签的换凭据持有证明样本（设计稿 539-INST 2.1–2.3）。install_key = raw 公钥（65 字节未压缩点），'
    + 'install_proof = ECDSA P-256/SHA-256 对 "chat-browser-install-proof/v1\\n<install_id>\\n<code>" 的签名（IEEE P1363，64 字节），'
    + '均为无填充 base64url；install_id = SHA-256(raw 公钥) 前 16 字节置 UUIDv8 版本位与 RFC 9562 变体位。'
    + '同一 browser 的样本是同一把密钥（install_id 相同）。由 test/probe/install-proof-samples.mjs 生成。',
  generated: new Date().toISOString().slice(0, 10),
  samples,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(doc, null, 2) + '\n');
console.log(JSON.stringify({ out, count: samples.length, ids: [...new Set(samples.map((s) => `${s.browser}:${s.install_id}`))] }));
