import type { ControlView } from '../browser/control';

export interface PanelBinding {
  epoch: string;
  token: string;
}
export interface PanelCommand extends PanelBinding {
  type: 'panel:takeover' | 'panel:resume';
}
export interface PanelRender extends PanelBinding {
  type: 'panel:render';
  view: ControlView;
  expand?: boolean;
}
export interface PanelReply { ok: boolean; view?: ControlView }
