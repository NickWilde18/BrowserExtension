// 从 playwright-core 里取出页面注入脚本的源码（Apache-2.0，许可随构建产物带上）。
//
// playwright-core 把注入脚本作为一个字符串字面量打包在 lib/coreBundle.js 里，位置以
// `packages/playwright-core/src/generated/injectedScriptSource.ts` 这段注释为界。版本钉死在
// package.json，换版本时这里的结构断言会先失败，不会悄悄打出一个用不了的插件。
import { readFileSync } from 'node:fs';
import path from 'node:path';

const MARKER = 'packages/playwright-core/src/generated/injectedScriptSource.ts';

// 插件依赖的注入脚本内部接口：构造方式、带编号的快照、编号反查。缺任何一个都说明换了实现。
const REQUIRED = ['InjectedScript', 'ariaSnapshotWithRefs', '_lastAriaSnapshotForQuery', 'iframeDepths'];

export function extractInjectedSource(pwCoreDir) {
  const pkg = JSON.parse(readFileSync(path.join(pwCoreDir, 'package.json'), 'utf8'));
  const bundle = readFileSync(path.join(pwCoreDir, 'lib', 'coreBundle.js'), 'utf8');

  const markerAt = bundle.indexOf(MARKER);
  if (markerAt < 0) {
    throw new Error(`playwright-core ${pkg.version}: 找不到注入脚本的位置标记`);
  }

  const assignAt = bundle.indexOf(" = '", markerAt);
  if (assignAt < 0 || assignAt - markerAt > 400) {
    throw new Error(`playwright-core ${pkg.version}: 注入脚本不是预期的字符串字面量`);
  }

  // 按 JS 单引号字符串规则找结尾：反斜杠转义下一个字符。
  const start = assignAt + 3;
  let end = start + 1;
  for (; end < bundle.length; end++) {
    if (bundle[end] === '\\') {
      end++;
      continue;
    }

    if (bundle[end] === "'") {
      break;
    }
  }

  // 字面量来自本机 node_modules 里的依赖包，按 JS 字面量求值得到原文。
  const source = new Function(`return ${bundle.slice(start, end + 1)};`)();
  if (typeof source !== 'string') {
    throw new Error(`playwright-core ${pkg.version}: 注入脚本求值结果不是字符串`);
  }

  for (const name of REQUIRED) {
    if (!source.includes(name)) {
      throw new Error(`playwright-core ${pkg.version}: 注入脚本里没有 ${name}，接口变了`);
    }
  }

  return { source, version: pkg.version };
}
