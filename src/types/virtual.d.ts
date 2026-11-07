// 构建时由 scripts/build.mjs 的 esbuild 插件提供：从 playwright-core 提取的页面注入脚本源码。
declare module 'virtual:injected-source' {
  export const INJECTED_SOURCE: string;
  export const INJECTED_VERSION: string;
}
declare module 'virtual:injected-runtime' {
  export const InjectedScript: new (world: typeof globalThis, options: Record<string, unknown>) => any;
}
