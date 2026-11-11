// 安装密钥实测（设计稿 539-INST 第 3 节第 1–5 项）：在真实浏览器、插件实际用的后台形态里，
// 依次走「首次安装 → 后台空闲被回收后被唤醒 → 重启浏览器 → 升级（不卸载）」，每一步由后台自己报告
// 密钥是否取回、install_id 是否不变、私钥能否导出、签名是否 64 字节 P1363（收集器用 Node 验签）。
//
// 用法：node test/probe/install-key.mjs chromium <chrome 可执行文件> <result.json>
//       node test/probe/install-key.mjs firefox  <firefox 可执行文件> <result.json>
// 只操作自己启动的浏览器与临时配置；不连任何平台服务，不用 Playwright 附着（附着会让 service worker 不被回收）。
// Firefox 需要允许未签名扩展的版本（Developer Edition / Nightly / unbranded），扩展装进配置的 extensions 目录，
// 与签名后正式安装走同一条持久化路径；临时扩展重启就卸载，测不了重启和升级。
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { buildManifest } from '../../scripts/manifest.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [browser, binary, output] = process.argv.slice(2);
if (!['chromium', 'firefox'].includes(browser) || !binary || !output) {
  throw new Error('Usage: node test/probe/install-key.mjs <chromium|firefox> <browser executable> <result.json>');
}
// 后台形态以构建脚本为准：Chromium 用默认 worker，Firefox 用 event（README 与 test/probe/dom-backend.mjs）。
const backgroundMode = browser === 'chromium' ? 'worker' : 'event';
const GECKO_ID = 'install-key-probe@example.invalid';
const scratch = fs.mkdtempSync(path.join(path.dirname(path.resolve(output)), `install-key-${browser}-`));
const extDir = path.join(scratch, 'extension');
const profile = path.join(scratch, 'profile');
fs.mkdirSync(extDir); fs.mkdirSync(profile);
const log = fs.openSync(path.join(scratch, 'browser.log'), 'a');

const reports = [];
let replyFor = null;
const waiters = [];
const collector = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'POST') { res.writeHead(204); res.end(); return; }
  let body = '';
  for await (const chunk of req) body += chunk;
  let r;
  try { r = JSON.parse(body); } catch { res.writeHead(400); res.end(); return; }
  r.receivedAt = Date.now();
  r.phase = phase;
  // 运行脚本可要求后台在这次报告后 runtime.reload()（浏览器自己的扩展更新流程）。
  const reply = replyFor?.(r) ?? {};
  res.end(JSON.stringify(reply));
  try {
    if (r.install_proof) r.nodeVerified = verify(r);
    reports.push(r);
    for (const w of [...waiters]) w();
  } catch { /* 忽略坏报告 */ }
});
await new Promise((resolve) => collector.listen(0, '127.0.0.1', resolve));
const COLLECTOR = `http://127.0.0.1:${collector.address().port}/report`;

/** raw 未压缩点 → SPKI，按 IEEE P1363（r‖s）验签，与 Chat 侧 Go 的 ecdsa.Verify 同一判据。 */
function verify(r) {
  const raw = Buffer.from(r.install_key, 'base64url');
  const spki = Buffer.concat([Buffer.from('3059301306072a8648ce3d020106082a8648ce3d030107034200', 'hex'), raw]);
  const key = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  const msg = Buffer.from(`chat-browser-install-proof/v1\n${r.install_id}\n${r.code}`, 'utf8');
  return crypto.verify('sha256', msg, { key, dsaEncoding: 'ieee-p1363' }, Buffer.from(r.install_proof, 'base64url'));
}

function waitFor(pred, ms, what) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const hit = reports.find(pred);
      if (hit) { clearTimeout(timer); waiters.splice(waiters.indexOf(check), 1); resolve(hit); }
    };
    const timer = setTimeout(() => { waiters.splice(waiters.indexOf(check), 1); reject(new Error(`timeout: ${what}`)); }, ms);
    waiters.push(check);
    check();
  });
}

