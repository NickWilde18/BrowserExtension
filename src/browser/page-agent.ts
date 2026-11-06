// 页面里的代理：与 Playwright 注入脚本一起装进每个框架的**隔离世界**（页面自己的脚本看不到它，
// 见 frames.ts 的 ensureAgent）。只操作 DOM，不碰 Cookie、localStorage、sessionStorage。
//
// pageAgent 会被 Function.prototype.toString() 序列化后注入页面，所以**必须自包含**：不能引用本文件
// 以外的任何变量、import 或 helper。参数 injected 是 Playwright 的 InjectedScript 实例。

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface AgentSnapshot {
  text: string;
  iframeRefs: string[];
  iframeDepths: Record<string, number>;
}

export interface AgentPoint {
  x: number;
  y: number;
  /** 点上去会落到别的元素上时，那个元素的描述。 */
  covered?: string;
}

export interface AgentElementInfo {
  tag: string;
  type: string;
  password: boolean;
  fileInput: boolean;
  multiple: boolean;
  checkable: boolean;
  checked: boolean;
  select: boolean;
  /** 给人看的字段名：无障碍名，没有就用 name / id 属性。 */
  field: string;
}

export interface AgentFindMatch {
  ref: string;
  role: string;
  name: string;
  text: string;
}

export function pageAgent(injected: any): any {
  const refs = new Map<string, WeakRef<Element>>();
  const uploads = new Map<string, string[]>();
  const downloads = new Map<string, Uint8Array>();

  const remember = (): void => {
    const snap = injected._lastAriaSnapshotForQuery;
    if (!snap || !snap.info) {
      return;
    }

    for (const [ref, info] of snap.info as Map<string, { element: Element }>) {
      refs.set(ref, new WeakRef(info.element));
    }
  };

  const lookup = (ref: string): Element | null => {
    const el = refs.get(ref)?.deref();
    return el && el.isConnected ? el : null;
  };

  const need = (ref: string): Element => {
    const el = lookup(ref);
    if (!el) {
      throw new Error('bx:element_not_found');
    }

    return el;
  };

  const clip = (s: string, n: number): string => {
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };

  const fieldName = (el: Element): string => {
    let name = '';
    try {
      name = injected.utils.getElementAccessibleNameText(el, false) || '';
    } catch {
      name = '';
    }

    if (!name) {
      name = el.getAttribute('name') || el.getAttribute('id') || el.getAttribute('placeholder') || '';
    }

    return clip(name, 100);
  };

  const inViewport = (r: DOMRect): boolean =>
    r.top >= 0 && r.left >= 0 && r.bottom <= window.innerHeight && r.right <= window.innerWidth;

  const toBase64 = (bytes: Uint8Array): string => {
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }

    return btoa(binary);
  };

  return {
    /** 无障碍快照（Playwright 的 ai 模式，元素带 [ref=…]）。ref 为 null 时取整页。 */
    snapshot(ref: string | null, depth: number | null, boxes: boolean): AgentSnapshot {
      const root = ref ? need(ref) : (document.body || document.documentElement);
      const options: Record<string, unknown> = { mode: 'ai' };
      if (depth) {
        options.depth = depth;
      }

      if (boxes) {
        options.boxes = true;
      }

      const r = injected.ariaSnapshotWithRefs(root, options);
      remember();
      return { text: r.text, iframeRefs: r.iframeRefs, iframeDepths: r.iframeDepths };
    },

    /** 编号对应的元素（调用方取 objectId 用）。 */
    element(ref: string): Element {
      return need(ref);
    },

    info(ref: string): AgentElementInfo {
      const raw = need(ref);
      const el = (injected.retarget(raw, 'follow-label') as Element | null) || raw;
      const input = el instanceof HTMLInputElement ? el : null;
      const type = (input?.type || el.getAttribute('type') || '').toLowerCase();
      const role = el.getAttribute('role') || '';
      const checkable = (!!input && (type === 'checkbox' || type === 'radio')) || role === 'checkbox' || role === 'radio' || role === 'switch';
      let checked = false;
      if (input && checkable) {
        checked = input.checked;
      } else if (checkable) {
        checked = el.getAttribute('aria-checked') === 'true';
      }

      return {
        tag: el.nodeName.toLowerCase(),
        type,
        password: !!input && type === 'password',
        fileInput: !!input && type === 'file',
        multiple: !!input && input.multiple,
        checkable,
        checked,
        select: el instanceof HTMLSelectElement,
        field: fieldName(el),
      };
    },

    /** 点击坐标（本框架视口内的 CSS 像素）：先滚到可见，再取中心点，并检查那一点有没有被别的元素挡住。 */
    point(ref: string): AgentPoint | { error: 'not_visible' } {
      const el = need(ref);
      let rect = el.getBoundingClientRect();
      if (!inViewport(rect)) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
        rect = el.getBoundingClientRect();
      }

      if (rect.width <= 0 || rect.height <= 0) {
        return { error: 'not_visible' };
      }

      const x = rect.left + rect.width / 2;
      const y = rect.top + rect.height / 2;
      const hit = injected.expectHitTarget({ x, y }, el);
      if (hit === 'done') {
        return { x, y };
      }

      return { x, y, covered: clip(String(hit?.hitTargetDescription ?? 'another element'), 200) };
    },

    /** 元素的包围盒（截图裁剪用）。 */
    box(ref: string): { x: number; y: number; width: number; height: number } {
      const el = need(ref);
      el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      const r = el.getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    },

    /** Playwright 的 fill：日期、颜色、滑块等直接设值返回 done；文本类选中现有内容返回 needsinput。 */
    fill(ref: string, value: string): string {
      return injected.fill(need(ref), value);
    },

    focus(ref: string): boolean {
      const el = (injected.retarget(need(ref), 'follow-label') as HTMLElement | null) || (need(ref) as HTMLElement);
      el.focus();
      return document.activeElement === el || el.contains(document.activeElement);
    },

    /** 按值或可见文字选下拉选项；返回选中的值，或 error:… 字符串。 */
    selectOptions(ref: string, values: string[]): string[] | string {
      return injected.selectOptions(need(ref), values.map((v) => ({ valueOrLabel: v })));
    },

    scrollIntoView(ref: string): boolean {
      need(ref).scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
      return true;
    },

    /** 在最新快照的元素里按文字或正则找，只留最具体的（去掉包含别的命中项的祖先）。 */
    find(text: string | null, pattern: string | null): { matches: AgentFindMatch[]; total: number } {
      injected.ariaSnapshotWithRefs(document.body || document.documentElement, { mode: 'ai' });
      remember();

      const snap = injected._lastAriaSnapshotForQuery;
      // 调试协议把值为 null 的参数当成没给，这里收到的是 undefined：用 == null 判空。
      const re = pattern != null ? new RegExp(pattern) : null;
      const needle = text != null ? text.toLowerCase() : null;
      const hits: Array<{ ref: string; el: Element; name: string; text: string }> = [];

      for (const [ref, info] of snap.info as Map<string, { element: Element }>) {
        const el = info.element;
        const own = ((el instanceof HTMLElement ? el.innerText : el.textContent) || '').replace(/\s+/g, ' ').trim();
        const value = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : '';
        const name = fieldName(el);
        // 每一段分别匹配：拼成一串的话，正则里的 ^ $ 只对整串首尾生效。
        const ok = [own, name, value].some((part) => part !== '' &&
          (re ? re.test(part) : needle !== null && part.toLowerCase().includes(needle)));
        if (ok) {
          hits.push({ ref, el, name, text: own });
        }
      }

      const specific = hits.filter((h) => !hits.some((o) => o !== h && h.el.contains(o.el)));
      specific.sort((a, b) => (a.el.compareDocumentPosition(b.el) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));

      return {
        total: specific.length,
        matches: specific.slice(0, 50).map((h) => ({
          ref: h.ref,
          role: String(injected.utils.getAriaRole(h.el) || h.el.nodeName.toLowerCase()),
          name: h.name,
          text: clip(h.text, 200),
        })),
      };
    },

    /** 页面上能看到的文字里有没有这一段（browser_wait）。 */
    hasText(text: string): boolean {
      return ((document.body && document.body.innerText) || '').includes(text);
    },

    /** 上传：分块收下文件内容（base64）。 */
    uploadChunk(id: string, chunk: string): number {
      const list = uploads.get(id) ?? [];
      list.push(chunk);
      uploads.set(id, list);
      return list.length;
    },

    /** 上传：把收齐的文件放进编号指向的文件框（跟随 label）。 */
    setFiles(ref: string, files: Array<{ id: string; name: string; mimeType: string }>): string | null {
      const el = (injected.retarget(need(ref), 'follow-label') as Element | null) || need(ref);
      return this.setFilesOn(el, files);
    },

    /**
     * 上传：把收齐的文件放进给定的文件框（Playwright 的 setInputFiles：页面里构造 File 放进 input.files，
     * 触发 input / change）。返回错误说明，成功返回 null。
     */
    setFilesOn(el: Element, files: Array<{ id: string; name: string; mimeType: string }>): string | null {
      const payloads = files.map((f) => ({
        name: f.name,
        mimeType: f.mimeType,
        buffer: (uploads.get(f.id) ?? []).join(''),
        lastModifiedMs: Date.now(),
      }));

      for (const f of files) {
        uploads.delete(f.id);
      }

      const err = injected.setInputFiles(el, payloads);
      return typeof err === 'string' ? err : null;
    },

    /** 给定元素是不是文件框、允不允许多选（文件选择框拦截给出的元素用）。 */
    fileInputInfo(el: Element): { fileInput: boolean; multiple: boolean; field: string } {
      const input = el instanceof HTMLInputElement ? el : null;
      return { fileInput: !!input && input.type === 'file', multiple: !!input && input.multiple, field: fieldName(el) };
    },

    /** 下载：带着本页的登录态把文件重新取一次，内容留在隔离世界里等后台分块取走。 */
    async fetchDownload(id: string, url: string, maxBytes: number): Promise<Record<string, unknown>> {
      let res: Response;
      try {
        res = await fetch(url, { credentials: 'include' });
      } catch {
        return { ok: false, reason: 'network' };
      }

      if (!res.ok) {
        return { ok: false, reason: 'status', status: res.status };
      }

      const declared = Number(res.headers.get('content-length') || '0');
      if (declared > maxBytes) {
        return { ok: false, reason: 'too_large', size: declared };
      }

      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length > maxBytes) {
        return { ok: false, reason: 'too_large', size: bytes.length };
      }

      downloads.set(id, bytes);
      return {
        ok: true,
        size: bytes.length,
        contentType: res.headers.get('content-type') || '',
        disposition: res.headers.get('content-disposition') || '',
      };
    },

    downloadChunk(id: string, offset: number, length: number): string {
      const bytes = downloads.get(id);
      if (!bytes) {
        throw new Error('bx:download_gone');
      }

      return toBase64(bytes.subarray(offset, offset + length));
    },

    dropDownload(id: string): void {
      downloads.delete(id);
    },

    /** 设备像素比（截图换算成 CSS 像素用）。 */
    devicePixelRatio(): number {
      return window.devicePixelRatio || 1;
    },
  };
}
