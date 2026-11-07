// 协议帧（版本 1），见 Chat 仓 docs/BROWSER_EXTENSION.md 第 3 节。
//
// Chat → 插件的帧在这里逐字段校验：连接另一端是平台服务，但帧格式不对时宁可丢掉也不猜。
// 未知 type 返回 null（契约：双方都忽略）。

import type { ErrorCode } from './errors';

export const ACTIONS = [
  'open', 'navigate', 'tabs', 'close',
  'read', 'find', 'screenshot', 'wait', 'console', 'network', 'pdf',
  'click', 'hover', 'type', 'fill_form', 'select', 'press_key', 'scroll', 'drag', 'dialog',
  'upload',
  'evaluate',
] as const;

export type ActionName = (typeof ACTIONS)[number];

/** 要逐次确认的五类，见契约 3.3。 */
export const APPROVAL_KINDS = ['site', 'download', 'script', 'password', 'upload'] as const;

export type ApprovalKind = (typeof APPROVAL_KINDS)[number];

export type ApprovalDecision = 'allow' | 'block' | 'ask_user';

// ---- Chat → 插件 ----

export interface ReadyFrame {
  type: 'ready';
  protocol: number;
  heartbeat_seconds: number;
  account: string;
  max_file_bytes: number;
}

export interface PingFrame {
  type: 'ping';
}

export interface RequestFrame {
  type: 'request';
  request_id: string;
  action: ActionName;
  args: Record<string, unknown>;
  conversation: string;
  /** 对话标题（最多 200 字，可能为空），只给弹窗显示「将共享给：<标题>」用（契约 3.2）。 */
  conversation_title: string;
  /** 本轮任务的标识；旧服务没有该字段时保留原有空闲回收。 */
  turn_id?: string;
  deadline_ms: number;
  auth_wait_ms: number;
}

export interface CancelFrame {
  type: 'cancel';
  request_id: string;
}

/** 只释放指定回合的调试附着，不关闭网页或平台连接。 */
export interface ReleaseFrame {
  type: 'release';
  turn_id: string;
  conversation: string;
}

export interface ReleasedFrame {
  type: 'released';
  turn_id: string;
  conversation: string;
}

export interface ApprovalFrame {
  type: 'approval';
  request_id: string;
  approval_id: string;
  kind: ApprovalKind;
  decision: ApprovalDecision;
  reason?: string;
}

export interface ClosedFrame {
  type: 'closed';
  reason: string;
}

export type InboundFrame = ReadyFrame | PingFrame | RequestFrame | CancelFrame | ReleaseFrame | ApprovalFrame | ClosedFrame;

// ---- 插件 → Chat ----

export interface HelloFrame {
  type: 'hello';
  protocol: number;
  install_id: string;
  display_name: string;
  extension_version: string;
}

export interface ProgressFrame {
  type: 'progress';
  request_id: string;
  stage: 'awaiting_user' | 'working';
  kind?: ApprovalKind;
}

export interface ApprovalRequestFrame {
  type: 'approval_request';
  request_id: string;
  approval_id: string;
  kind: ApprovalKind;
  site: string;
  detail: Record<string, unknown>;
}

export interface PageDialog {
  type: string;
  message: string;
  default_prompt?: string;
}

export interface PageInfo {
  url: string;
  title: string;
  origin: string;
  dialog?: PageDialog;
}

export interface ResultFrame {
  type: 'result';
  request_id: string;
  outcome: 'ok' | 'error';
  code?: ErrorCode;
  message?: string;
  page?: PageInfo;
  payload?: Record<string, unknown>;
}

export type OutboundFrame = HelloFrame | ProgressFrame | ApprovalRequestFrame | ResultFrame | ReleasedFrame | { type: 'pong' };

// ---- 校验 ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 契约里的 UUID 都是小写带连字符。 */
export function isUUID(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPositiveInt(v: unknown, max: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= max;
}

/** approval_id 是插件自己生成的短串（见 approval/registry.ts），这里只限长度与字符集。 */
const APPROVAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * 解析一帧 Chat → 插件的消息。返回 null 表示未知类型或格式不对：调用方丢弃这一帧。
 *
 * 不抛异常：一帧坏了不能把连接拖垮。
 */
export function parseInbound(raw: unknown): InboundFrame | null {
  if (!isObject(raw) || typeof raw.type !== 'string') {
    return null;
  }

  switch (raw.type) {
    case 'ready':
      if (!isPositiveInt(raw.protocol, 1000) || !isPositiveInt(raw.heartbeat_seconds, 3600) ||
        typeof raw.account !== 'string' || raw.account.length > 320 || !isPositiveInt(raw.max_file_bytes, 2 ** 40)) {
        return null;
      }

      return {
        type: 'ready',
        protocol: raw.protocol,
        heartbeat_seconds: raw.heartbeat_seconds,
        account: raw.account,
        max_file_bytes: raw.max_file_bytes,
      };
    case 'ping':
      return { type: 'ping' };
    case 'request': {
      if (!isUUID(raw.request_id) || typeof raw.action !== 'string' ||
        !(ACTIONS as readonly string[]).includes(raw.action) || !isObject(raw.args) || !isUUID(raw.conversation) ||
        !isPositiveInt(raw.deadline_ms, 10 * 60_000) || !isPositiveInt(raw.auth_wait_ms, 30 * 60_000) ||
        (raw.turn_id !== undefined && !isUUID(raw.turn_id))) {
        return null;
      }

      return {
        type: 'request',
        request_id: raw.request_id,
        action: raw.action as ActionName,
        args: raw.args,
        ...(raw.turn_id === undefined ? {} : { turn_id: raw.turn_id as string }),
        conversation: raw.conversation,
        conversation_title: typeof raw.conversation_title === 'string' ? [...raw.conversation_title].slice(0, 200).join('') : '',
        deadline_ms: raw.deadline_ms,
        auth_wait_ms: raw.auth_wait_ms,
      };
    }
    case 'cancel':
      return isUUID(raw.request_id) ? { type: 'cancel', request_id: raw.request_id } : null;
    case 'release':
      return isUUID(raw.turn_id) && isUUID(raw.conversation)
        ? { type: 'release', turn_id: raw.turn_id, conversation: raw.conversation } : null;
    case 'approval': {
      if (!isUUID(raw.request_id) || typeof raw.approval_id !== 'string' || !APPROVAL_ID_RE.test(raw.approval_id) ||
        typeof raw.kind !== 'string' || typeof raw.decision !== 'string') {
        return null;
      }

      // kind 与 decision 不认识时不丢帧：交给审批登记处按「对不上 → ask_user」处理（契约 3.3）。
      const frame: ApprovalFrame = {
        type: 'approval',
        request_id: raw.request_id,
        approval_id: raw.approval_id,
        kind: raw.kind as ApprovalKind,
        decision: raw.decision as ApprovalDecision,
      };

      if (typeof raw.reason === 'string') {
        frame.reason = raw.reason.slice(0, 2000);
      }

      return frame;
    }
    case 'closed':
      return typeof raw.reason === 'string' ? { type: 'closed', reason: raw.reason.slice(0, 64) } : null;
    default:
      return null;
  }
}

/** 本插件认识的审批种类。 */
export function isApprovalKind(v: unknown): v is ApprovalKind {
  return typeof v === 'string' && (APPROVAL_KINDS as readonly string[]).includes(v);
}

/** 本插件认识的审批结论。 */
export function isApprovalDecision(v: unknown): v is ApprovalDecision {
  return v === 'allow' || v === 'block' || v === 'ask_user';
}
