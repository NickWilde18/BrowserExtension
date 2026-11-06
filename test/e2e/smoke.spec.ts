import { expect, test } from '@playwright/test';

import { A, allowSite, call, launch } from './helpers';

test('open 之后 read 出带编号的快照', async () => {
  const h = await launch();
  try {
    await allowSite(h, A);
    const opened = await call(h, 'open', { url: `${A}/form.html` });
    expect(opened.outcome, JSON.stringify(opened)).toBe('ok');
    expect(opened.page?.url).toBe(`${A}/form.html`);
    expect(opened.page?.title).toBe('Form');

    const read = await call(h, 'read');
    expect(read.outcome, JSON.stringify(read)).toBe('ok');
    const snap = String(read.payload?.snapshot ?? '');
    console.log(snap);
    expect(snap).toContain('textbox "Name"');
    expect(snap).toMatch(/\[ref=e\d+\]/);
  } finally {
    await h.close();
  }
});
