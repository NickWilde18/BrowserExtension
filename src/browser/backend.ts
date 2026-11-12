import type { ActionContext } from '../actions/context';
import type { ActionOutput } from '../actions/types';
import type { ActionArgs } from '../protocol/args';
import { ACTIONS, type ActionName } from '../protocol/frames';
import { ActionError } from '../protocol/errors';
import { EXECUTION_BACKEND } from '../config';
import { readDocument } from './dom-read';

export interface ExecutionBackend {
  readonly actions: readonly ActionName[];
  execute(ctx: ActionContext, args: ActionArgs[ActionName]): Promise<ActionOutput>;
}

export function createExecutionBackend(debugExecute: ExecutionBackend['execute']): ExecutionBackend {
  const debugging = chrome.debugger;
  if (EXECUTION_BACKEND !== 'dom' && typeof debugging?.attach === 'function'
    && typeof debugging?.sendCommand === 'function' && typeof debugging?.detach === 'function'
    && typeof debugging?.onEvent?.addListener === 'function' && typeof debugging?.onDetach?.addListener === 'function') {
    return { actions: [...ACTIONS], execute: debugExecute };
  }
  // 基础子集只读取明确共享的单文档；安全前置不足的写入/导航动作不声明、不降级。
  const readable = typeof chrome.scripting?.executeScript === 'function'
    && typeof chrome.tabs?.get === 'function' && typeof chrome.permissions?.contains === 'function';
  return {
    actions: readable ? ['read'] : [],
    execute: (ctx, args) => {
      if (!readable || ctx.request.action !== 'read') throw new ActionError('unsupported_action', 'This browser does not support this action. Choose a device that advertises it.');
      return readDocument(ctx, args as ActionArgs['read']);
    },
  };
}
