// 构建注入的通用 WebExtension API 适配：按真实命名空间能力选择，不按品牌或 UA。
const native = globalThis as typeof globalThis & { browser?: typeof chrome; chrome?: typeof chrome };
export const extensionApi: typeof chrome = native.browser ?? native.chrome!;
