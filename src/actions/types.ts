// 动作处理函数的约定。

import type { TabSession } from '../browser/tab-session';
import type { ActionArgs } from '../protocol/args';
import type { ActionName } from '../protocol/frames';
import type { ActionContext } from './context';

export interface ActionOutput {
  payload?: Record<string, unknown>;
  /** 结果的 page 取自这个标签页；没有（如 close、tabs list 没有标签）时结果不带 page。 */
  session?: TabSession | null;
  /** 成功时给模型的补充说明（如密码是用户自己输入的）。 */
  message?: string;
}

export type ActionHandler<K extends ActionName> = (ctx: ActionContext, args: ActionArgs[K]) => Promise<ActionOutput>;

export type ActionTable = { [K in ActionName]: ActionHandler<K> };
