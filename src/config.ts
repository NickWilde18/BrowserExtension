// 构建期常量（scripts/build.mjs 经 esbuild define 注入，单测里由 vitest.config.ts 注入）。

declare const __PLATFORM_ORIGIN__: string;
declare const __TEST_HOOKS__: boolean;

/** 平台对外地址（用户地址栏里那个）。插件只知道这一个地址。 */
export const PLATFORM_ORIGIN: string = __PLATFORM_ORIGIN__;

/** 仅端到端测试构建为 true：后台暴露测试入口、连接换成内存假传输。 */
export const TEST_HOOKS: boolean = __TEST_HOOKS__;

/** 协议版本，见 Chat 仓 docs/BROWSER_EXTENSION.md 第 3 节。 */
export const PROTOCOL_VERSION = 1;

/** 同一对话排队等待的请求数上限，超出回 busy。 */
export const MAX_QUEUED_PER_CONVERSATION = 8;

/** 发出 approval_request 后等 Chat 回 approval 的时限，到点按 ask_user 处理。 */
export const APPROVAL_REPLY_TIMEOUT_MS = 15_000;

/** 连接期间调扩展 API 保活的间隔：只靠下行数据，后台在空闲 30 秒时会被回收（计划 7.1 实测）。 */
export const KEEPALIVE_INTERVAL_MS = 20_000;

/** 等 ready 的时限。 */
export const READY_TIMEOUT_MS = 15_000;

/** 对话空闲多久断开它的调试附着（顶部提示条随之消失）。 */
export const IDLE_DETACH_MS = 5 * 60_000;

/** result 帧的上限（主要是截图）。 */
export const MAX_RESULT_FRAME_BYTES = 8 * 1024 * 1024;
