// 上传：upload（契约 4.4、4.6）。
//
// 文件内容由 Chat 中转（插件凭 token 取），在页面里构造 File 放进文件框并触发 input / change；不用调试协议的
// DOM.setFileInputFiles（要用户勾「允许访问文件网址」，且只收本机路径）。
//
// 目标可以是文件框本身（或指向它的 label），也可以是会打开文件选择框的按钮：页面常把文件框藏起来，
// 编号只给看得见的元素。后一种情况插件拦下文件选择框（Page.setInterceptFileChooserDialog），拿到背后的
// 文件框。

import { mouseClick } from '../browser/input';
import type { AgentElementInfo } from '../browser/page-agent';
import type { UploadArgs } from '../protocol/args';
import { ActionError } from '../protocol/errors';
import type { ActionContext } from './context';
import { encodeBase64 } from './context';
import { refPoint } from './target';
import type { ActionOutput } from './types';

/** 每块原始字节数（base64 后约 1 MB）。 */
const CHUNK_BYTES = 768 * 1024;

export async function upload(ctx: ActionContext, a: UploadArgs): Promise<ActionOutput> {
  const s = await ctx.currentSession();
  const site = await ctx.ensureSite(s);
  s.assertNoDialog();

  const max = ctx.services.maxFileBytes();
  if (a.files.some((f) => max > 0 && f.size > max)) {
    throw new ActionError('file_too_large', 'One of the files is larger than the size limit for uploads.');
  }

  const frameId = s.frameForRef(a.ref);
  const info = await s.call<AgentElementInfo>(frameId, 'info', [a.ref]);

  let target: { kind: 'ref' } | { kind: 'object'; frameId: string; objectId: string };
  let field = info.field;
  let multiple = info.multiple;

  if (info.fileInput) {
    target = { kind: 'ref' };
  } else {
    await s.cdp.send('Page.setInterceptFileChooserDialog', { enabled: true });
    try {
      const opened = s.waitFor((m) => m === 'Page.fileChooserOpened', 3000, ctx.signal);
      const p = await refPoint(s, a.ref);
      await ctx.checkSiteUnchanged(s, site);
      await mouseClick(s, p.x, p.y, 'left', 1, 0);
      const ev = await opened;
      if (!ev || typeof ev.backendNodeId !== 'number' || typeof ev.frameId !== 'string') {
        throw new ActionError('action_failed', 'That element is not a file input and clicking it did not open a file picker; find the file input with browser_read.');
      }

      const objectId = await s.resolveNode(ev.frameId, ev.backendNodeId);
      const fi = await s.callOnElement<{ fileInput: boolean; multiple: boolean; field: string }>(ev.frameId, 'fileInputInfo', objectId);
      target = { kind: 'object', frameId: ev.frameId, objectId };
      field = fi.field || field;
      multiple = ev.mode === 'selectMultiple';
    } finally {
      await s.cdp.send('Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => undefined);
    }
  }

  if (!multiple && a.files.length > 1) {
    throw new ActionError('invalid_args', 'That file field takes only one file.');
  }

  const listed = a.files.map((f) => ({ name: f.name, size: f.size }));
  const r = await ctx.services.gate.confirm(ctx, {
    kind: 'upload',
    site: site ?? '',
    reviewDetail: { field, files: listed },
    promptDetail: { field, files: listed },
  });
  if (r.result !== 'allow') {
    ctx.throwIfAborted();
    throw new ActionError('user_denied', r.result === 'deny' && r.why === 'timeout'
      ? 'The user did not answer in time whether the assistant may upload the files.'
      : 'The user did not allow the upload.');
  }

  const transport = ctx.services.transport();
  if (!transport) {
    throw new ActionError('action_failed', 'The files could not be fetched because the browser is not connected.');
  }

  const targetFrame = target.kind === 'ref' ? frameId : target.frameId;
  const staged: Array<{ id: string; name: string; mimeType: string }> = [];
  for (const f of a.files) {
    const blob = await transport.fetchUpload(ctx.requestId, f.token);
    if (max > 0 && blob.size > max) {
      throw new ActionError('file_too_large', `"${f.name}" is larger than the size limit for uploads.`);
    }

    const bytes = new Uint8Array(await blob.arrayBuffer());
    const id = crypto.randomUUID();
    for (let off = 0; off < bytes.length; off += CHUNK_BYTES) {
      ctx.throwIfAborted();
      await s.call(targetFrame, 'uploadChunk', [id, encodeBase64(bytes.subarray(off, off + CHUNK_BYTES))]);
    }

    staged.push({ id, name: f.name, mimeType: f.contentType || 'application/octet-stream' });
  }

  await ctx.checkSiteUnchanged(s, site);
  const err = await ctx.guarded(s, () => (target.kind === 'ref'
    ? s.call<string | null>(frameId, 'setFiles', [a.ref, staged])
    : s.callOnElement<string | null>(target.frameId, 'setFilesOn', target.objectId, [staged])));

  if (err) {
    throw new ActionError('action_failed', `The files could not be put into that field (${err}).`);
  }

  return { session: s, payload: { uploaded: listed } };
}
