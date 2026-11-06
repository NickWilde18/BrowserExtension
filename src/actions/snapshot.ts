// 整页快照：主框架的无障碍快照里每个渲染出来的 iframe，再取它承载的框架的快照，缩进拼在 iframe 那一行
// 下面——与 Playwright 服务端 ariaSnapshotForFrame 的拼法相同（coreBundle.js 的 packages/playwright-core/src/
// server/page.ts），输出与云浏览器的 read 同格式。

import type { AgentSnapshot } from '../browser/page-agent';
import type { TabSession } from '../browser/tab-session';

/** 快照文本上限（契约 4.2）。 */
export const SNAPSHOT_LIMIT = 200_000;

const IFRAME_LINE = /^(\s*)- iframe (?:\[active\] )?\[ref=([^\]]*)\]/;

/** 取一个框架（从 rootRef 或整页起）的快照，含其中 iframe 的内容。返回行。 */
export async function snapshotLines(s: TabSession, frameId: string, rootRef: string | null, depth: number | undefined,
  boxes: boolean, visited = new Set<string>()): Promise<string[]> {
  visited.add(frameId);
  const snap = await s.call<AgentSnapshot>(frameId, 'snapshot', [rootRef, depth ?? null, boxes]);
  const rendered = snap.iframeRefs.filter((ref) => ref in snap.iframeDepths);

  const children = await Promise.all(rendered.map(async (ref) => {
    const childDepth = depth ? depth - (snap.iframeDepths[ref] ?? 0) - 1 : undefined;
    if (childDepth !== undefined && childDepth <= 0) {
      return [];
    }

    try {
      const child = await s.childFrameOf(frameId, ref);
      if (!child || visited.has(child)) {
        return [];
      }

      return await snapshotLines(s, child, null, childDepth, boxes, visited);
    } catch {
      // 子框架取不到（刚被移除、跨源子会话还没就绪）：只留 iframe 那一行。
      return [];
    }
  }));

  const lines: string[] = [];
  for (const line of snap.text.split('\n')) {
    const m = IFRAME_LINE.exec(line);
    if (!m) {
      lines.push(line);
      continue;
    }

    const child = children[rendered.indexOf(m[2] ?? '')] ?? [];
    lines.push(child.length ? line + ':' : line);
    for (const l of child) {
      lines.push((m[1] ?? '') + '  ' + l);
    }
  }

  return lines;
}

/** 整页（或某元素子树）快照文本，按上限截断。 */
export async function snapshotText(s: TabSession, rootRef: string | undefined, depth: number | undefined, boxes: boolean): Promise<{ text: string; truncated: boolean }> {
  const frameId = rootRef ? s.frameForRef(rootRef) : s.mainFrameId;
  const text = (await snapshotLines(s, frameId, rootRef ?? null, depth, boxes)).join('\n');
  if (text.length <= SNAPSHOT_LIMIT) {
    return { text, truncated: false };
  }

  return { text: text.slice(0, SNAPSHOT_LIMIT), truncated: true };
}
