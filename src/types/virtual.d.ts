// 构建时由 scripts/build.mjs 的 esbuild 插件提供：从 playwright-core 提取的页面注入脚本源码。
declare module 'virtual:injected-source' {
  export const INJECTED_SOURCE: string;
  export const INJECTED_VERSION: string;
}
// 构建时 esbuild 把 PNG 内联成 data URI：网页控制条在网页里显示校徽，不开 web_accessible_resources，
// 免得网页借插件资源地址探测出装了这个插件。
declare module '*.png' {
  const dataUri: string;
  export default dataUri;
}
declare module 'virtual:injected-runtime' {
  export const InjectedScript: new (world: typeof globalThis, options: Record<string, unknown>) => any;
}