function writeExtension(version) {
  const manifest = buildManifest({ version, platformOrigin: 'http://127.0.0.1:1', key: undefined, backgroundMode,
    executionBackend: backgroundMode === 'event' ? 'dom' : 'auto', browser });
  const probeManifest = {
    manifest_version: 3, name: 'install-key-probe', version,
    background: manifest.background, permissions: ['alarms', 'storage'],
    ...(browser === 'firefox' ? { browser_specific_settings: { gecko: { id: GECKO_ID } } } : {}),
  };
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify(probeManifest, null, 2));
  fs.copyFileSync(path.join(root, 'test/probe/install-key/background.js'), path.join(extDir, 'background.js'));
  // Chromium 闹钟最短 30 秒、service worker 空闲约 30 秒回收，取 1 分钟保证先回收；Firefox 把空闲超时调到 3 秒。
  fs.writeFileSync(path.join(extDir, 'probe-config.js'),
    `export const COLLECTOR = ${JSON.stringify(COLLECTOR)};\nexport const WAKE_MINUTES = ${browser === 'chromium' ? 1 : 0.2};\n`);
  if (browser === 'firefox') {
    const xdir = path.join(profile, 'extensions');
    fs.mkdirSync(xdir, { recursive: true });
    const xpi = path.join(xdir, `${GECKO_ID}.xpi`);
    fs.rmSync(xpi, { force: true });
    const z = spawnSync('python3', ['-I', '-m', 'zipfile', '-c', xpi, 'manifest.json', 'background.js', 'probe-config.js'], { cwd: extDir });
    if (z.status !== 0) throw new Error(`zip failed: ${z.stderr}`);
  }
}

function firefoxPrefs() {
  const prefs = {
    'xpinstall.signatures.required': false, 'extensions.autoDisableScopes': 0, 'extensions.enabledScopes': 15,
    'extensions.startupScanScopes': 15, 'extensions.background.idle.timeout': 3000,
    'browser.shell.checkDefaultBrowser': false, 'app.update.enabled': false, 'app.update.auto': false,
    'datareporting.policy.dataSubmissionEnabled': false, 'toolkit.telemetry.enabled': false,
    'browser.startup.homepage_override.mstone': 'ignore', 'browser.aboutwelcome.enabled': false,
    'extensions.update.enabled': false, 'extensions.getAddons.cache.enabled': false,
  };
  fs.writeFileSync(path.join(profile, 'user.js'),
    Object.entries(prefs).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n');
}

let child;
// Chromium：本机没有 root，装不了策略或外部扩展，只能用 --load-extension（同一配置、同一路径，扩展 id 不变）。
// 这种加载方式每次启动 onInstalled 都报 install（CDP Extensions.loadUnpacked 同样只在本次会话有效，不写进配置），
// 所以「升级」另用运行中改版本号 + runtime.reload()，走浏览器自己的扩展更新流程（onInstalled 报 update）。
// 不用 Playwright/CDP 附着：附着会让 service worker 不被回收。
function start() {
  const args = browser === 'chromium'
    ? [`--user-data-dir=${profile}`, '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
      '--disable-features=DisableLoadExtensionCommandLineSwitch', `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`, 'about:blank']
    : ['-profile', profile, '-headless', '-no-remote', 'about:blank'];
  child = spawn(binary, args, { stdio: ['ignore', log, log], detached: true });
  return child;
}
async function stop() {
  // 等 IndexedDB 落盘后再正常退出（SIGTERM 两种浏览器都走正常关闭流程）。
  await new Promise((r) => setTimeout(r, 3000));
  const exited = new Promise((r) => child.once('exit', r));
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 20000);
  await exited; clearTimeout(t);
}

