import { expect, test } from '@playwright/test';
import { A, actOnPrompt, aiPage, allowSite, answer, approvalWindow, call, launch, refOf, result, send, type Harness } from './helpers';
let h: Harness;
test.beforeEach(async () => { h = await launch(); await allowSite(h, A); });
test.afterEach(async () => { await h.close(); });

for (const kind of ['密码确认', '自输完成', '脚本确认', '上传确认', '跨站确认', '下载确认'] as const) {
  test(`${kind}超时保留准确结果与已发生效果`, async () => {
    const file = kind === '上传确认' ? 'upload' : kind === '跨站确认' ? 'crosssite' : kind === '下载确认' ? 'download' : 'form';
    expect((await call(h, 'open', { url: `${A}/${file}.html` })).outcome).toBe('ok');
    const snapshot = String((await call(h, 'read')).payload?.snapshot);
    let action = 'type';
    let args: Record<string, unknown> = {};
    if (kind === '密码确认' || kind === '自输完成') args = { element: 'Password', ref: refOf(snapshot, 'textbox "Password"'), text: 'synthetic' };
    if (kind === '脚本确认') { action = 'evaluate'; args = { function: '() => document.title' }; }
    if (kind === '上传确认') { action = 'upload'; args = { element: 'Attachment', ref: refOf(snapshot, 'Attachment'), files: [{ token: 'timeout-token', name: 'test.txt', size: 1, content_type: 'text/plain' }] }; }
    if (kind === '跨站确认') { action = 'click'; args = { element: 'Other site', ref: refOf(snapshot, 'Other site') }; }
    if (kind === '下载确认') { action = 'click'; args = { element: 'Get the report', ref: refOf(snapshot, 'Get the report') }; }
    const id = await send(h, action, args, { authWaitMs: 1500 });
    await approvalWindow(h);
    if (kind === '自输完成') {
      await answer(h, 'Enter it myself');
      const page = await aiPage(h, '/form.html');
      await page.locator('#pw').fill('user-edited');
    }
    const r = await result(h, id);
    if (kind === '下载确认') expect(r).toMatchObject({ outcome: 'ok', payload: { download_denied: true, download_timed_out: true } });
    else expect(r).toMatchObject({ outcome: 'error', code: 'approval_timeout' });
    if (kind === '自输完成') expect(await (await aiPage(h, '/form.html')).locator('#pw').inputValue()).toBe('user-edited');
    // 到时没答：确认窗留着，改显示「确认已过期，请查看页面」，只剩关闭；点关闭才关窗。
    const prompt = h.ctx.pages().find((p) => p.url().includes('approval.html'))!;
    await expect(prompt.locator('#title')).toHaveText('Confirmation expired');
    await expect(prompt.locator('#body')).toHaveText('If you do not confirm in time, waiting ends. Please check the page.');
    await expect(prompt.locator('#buttons button')).toHaveText(['Close']);
    await actOnPrompt(prompt, () => prompt.locator('#buttons button').click());
    await expect.poll(() => h.ctx.pages().filter((p) => p.url().includes('approval.html')).length).toBe(0);
  });
}
