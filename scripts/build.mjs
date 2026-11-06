// 构建插件：打包脚本、生成 manifest、复制静态资源与第三方许可。
//
// 用法：
//   PLATFORM_ORIGIN=https://<平台对外地址> node scripts/build.mjs [--test-hooks] [--out <目录>]
//
// - PLATFORM_ORIGIN 必填：插件只知道这一个地址（用户地址栏里那个），manifest 的主机权限由它生成。
// - --test-hooks 只给端到端测试用：后台暴露测试入口、连接换成内存假传输。生产构建不带。
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
const outArg = args.indexOf('--out');
const outDir = path.resolve(root, outArg >= 0 ? args[outArg + 1] : 'dist');

const platformOrigin = parsePlatformOrigin(process.env.PLATFORM_ORIGIN);

/**
 * 校验平台对外地址：只收 http(s) 的来源（协议 + 主机 + 端口），不带路径、查询、账号。
 * 写错了宁可构建失败：主机权限写错的插件装上也连不上，还要用户重装。
 */
function parsePlatformOrigin(raw) {
  if (!raw) {
    throw new Error('缺少 PLATFORM_ORIGIN（平台对外地址，例如 https://example.edu）');
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
  },
  plugins: [injectedPlugin],
  // 只做语法级压缩（删掉 define 之后的死分支），不改名、不压空白：产物仍可读。
  minifySyntax: true,
  logLevel: 'warning',
});

// 生产构建里不能有测试用的假传输与测试入口。
if (!testHooks) {
  const bg = readFileSync(path.join(outDir, 'background.js'), 'utf8');
  for (const marker of ['FakeTransport', 'FakeServer', '__bxTest']) {
    if (bg.includes(marker)) {
      throw new Error(`生产构建的 background.js 里出现了测试代码：${marker}`);
    }
  }
}

for (const file of ['popup.html', 'popup.css', 'approval.html', 'approval.css']) {
  cpSync(path.join(root, 'static', file), path.join(outDir, file));
}

cpSync(path.join(root, '_locales'), path.join(outDir, '_locales'), { recursive: true });

const thirdParty = path.join(outDir, 'third_party', 'playwright');
mkdirSync(thirdParty, { recursive: true });
for (const file of ['LICENSE', 'NOTICE']) {
  cpSync(path.join(pwCoreDir, file), path.join(thirdParty, file));
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const manifest = buildManifest({ version: pkg.version, platformOrigin, key: DEV_PUBLIC_KEY });
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(`built ${path.relative(root, outDir)} platform=${platformOrigin} testHooks=${testHooks} injected=${injected.version}`);
