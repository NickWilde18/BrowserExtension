// 设计验收截图：按设计状态集 07 的状态逐个截插件真实界面（中英文 × 明暗）。只在设了 BX_VISUAL_OUT（输出目录）时跑，
// 不做断言之外的检查——看图由人来做。
import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { A, CONV2, aiPage, allowSite, approvalWindow, actOnPrompt, call, clickPanelButton, launch, send, type Harness } from './helpers';

const OUT = process.env.BX_VISUAL_OUT ?? '';
test.skip(!OUT, '设 BX_VISUAL_OUT 才截图');

const LONG_TITLE = '整理本学期课程资料与学习计划，以及需要补充的参考文献';
const VARIANTS = [
  { lang: 'zh-CN', theme: 'light' }, { lang: 'zh-CN', theme: 'dark' },
  { lang: 'en-US', theme: 'light' }, { lang: 'en-US', theme: 'dark' },
] as const;

async function shot(page: Page, panel: Locator, name: string): Promise<void> {
  const box = await panel.boundingBox();
  expect(box).not.toBeNull();
  const margin = 24;
  const clip = { x: Math.max(0, box!.x - margin), y: Math.max(0, box!.y - margin), width: box!.width + margin * 2, height: box!.height + margin * 2 };
  await page.screenshot({ path: path.join(OUT, `${name}.png`), clip: { ...clip, width: Math.min(clip.width, 1200 - clip.x), height: Math.min(clip.height, 800 - clip.y) } });
}

for (const v of VARIANTS) {
  test(`控制条 · ${v.lang} · ${v.theme}`, async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const h: Harness = await launch({ lang: v.lang, autoApproval: 'ask_user' });
    try {
      await allowSite(h, A);
      await allowSite(h, A, CONV2);
      expect((await call(h, 'open', { url: `${A}/form.html` }, { title: LONG_TITLE })).outcome).toBe('ok');
      const page = await aiPage(h, '/form.html');
      await page.emulateMedia({ colorScheme: v.theme });
      const panel = page.locator('#browser-assistant-controls');
      await expect(panel).toHaveAttribute('data-phase', 'working');
      const prefix = `control-${v.lang}-${v.theme}`;
      await shot(page, panel, `${prefix}-working-idle`);

      const waitId = await send(h, 'wait', { seconds: 3 }, { title: LONG_TITLE });
      await page.waitForTimeout(400);
      await shot(page, panel, `${prefix}-working-action`);
      void waitId;
      await page.waitForTimeout(3200);

      // 收起 · 仍在操作：收起按钮在右上角。
      let box = (await panel.boundingBox())!;
      await page.mouse.click(box.x + box.width - 28, box.y + 22);
      await page.waitForTimeout(150);
      await shot(page, panel, `${prefix}-collapsed-working`);
      box = (await panel.boundingBox())!;
      await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
      await page.waitForTimeout(150);

      // 等待确认：页面脚本每次都要确认。
      await send(h, 'evaluate', { function: '() => document.title' }, { title: LONG_TITLE });
      const prompt = await approvalWindow(h);
      await expect(panel).toHaveAttribute('data-phase', 'waiting');
      await page.bringToFront();
      await shot(page, panel, `${prefix}-waiting`);
      box = (await panel.boundingBox())!;
      await page.mouse.click(box.x + box.width - 28, box.y + 22);
      await page.waitForTimeout(150);
      await shot(page, panel, `${prefix}-collapsed-waiting`);
      box = (await panel.boundingBox())!;
      await page.mouse.click(box.x + box.width - 20, box.y + box.height / 2);
      await actOnPrompt(prompt, () => prompt.keyboard.press('Escape'));
      await expect(panel).toHaveAttribute('data-phase', 'working');

      // 已由你接管 → 让助手继续 → 继续前重新看页面。
      await clickPanelButton(page, panel);
      await expect(panel).toHaveAttribute('data-mode', 'user');
      await shot(page, panel, `${prefix}-taken`);
      await clickPanelButton(page, panel);
      await expect(panel).toHaveAttribute('data-mode', 'observing');
      await shot(page, panel, `${prefix}-recheck`);

      // 无标题对话。
      expect((await call(h, 'open', { url: `${A}/landing.html` }, { conversation: CONV2, title: '' })).outcome).toBe('ok');
      const untitled = await aiPage(h, '/landing.html');
      await untitled.emulateMedia({ colorScheme: v.theme });
      const untitledPanel = untitled.locator('#browser-assistant-controls');
      await expect(untitledPanel).toBeVisible();
      await untitled.bringToFront();
      await shot(untitled, untitledPanel, `${prefix}-untitled`);
    } finally {
      await h.close();
    }
  });
}
