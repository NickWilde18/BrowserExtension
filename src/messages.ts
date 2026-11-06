// 后台与插件自己的页面（弹窗 popup.html、确认小窗 approval.html）之间的 runtime 消息。
//
// 只在插件内部用：插件不声明 externally_connectable、不注册内容脚本，网页发不来这些消息；后台收到时
// 再按发送方页面核对一遍（见 background.ts 的 onMessage）。

import type { ApprovalKind } from './protocol/frames';

/** 确认小窗里的答复。 */
export type PromptAnswer =
  /** 站点：仅本次对话。 */
  | 'allow_once'
  /** 站点：总是允许此站点。 */
  | 'allow_always'
  /** 密码框、上传、下载、脚本：允许。 */
  | 'allow'
  /** 密码框：我自己输入。 */
  | 'self'
  /** 密码框「我自己输入」之后：完成。 */
  | 'done'
  | 'deny';

export interface PromptView {
  id: string;
  kind: ApprovalKind;
  site: string;
  /** 按种类：download 有 filename/size/content_type，script 有 source，password 有 field，upload 有 field/files。 */
  detail: Record<string, unknown>;
  /** 自动审查拦下时的理由。 */
  reason?: string;
  stage: 'choose' | 'self_wait';
  expiresAt: number;
}

export type ConnectionStateName =
  | 'no_transport' | 'connecting' | 'connected' | 'waiting_login' | 'replaced' | 'protocol_unsupported' | 'error' | 'offline';

export interface PopupState {
  connection: ConnectionStateName;
  account?: string;
  lastError?: string;
  displayName: string;
  autoMode: boolean;
  stopped: boolean;
  introSeen: boolean;
  sites: { always: string[]; conversation: string[] };
  /** 当前标签页能不能共享（普通网页、还没被 AI 用着）。 */
  canShare: boolean;
  /** 当前标签页已经共享给某个对话。 */
  shared: boolean;
  activeConversations: number;
}

export type PageMessage =
  | { type: 'prompt:get'; id: string }
  | { type: 'prompt:answer'; id: string; answer: PromptAnswer }
  | { type: 'popup:state' }
  | { type: 'popup:setDisplayName'; name: string }
  | { type: 'popup:setAutoMode'; on: boolean }
  | { type: 'popup:stop' }
  | { type: 'popup:resume' }
  | { type: 'popup:share' }
  | { type: 'popup:unshare' }
  | { type: 'popup:revokeSite'; site: string }
  | { type: 'popup:reconnect' }
  | { type: 'popup:dismissIntro' };
