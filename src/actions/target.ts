// 元素目标（编号或坐标）→ 顶层视口里的点。

import type { AgentPoint } from '../browser/page-agent';
import type { TabSession } from '../browser/tab-session';
import type { Point, Target } from '../protocol/args';
import { ActionError } from '../protocol/errors';

/** 编号指向的元素的中心点（先滚到可见）；被别的元素挡住时抛 action_failed。 */
export async function refPoint(s: TabSession, ref: string): Promise<Point> {
  const frameId = s.frameForRef(ref);
  const p = await s.call<AgentPoint | { error: string }>(frameId, 'point', [ref]);
  if ('error' in p) {
    throw new ActionError('action_failed', 'That element is not visible on the page (it has no size); it may be hidden or collapsed.');
  }

  if (p.covered) {
    throw new ActionError('action_failed', `Another element is on top of it at that point (${p.covered}); close the overlay or act on that element instead.`);
  }

  const off = await s.frameOffset(frameId);
  return { x: p.x + off.x, y: p.y + off.y };
}

export async function targetPoint(s: TabSession, target: Target): Promise<Point> {
  return 'ref' in target ? refPoint(s, target.ref) : target.point;
}
