// 带端口的平台来源仍须收到会话 Cookie 变化；请求保留端口，主机权限按浏览器匹配规则生成。
import { chromium, expect, test } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-test-fetch');

test('带端口的平台也能监听会话 Cookie 变化', async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-cookie-origin-'));
  const ctx = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
    await sw.evaluate(() => {
      (globalThis as any).__cookieEvents = 0;
      chrome.cookies.onChanged.addListener(({ cookie }) => {
        if (cookie.httpOnly && cookie.name === 'port-event-check') {
          (globalThis as any).__cookieEvents++;
        }
      });
    });
    await ctx.addCookies([{ name: 'port-event-check', value: 'synthetic-session',
      url: 'http://127.0.0.1:18963/', httpOnly: true, sameSite: 'Lax' }]);
    await expect.poll(() => sw.evaluate(() => (globalThis as any).__cookieEvents), { timeout: 2500 }).toBeGreaterThan(0);
  } finally {
    await ctx.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
});
