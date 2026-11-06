// 插件产生的错误码，见契约 3.4。Chat 侧才有的码（browser_unavailable、not_permitted 等）不在这里。

export const ERROR_CODES = [
  'site_not_allowed',
  'user_denied',
  'user_stopped',
  'element_not_found',
  'site_changed',
  'unsupported_page',
  'attach_failed',
  'no_tab',
  'file_too_large',
  'busy',
  'timeout',
  'invalid_args',
  'action_failed',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * 动作失败：code 进结果帧的 `code`，message 是写给模型的一句英文说明（进 `message`）。
 *
 * message 会原样交给模型、存进对话历史，不要写页面内容以外的内部细节（调试协议原始报错、栈）。
 */
export class ActionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = 'ActionError';
    this.code = code;
  }
}

/** 把任意异常收敛成 ActionError；不认识的按 action_failed，说明里不带原始异常文本。 */
export function toActionError(err: unknown): ActionError {
  if (err instanceof ActionError) {
    return err;
  }

  return new ActionError('action_failed', 'The browser could not complete this action.');
}
