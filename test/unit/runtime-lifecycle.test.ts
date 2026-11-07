import { describe, expect, it, vi } from 'vitest';
import { PromptManager, type WindowOps } from '../../src/approval/prompts';

describe('运行期切换时的迟到确认窗', () => {
  it('确认窗创建尚未返回时取消，迟到窗口必须关闭且不恢复审批', async () => {
    let opened!: (id: number) => void;
    const windows: WindowOps = {
      open: vi.fn(() => new Promise<number>((resolve) => { opened = resolve; })),
      close: vi.fn(async () => {}), pageUrl: (id) => id,
    };
    const prompts = new PromptManager(windows);
    const ctrl = new AbortController();
    const pending = prompts.ask({ kind: 'site', site: 'https://example.test', detail: {}, timeoutMs: 10000, signal: ctrl.signal });
    ctrl.abort();
    opened(55);
    const answer = await pending;
    expect(answer.outcome).toBe('aborted');
    expect(prompts.view(answer.id, 55)).toBeNull();
    expect(windows.close).toHaveBeenCalledWith(55);
  });
});
