// 后台与插件自己的页面（弹窗 popup.html、确认小窗 approval.html）之间的 runtime 消息。
//
// 只在插件内部用：插件不声明 externally_connectable、不注册内容脚本，网页发不来这些消息；后台收到时
// 再按发送方页面核对一遍（见 background.ts 的 onMessage）。

import type { ShareTarget } from './browser/tabs';
import type { ControlMode } from './browser/control';
import type { ConnectionState } from './connection/manager';
import type { ActionName, ApprovalKind } from './protocol/frames';

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
  /** 发起请求的对话标题；没有标题时不展示来源行。 */
  conversationTitle?: string;
  /**
   * 按种类：download 有 filename/size/content_type，script 有 source，password 有 field，upload 有 field/files；
   * site 在页面要跳到别的站点时有 from（当前站点），只给确认窗显示，不发给 Chat。
   */
  detail: Record<string, unknown>;
  /** 自动审查拦下时的理由。 */
  reason?: string;
  /** expired：到时没答，窗口留着显示「确认已过期，请查看页面」，不再收答复。 */
  stage: 'choose' | 'self_wait' | 'expired';
  expiresAt: number;
}

export interface PopupState {
  connection: ConnectionState;
  signingIn: boolean;
  supportedActions: ActionName[];
  account?: string;
  lastError?: string;
  displayName: string;
  stopped: boolean;
  introSeen: boolean;
  sites: { always: string[]; conversation: string[] };
  /** 弹窗展示用的授权归属；只从当前运行期与本地授权拼装，不保存额外网址。 */
  siteGroups: Array<{ site: string; grants: Array<{ scope: 'always' | 'current' | 'conversation'; title: string }> }>;
  pageSite: string | null;
  pageOwner: { title: string; assistantOpened: boolean } | null;
  /** 当前标签页能不能共享（普通网页、还没被 AI 用着）。 */
  canShare: boolean;
  /** 当前标签页已经共享给某个对话。 */
  shared: boolean;
  /** 「共享此页」会给谁：最近用过浏览器的对话（标题按纯文本显示），或下一个用浏览器的对话。 */
  shareTarget: ShareTarget;
  activeConversations: number;
  serverOrigin: string;
  serverEpoch: string;
  serverSwitching: boolean;
  serverPermissionGranted: boolean;
  controlTabId: number | null;
  controlOrigin: string | null;
  controlledConversations: Array<{ conversation: string; title: string; mode: ControlMode }>;
}

export type PageMessage =
  | { type: 'prompt:get'; id: string }
  | { type: 'prompt:answer'; id: string; answer: PromptAnswer }
  | { type: 'popup:state' }
  | { type: 'popup:login' }
  | { type: 'popup:restartLogin' }
  | { type: 'popup:logout' }
  | { type: 'popup:setServer'; origin: string; epoch: string }
  | { type: 'popup:showControls'; tabId: number; epoch: string }
  | { type: 'popup:resumeConversation'; conversation: string; epoch: string }
  | { type: 'popup:setDisplayName'; name: string }
  | { type: 'popup:stop' }
  | { type: 'popup:resume' }
  | { type: 'popup:share' }
  | { type: 'popup:unshare' }
  | { type: 'popup:revokeSite'; site: string }
  | { type: 'popup:reconnect' }
  | { type: 'popup:dismissIntro' };
