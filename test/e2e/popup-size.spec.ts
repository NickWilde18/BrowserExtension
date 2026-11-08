import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EXT_DIR } from './helpers';

for (const colorScheme of ['light', 'dark'] as const) {
  test(`真实工具栏弹窗保持360px宽度：${colorScheme}`, async () => {
    test.skip(!process.env.DISPLAY, '真实工具栏弹窗需要有界面环境');
    const profile = fs.mkdtempSync(path.join(process.env.CLAUDE_JOB_DIR ? path.join(process.env.CLAUDE_JOB_DIR, 'tmp') : os.tmpdir(), 'popup-size-'));
    const context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium', headless: false, viewport: null, colorScheme,
      args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--remote-debugging-port=0'],
    });
    let socket: WebSocket | undefined;
    try {
      const worker = context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
      await worker.evaluate(() => chrome.action.openPopup());
      const port = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8').split('\n')[0];
      let target: { webSocketDebuggerUrl: string } | undefined;
      await expect.poll(async () => {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { url: string; webSocketDebuggerUrl: string }[];
        target = targets.find((entry) => entry.url.endsWith('/popup.html'));
        return !!target;
      }).toBe(true);
      // action popup 不属于 Playwright 的普通标签页；直接读取其真实调试目标。
      socket = new WebSocket(target!.webSocketDebuggerUrl);
      await new Promise<void>((resolve, reject) => {
        socket!.onopen = () => resolve();
        socket!.onerror = () => reject(new Error('无法连接弹窗调试目标'));
      });
      const measure = () => new Promise<number>((resolve, reject) => {
        socket!.onmessage = (event) => {
          const message = JSON.parse(String(event.data));
          if (message.id !== 1) return;
          if (message.error) reject(new Error(JSON.stringify(message.error)));
          else resolve(message.result.result.value);
        };
        socket!.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'window.innerWidth', returnByValue: true } }));
      });
      await expect.poll(measure).toBe(360);
    } finally {
      socket?.close();
      await context.close();
      fs.rmSync(profile, { recursive: true, force: true });
    }
  });
}
