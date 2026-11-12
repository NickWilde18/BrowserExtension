// 弹窗第二版（Tark#528 拍板 rev 531）：页头只写平台名与产品简称；已连接按「当前页 / 站点 / 对话 / 设置」分标签，
// 设置是一列入口、点进带面包屑返回的二级页；底部整宽「停止 / 恢复操作网页」只在已连接时出现；未登录页是「连接平台账号」。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, expect, test, type Page } from '@playwright/test';
import { A, CONV, allowSite, call, launch, openTab, type Harness } from './helpers';

const popupOf = async (h: Harness): Promise<Page> => {
  const popup = await h.ctx.newPage();
  await popup.goto(`chrome-extension://${h.extId}/popup.html`);
  await expect(popup.locator('#tab-page')).toBeVisible();
  return popup;
};

test.describe('已连接', () => {
  let h: Harness;
  test.beforeEach(async () => { h = await launch(); });
  test.afterEach(async () => { await h.close(); });

  test('页头只写平台名和产品简称，不重复学校名与「浏览器扩展」大标题', async () => {
    const popup = await popupOf(h);
    const header = popup.locator('header');
    await expect(header).toContainText('AI Service');
    await expect(header).toContainText('Browser Assistant');
    await expect(header).toContainText('Connected');
    await expect(header).not.toContainText('Chinese University');
    await expect(popup.locator('h1', { hasText: 'Browser extension' })).toHaveCount(0);
  });

  test('四个标签各管一类内容，默认是当前页；数量显示在标签上', async () => {
    await allowSite(h, A);
    const popup = await popupOf(h);
    await expect(popup.locator('[role=tab]')).toHaveCount(4);
    await expect(popup.locator('#tab-page')).toHaveAttribute('aria-selected', 'true');
    await expect(popup.locator('#pageDomain')).toBeVisible();
    await expect(popup.locator('#sites')).toBeHidden();
    await expect(popup.locator('#tab-sites')).toContainText('1');
    await openTab(popup, 'sites');
    await expect(popup.locator('#sites .site-group')).toHaveCount(1);
    await expect(popup.locator('#sites')).toBeVisible();
    await expect(popup.locator('#pageDomain')).toBeHidden();
    await openTab(popup, 'conv');
    await expect(popup.locator('#controlledNone')).toBeVisible();
  });

  test('设置标签是入口列表，二级页用面包屑回到列表；退出登录在设置标签里', async () => {
    const popup = await popupOf(h);
    await expect(popup.locator('#openSettings')).toBeHidden();
    await expect(popup.locator('#logout')).toBeHidden();
    await openTab(popup, 'settings');
    await expect(popup.locator('#logout')).toHaveText('Sign out of extension');
    for (const [opener, view] of [['#openBrowser', '#browserView'], ['#openPrivacy', '#privacyView'], ['#openSettings', '#settingsView'], ['#about', '#aboutView']] as const) {
      await popup.locator(opener).click();
      await expect(popup.locator(view)).toBeVisible();
      // 二级页仍在「设置」标签下，页头和底部停止按钮都还在。
      await expect(popup.locator('#tab-settings')).toHaveAttribute('aria-selected', 'true');
      await expect(popup.locator('#stop')).toBeVisible();
      await popup.locator(`${view} [data-back]`).click();
      await expect(popup.locator('#openSettings')).toBeVisible();
    }
    await popup.locator('#openBrowser').click();
    await popup.locator('#rename').click();
    await expect(popup.locator('#displayName')).toBeFocused();
  });

  test('底部整宽按钮：停止操作网页 → 恢复操作网页，停止后当前页有横幅', async () => {
    const popup = await popupOf(h);
    await expect(popup.locator('#stop')).toHaveText('Stop web actions');
    await expect(popup.locator('#stoppedBanner')).toBeHidden();
    await popup.locator('#stop').click();
    await expect(popup.locator('#resume')).toHaveText('Resume web actions');
    await expect(popup.locator('#stoppedBanner')).toBeVisible();
    await expect(popup.locator('header')).toContainText('Stopped');
    await popup.locator('#resume').click();
    await expect(popup.locator('#stop')).toBeVisible();
  });

  test('中文界面用平台中文名，不出现 AI Service', async () => {
    await h.close();
    h = await launch({ lang: 'zh-CN' });
    await call(h, 'tabs', { op: 'list' }, { conversation: CONV, title: '对话' });
    const popup = await popupOf(h);
    await expect(popup.locator('header')).toContainText('大学 AI 服务平台');
    await expect(popup.locator('header')).toContainText('浏览器助手');
    expect(await popup.locator('body').innerText()).not.toContain('AI Service');
    await expect(popup.locator('#stop')).toHaveText('停止操作网页');
  });
});

test('未登录：连接平台账号 + 打开平台，没有标签和停止按钮，底部一行链接可进二级页', async ({}, info) => {
  const extDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../dist-test-fetch');
  const ctx = await chromium.launchPersistentContext(info.outputPath('profile'), {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`],
  });
  try {
    const sw = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker');
    const popup = await ctx.newPage();
    await popup.goto(`chrome-extension://${new URL(sw.url()).host}/popup.html`);
    await expect(popup.locator('#login')).toHaveText('Connect account');
    await expect(popup.locator('#gateOpenPlatform')).toBeVisible();
    await expect(popup.locator('header')).toContainText('Signed out');
    await expect(popup.locator('#tabs')).toBeHidden();
    await expect(popup.locator('#stop')).toBeHidden();
    await popup.locator('#gateLinks [data-open=settings]').click();
    await expect(popup.locator('#settingsView')).toBeVisible();
    await expect(popup.locator('#login')).toBeHidden();
    await popup.locator('#settingsView [data-back]').click();
    await expect(popup.locator('#login')).toBeVisible();
  } finally { await ctx.close(); }
});
