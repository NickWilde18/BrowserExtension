// 构建插件：打包脚本、生成 manifest、复制静态资源与第三方许可。
//
// 用法：
//   PLATFORM_ORIGIN=https://<平台对外地址> node scripts/build.mjs [--test-hooks [--fake-transport]] [--out <目录>]
//   node scripts/build.mjs --platform-origin https://<平台对外地址> …
//
// - 平台对外地址必填（--platform-origin 或环境变量 PLATFORM_ORIGIN）：插件只知道这一个地址（用户地址栏里那个），
//   manifest 的主机权限由它生成，真实传输连它。
// - --test-hooks 只给端到端测试用：后台暴露测试入口（读状态、预授权站点）。生产构建不带。
// - --fake-transport 只能和 --test-hooks 一起用：连接换成内存假传输，测试代码扮演 Chat。不带时用真实传输。
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEV_PUBLIC_KEY, buildManifest } from './manifest.mjs';
import { extractInjectedSource } from './extract-injected.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const testHooks = args.includes('--test-hooks');
const fakeTransport = args.includes('--fake-transport');
if (fakeTransport && !testHooks) {
  throw new Error('--fake-transport 只给端到端测试用，要和 --test-hooks 一起');
}

/** `--名字 值` 形式的参数。 */
function argValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

const outDir = path.resolve(root, argValue('--out') ?? 'dist');
const platformOrigin = parsePlatformOrigin(argValue('--platform-origin') ?? process.env.PLATFORM_ORIGIN);
const executionBackend = argValue('--execution-backend') ?? 'auto';
const backgroundMode = argValue('--background-mode') ?? 'worker';
const probeUrl = argValue('--probe-url');
if (probeUrl && (!testHooks || !fakeTransport || backgroundMode !== 'event')) {
  throw new Error('probe-url 仅允许事件后台的 test-hooks + fake-transport 构建');
}
if (!['auto', 'dom'].includes(executionBackend) || !['worker', 'event'].includes(backgroundMode)
  || (backgroundMode === 'event' && executionBackend !== 'dom')) {
  throw new Error('execution-backend 只能为 auto/dom，background-mode 只能为 worker/event；event 需搭配 dom');
}

/**
 * 校验平台对外地址：只收 http(s) 的来源（协议 + 主机 + 端口），不带路径、查询、账号。
 * 写错了宁可构建失败：主机权限写错的插件装上也连不上，还要用户重装。
 */
function parsePlatformOrigin(raw) {
  if (!raw) {
    throw new Error('缺少平台对外地址（--platform-origin 或 PLATFORM_ORIGIN，例如 https://example.edu）');
  }

  const url = new URL(raw);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('PLATFORM_ORIGIN 只能是 http(s) 地址');
  }

  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) {
    throw new Error('PLATFORM_ORIGIN 只写来源（协议、主机、端口），不带路径、查询或账号');
  }

  return url.origin;
}

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

const require = createRequire(import.meta.url);
const pwCoreDir = path.dirname(require.resolve('playwright-core/package.json'));
const injected = extractInjectedSource(pwCoreDir);

/** esbuild 插件：`virtual:injected-source` 解析成提取出的注入脚本源码。 */
const injectedPlugin = {
  name: 'injected-source',
  setup(b) {
    b.onResolve({ filter: /^virtual:injected-runtime$/ }, () => ({ path: 'injected-runtime', namespace: 'injected-runtime' }));
    b.onLoad({ filter: /.*/, namespace: 'injected-runtime' }, () => ({
      contents: `const snapshotRuntime = (() => { const module = {};\n${injected.source}\nreturn module.exports.InjectedScript(); })(); export { snapshotRuntime as InjectedScript };`,
      loader: 'js',
    }));
    b.onResolve({ filter: /^virtual:injected-source$/ }, () => ({ path: 'injected-source', namespace: 'injected' }));
    b.onLoad({ filter: /.*/, namespace: 'injected' }, () => ({
      contents: `export const INJECTED_SOURCE = ${JSON.stringify(injected.source)};\n` +
        `export const INJECTED_VERSION = ${JSON.stringify(injected.version)};\n`,
      loader: 'js',
    }));
  },
};

