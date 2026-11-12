// 用独立临时配置加载事件后台扩展。只操作自己启动的浏览器和合成夹具。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [binary, output] = process.argv.slice(2);
if (!binary || !output) throw new Error('Usage: node test/probe/dom-backend.mjs <browser executable> <result.json>');
const scratch = fs.mkdtempSync(path.join(path.dirname(output), 'dom-event-probe-'));
const tmp = path.join(scratch, 'tmp'); fs.mkdirSync(tmp);
const log = fs.openSync(path.join(scratch, 'runner.log'), 'a');
const children = [];
let callback;
let timer;
let finish;
let failed;
const received = new Promise((resolve, reject) => { finish = resolve; failed = reject; });
// 每个提前拒绝都接住，统一在主流程报告。
void received.catch(() => undefined);

function run(command, args) {
  const child = spawn(command, args, { cwd: root, stdio: ['ignore', log, log], detached: true,
    env: { ...process.env, TMPDIR: tmp } });
  children.push(child);
  return child;
}
async function exited(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`child exited ${code}; see runner.log`)));
  });
}
try {
  const fixture = spawn(process.execPath, [path.join(root, 'test/e2e/fixtures/server.mjs'), '18971'], {
    cwd: root, stdio: ['ignore', 'pipe', log], detached: true, env: { ...process.env, TMPDIR: tmp },
  });
  children.push(fixture);
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('fixture did not start')), 10000);
    fixture.stdout.on('data', (value) => { if (String(value).includes('"ready":true')) { clearTimeout(timeout); resolve(); } });
    fixture.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`fixture exited ${code}`)); });
  });
  callback = http.createServer(async (req, res) => {
    if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (body.length > 1000000) { res.writeHead(413); res.end(); return; }
    }
    try { const data = JSON.parse(body); res.end('{}'); finish(data); } catch { res.writeHead(400); res.end(); }
  });
  await new Promise((resolve) => callback.listen(0, '127.0.0.1', resolve));
  const port = callback.address().port;
  const probeUrl = `http://127.0.0.1:${port}/result?fixture=${encodeURIComponent('http://127.0.0.1:18971')}`;
  const extension = path.join(scratch, 'extension');
  await exited(run(process.execPath, ['scripts/build.mjs', '--test-hooks', '--fake-transport', '--execution-backend', 'dom',
    '--background-mode', 'event', '--platform-origin', 'http://127.0.0.1:18971', '--probe-url', probeUrl, '--out', extension]));
  const browser = run('pnpm', ['dlx', 'web-ext@8.9.0', 'run', '--source-dir', extension, '--firefox', binary,
    '--no-config-discovery', '--no-input', '--no-reload', '--args=-headless', '--artifacts-dir', path.join(scratch, 'artifacts')]);
  browser.once('error', failed);
  browser.once('exit', (code) => failed(new Error(`browser runner exited ${code}; see runner.log`)));
  timer = setTimeout(() => failed(new Error('extension probe timed out; see runner.log')), 90000);
  const result = await received;
  const report = { ...result, independentProfile: true, log: path.join(scratch, 'runner.log') };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  if (!result.passed) process.exitCode = 1;
} catch (error) {
  const report = { passed: false, error: error.message, independentProfile: true, log: path.join(scratch, 'runner.log') };
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  for (const child of children.reverse()) {
    if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  }
  callback?.close();
  fs.closeSync(log);
}