let phase = 'install';
const steps = {};
const sameKey = (a, b) => a && b && a.install_key === b.install_key && a.install_id === b.install_id;
const sigOk = (r) => !!r && !r.error && r.signatureLength === 64 && r.nodeVerified === true;
const exportBlocked = (r) => !!r && r.exportErrors?.pkcs8 !== null && r.exportErrors?.jwk !== null;
const after = (t) => (r) => r.receivedAt >= t;
let first;
try {
  if (browser === 'firefox') firefoxPrefs();
  // Chromium：runtime.reload() 后扩展从「命令行加载」转为「已解压安装」，开发者模式关着时会被停用
  // （disable_reasons 1<<24），等于测不到升级；预先打开开发者模式，与开发者手动加载插件的环境一致。
  if (browser === 'chromium') {
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
  }
  writeExtension('1.0.0');

  // 1. 首次安装：生成、存进 IndexedDB、读回、不可导出、签名。
  let t0 = Date.now();
  start();
  first = await waitFor((r) => after(t0)(r) && r.trigger === 'boot', 60000, 'install boot');
  const installed = await waitFor((r) => after(t0)(r) && r.trigger === 'installed', 30000, 'onInstalled install').catch(() => null);
  steps.install = { report: first, onInstalled: installed?.reason ?? null,
    passed: !!first.generated && first.stored === true && first.isCryptoKey === true && first.privateKey?.extractable === false
      && first.rawLength === 65 && first.rawFirstByte === 4 && exportBlocked(first) && sigOk(first) };

  // 2. 后台空闲被回收 → 闹钟唤醒：同一浏览器进程里出现新的 boot。
  const woke = await waitFor((r) => after(t0)(r) && r.trigger === 'boot' && r.boot !== first.boot, 180000, 'background recycled and woken');
  steps.recycle = { report: woke, passed: woke.found === true && !woke.generated && sameKey(first, woke) && exportBlocked(woke) && sigOk(woke) };
  await stop();

  // 3. 重启浏览器。
  phase = 'restart';
  t0 = Date.now();
  start();
  const restarted = await waitFor((r) => after(t0)(r) && r.trigger === 'boot', 60000, 'restart boot');
  steps.restart = { report: restarted, passed: restarted.found === true && !restarted.generated && sameKey(first, restarted) && exportBlocked(restarted) && sigOk(restarted) };
  await stop();

  // 4. 升级（不卸载）：运行中换成高版本号的文件，让后台 runtime.reload()，浏览器按更新处理。
  phase = 'upgrade';
  t0 = Date.now();
  start();
  await waitFor((r) => after(t0)(r) && r.trigger === 'boot', 60000, 'upgrade pre-boot');
  writeExtension('1.0.1');
  let asked = false;
  replyFor = (r) => (!asked && r.trigger === 'boot' ? (asked = true, { reload: true }) : {});
  // 下一次报告（闹钟唤醒）时让它重载。
  const upgraded = await waitFor((r) => after(t0)(r) && r.trigger === 'boot' && r.version === '1.0.1', 180000, 'upgrade boot');
  const updateEvent = await waitFor((r) => after(t0)(r) && r.trigger === 'installed' && r.version === '1.0.1', 30000, 'onInstalled update').catch(() => null);
  replyFor = null;
  steps.upgrade = { report: upgraded, onInstalled: updateEvent?.reason ?? null,
    // 判据是「换了版本、取回的仍是同一把密钥」。onInstalled 的 reason 只记录：Firefox 配置目录安装的扩展升级后
    // 实测不派发 onInstalled(update)，浏览器仍按同一安装的更新处理（extensions.json 的 installDate 不变、updateDate 更新）。
    passed: upgraded.version !== first.version && upgraded.found === true && !upgraded.generated && sameKey(first, upgraded) && exportBlocked(upgraded) && sigOk(upgraded) };
  await stop();

  // 5. 升级后再重启（停机时换文件再启动）：取回的仍是同一把密钥。
  phase = 'upgrade-restart';
  writeExtension('1.0.2');
  t0 = Date.now();
  start();
  const upRestart = await waitFor((r) => after(t0)(r) && r.trigger === 'boot' && r.version === '1.0.2', 60000, 'upgrade-restart boot');
  const upRestartEvent = await waitFor((r) => after(t0)(r) && r.trigger === 'installed' && r.version === '1.0.2', 15000, 'onInstalled').catch(() => null);
  steps.upgradeRestart = { report: upRestart, onInstalled: upRestartEvent?.reason ?? null,
    passed: upRestart.found === true && !upRestart.generated && sameKey(first, upRestart) && exportBlocked(upRestart) && sigOk(upRestart) };
  await stop();
} catch (error) {
  steps.error = error.message;
} finally {
  if (child && child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
  collector.close();
  fs.closeSync(log);
}
if (browser === 'firefox') {
  try {
    const addon = JSON.parse(fs.readFileSync(path.join(profile, 'extensions.json'), 'utf8')).addons.find((a) => a.id === GECKO_ID);
    steps.firefoxAddon = addon && { version: addon.version, location: addon.location, active: addon.active,
      installDate: new Date(addon.installDate).toISOString(), updateDate: new Date(addon.updateDate).toISOString() };
  } catch (error) { steps.firefoxAddon = { error: error.message }; }
}
const passed = ['install', 'recycle', 'restart', 'upgrade', 'upgradeRestart'].every((k) => steps[k]?.passed === true);
const result = { browser, backgroundMode, binary, userAgent: first?.userAgent ?? null, context: first?.context ?? null, passed, steps, reports, scratch };
fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ browser, passed, context: result.context, userAgent: result.userAgent,
  steps: Object.fromEntries(Object.entries(steps).map(([k, v]) => [k, v && typeof v === 'object' && 'report' in v
    ? { passed: v.passed, onInstalled: v.onInstalled, installId: v.report?.install_id } : v])) }));
if (!passed) process.exitCode = 1;