await build({
  entryPoints: {
    background: path.join(root, 'src/background.ts'),
    popup: path.join(root, 'src/popup/popup.ts'),
    approval: path.join(root, 'src/approval/page.ts'),
    controlbar: path.join(root, 'src/controlbar/page.ts'),
  },
  outdir: outDir,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['chrome125'],
  legalComments: 'none',
  charset: 'utf8',
  define: {
    __PLATFORM_ORIGIN__: JSON.stringify(platformOrigin),
    __TEST_HOOKS__: JSON.stringify(testHooks),
    __FAKE_TRANSPORT__: JSON.stringify(fakeTransport),
    __EXECUTION_BACKEND__: JSON.stringify(executionBackend),
    chrome: 'extensionApi',
  },
  plugins: [injectedPlugin],
  // 只有网页控制条用：校徽内联成 data URI，见 src/types/virtual.d.ts。
  loader: { '.png': 'dataurl' },
  inject: [path.join(root, 'src/browser/api.ts')],
  // 只做语法级压缩（删掉 define 之后的死分支），不改名、不压空白：产物仍可读。
  minifySyntax: true,
  logLevel: 'warning',
});

// 隔离世界的快照脚本按普通 JS 打包，不依赖运行期 eval，也不把依赖的模块全局留到网页。
await build({
  entryPoints: [path.join(root, 'src/browser/dom-agent.ts')],
  outfile: path.join(outDir, 'dom-agent.js'), bundle: true, format: 'iife',
  platform: 'browser', target: ['es2022'], legalComments: 'none', charset: 'utf8',
  plugins: [injectedPlugin], minifySyntax: true, logLevel: 'warning',
});

// 生产构建：不能有测试用的假传输与测试入口；要有真实传输，且请求里不带 X-Service 头（契约 2.3：带了网关就
// 按首段选服务名、扣用户的共用额度）。
if (!testHooks) {
  const bg = readFileSync(path.join(outDir, 'background.js'), 'utf8');
  for (const marker of ['FakeTransport', 'FakeServer', '__bxTest']) {
    if (bg.includes(marker)) {
      throw new Error(`生产构建的 background.js 里出现了测试代码：${marker}`);
    }
  }

  if (!bg.includes('/chat-service/browser/')) {
    throw new Error('生产构建的 background.js 里没有真实传输');
  }

  if (/x-service/i.test(bg)) {
    throw new Error('生产构建的 background.js 里出现了 X-Service');
  }

  // cookies 权限只用来监听会话 Cookie 的变化（计划第 9 节第 17 条）：产物里只能有 onChanged，不能有读写 Cookie 的调用。
  const cookieCalls = bg.match(/cookies\s*\.\s*(get|getAll|set|remove|getAllCookieStores|getPartitionKey)\b/g);
  if (cookieCalls) {
    throw new Error(`生产构建的 background.js 里出现了读写 Cookie 的调用：${[...new Set(cookieCalls)].join('、')}`);
  }

  if (!bg.includes('cookies.onChanged')) {
    throw new Error('生产构建的 background.js 里没有会话 Cookie 的监听');
  }
}

for (const file of ['popup.html', 'popup.css', 'approval.html', 'approval.css']) {
  cpSync(path.join(root, 'static', file), path.join(outDir, file));
}

cpSync(path.join(root, '_locales'), path.join(outDir, '_locales'), { recursive: true });
cpSync(path.join(root, 'static', 'icons'), path.join(outDir, 'icons'), { recursive: true });

const thirdParty = path.join(outDir, 'third_party', 'playwright');
mkdirSync(thirdParty, { recursive: true });
for (const file of ['LICENSE', 'NOTICE']) {
  cpSync(path.join(pwCoreDir, file), path.join(thirdParty, file));
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = buildManifest({ version: pkg.version, platformOrigin, key: DEV_PUBLIC_KEY, executionBackend, backgroundMode });
if (probeUrl) {
  await build({
    entryPoints: [path.join(root, 'test/probe/dom-extension-probe.ts')],
    outfile: path.join(outDir, 'backend-probe.js'), bundle: true, format: 'esm', target: ['es2022'],
    define: { __PROBE_URL__: JSON.stringify(probeUrl), chrome: 'extensionApi' },
    inject: [path.join(root, 'src/browser/api.ts')], logLevel: 'warning',
  });
  manifest.background.scripts.push('backend-probe.js');
}
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`built ${path.relative(root, outDir)} platform=${platformOrigin} testHooks=${testHooks} fakeTransport=${fakeTransport} injected=${injected.version}`);
