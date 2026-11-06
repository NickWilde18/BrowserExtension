// 一个已附着的标签页：框架树、执行上下文、页面代理、对话框、导航、日志（契约第 4 节各动作的底座）。
//
// - 主框架在附着的根会话里；跨源 iframe（站点隔离后在别的进程）经 Target.setAutoAttach 的子会话
//   （chrome.debugger 的 DebuggerSession.sessionId）。
// - 页面代理装在每个框架的隔离世界里（Page.createIsolatedWorld）：页面自己的脚本看不到它，它看得到
//   同一份 DOM。
// - 编号前缀：主框架没有前缀（e12），其他框架按本标签页里首次见到的顺序编号（f1e3）。

import { INJECTED_SOURCE } from 'virtual:injected-source';
import { siteOf } from '../policy/url';
import { ActionError } from '../protocol/errors';
import type { PageDialog, PageInfo } from '../protocol/frames';
import { Cdp, CdpError } from './cdp';
import { pageAgent } from './page-agent';
import { Recorder } from './recorder';

const WORLD_NAME = '__bx_agent';

/** 在隔离世界里调用代理方法的函数（固定写法，参数经 CallArgument 传值，不拼进源码）。 */
const CALL_AGENT = 'function(m, ...a) { return globalThis.__bxAgent[m](...a); }';

/** 框架内容区左上角在父框架视口里的位置（iframe 的边框与内边距之内）。 */
const FRAME_CONTENT_ORIGIN = `function() {
  this.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  const r = this.getBoundingClientRect();
  const cs = getComputedStyle(this);
  return { x: r.left + this.clientLeft + (parseFloat(cs.paddingLeft) || 0), y: r.top + this.clientTop + (parseFloat(cs.paddingTop) || 0) };
}`;

interface FrameInfo {
  id: string;
  parentId: string | null;
  /** 所在会话：undefined 是根会话。 */
  sessionId: string | undefined;
  seq: number;
  url: string;
  agentContext: number | null;
  agentPending: Promise<number> | null;
  mainContext: number | null;
}

interface FrameTree {
  frame: { id: string; parentId?: string; url?: string };
  childFrames?: FrameTree[];
}

type Listener = (method: string, params: Record<string, unknown>, sessionId: string | undefined) => void;

function bootstrapExpression(seq: number): string {
  const options = {
    isUnderTest: false,
    sdkLanguage: 'javascript',
    frameSeq: seq,
    testIdAttributeName: 'data-testid',
    stableRafCount: 1,
    browserName: 'chromium',
    shouldPrependErrorPrefix: false,
    isUtilityWorld: true,
    customEngines: [],
  };

  return `(() => {
  if (globalThis.__bxAgent) { return true; }
  const module = {};
  ${INJECTED_SOURCE}
  const injected = new (module.exports.InjectedScript())(globalThis, ${JSON.stringify(options)});
  globalThis.__bxAgent = (${pageAgent.toString()})(injected);
  return true;
})()`;
}

/** 页面代理里抛出的错误 → ActionError。 */
function agentError(details: { exception?: { description?: string }; text?: string }): ActionError {
  const text = details.exception?.description ?? details.text ?? '';
  if (text.includes('bx:element_not_found')) {
    return new ActionError('element_not_found', 'That element ref is not in the latest page snapshot; the page may have changed. Call browser_read again.');
  }

  // Playwright 注入脚本的报错（如 "Element is not a <select> element"）是写给人看的英文，取第一行。
  const first = text.split('\n')[0]?.replace(/^Error:\s*/, '').slice(0, 300) ?? '';
  return new ActionError('action_failed', first || 'The page rejected this action.');
}

export class TabSession {
  readonly cdp: Cdp;
  readonly recorder = new Recorder();
  mainFrameId = '';
  dialog: (PageDialog & { sessionId: string | undefined }) | null = null;
  detached = false;
  /** Page.downloadWillBegin（下载开始）的接收方，见 downloads.ts。 */
  onDownloadWillBegin: ((params: { url: string; suggestedFilename: string; guid: string }) => void) | null = null;

  private readonly frames = new Map<string, FrameInfo>();
  private readonly seqToFrame = new Map<number, string>();
  private nextSeq = 1;
  private readonly listeners = new Set<Listener>();
  private unsubscribe: (() => void) | null = null;

  private constructor(readonly tabId: number) {
    this.cdp = new Cdp(tabId);
  }

  /** 附着并初始化。附着不上时抛 ActionError（unsupported_page / attach_failed）。 */
  static async attach(tabId: number): Promise<TabSession> {
    const s = new TabSession(tabId);
    s.unsubscribe = s.cdp.on((m, p, sid) => s.onEvent(m, p, sid));

    try {
      await s.cdp.attach();
    } catch (err) {
      s.unsubscribe?.();
      const msg = err instanceof Error ? err.message : '';
      if (/cannot access|cannot attach to this target|chrome:\/\/|extensions gallery|webstore/i.test(msg)) {
        throw new ActionError('unsupported_page', 'This page cannot be controlled by the extension (browser or store pages).');
      }

      throw new ActionError('attach_failed', 'The extension could not take control of this tab. If DevTools is open on it, close DevTools and try again.');
    }

    try {
      await s.initSession(undefined);
      const tree = await s.cdp.send<{ frameTree: FrameTree }>('Page.getFrameTree');
      s.mainFrameId = tree.frameTree.frame.id;
      s.registerTree(tree.frameTree, undefined);
    } catch (err) {
      await s.detach();
      throw new ActionError('attach_failed', 'The extension could not set up this tab.');
    }

    return s;
  }

  async detach(): Promise<void> {
    if (this.detached) {
      return;
    }

    this.detached = true;
    this.unsubscribe?.();
    await this.cdp.detach();
  }

  /** 订阅本标签页的调试事件；返回取消订阅。 */
  on(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** 等一个满足条件的事件；超时或中止时 resolve null。 */
  waitFor(pred: (method: string, params: Record<string, unknown>, sessionId: string | undefined) => boolean, timeoutMs: number,
    signal?: AbortSignal): Promise<Record<string, unknown> | null> {
    return new Promise((resolve) => {
      let off: (() => void) | null = null;
      const done = (v: Record<string, unknown> | null) => {
        off?.();
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        resolve(v);
      };

      const onAbort = () => done(null);
      const timer = setTimeout(() => done(null), timeoutMs);
      off = this.on((m, p, sid) => {
        if (pred(m, p, sid)) {
          done(p);
        }
      });
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  /** 编号所在的框架。编号前缀不认识时抛 element_not_found。 */
  frameForRef(ref: string): string {
    const m = /^(?:f(\d+))?e\d+$/.exec(ref);
    if (!m) {
      throw new ActionError('invalid_args', 'Element refs look like e12 or f1e3.');
    }

    if (m[1] === undefined) {
      return this.mainFrameId;
    }

    const frameId = this.seqToFrame.get(Number(m[1]));
    if (!frameId || !this.frames.has(frameId)) {
      throw new ActionError('element_not_found', 'That element is in a frame that is no longer on the page. Call browser_read again.');
    }

    return frameId;
  }

  frameSession(frameId: string): string | undefined {
    return this.frames.get(frameId)?.sessionId;
  }

  /** 调页面代理的方法（在框架的隔离世界里），返回值按值传回。 */
  async call<T>(frameId: string, method: string, args: unknown[] = []): Promise<T> {
    const res = await this.callRaw(frameId, method, args, true);
    return res.value as T;
  }

  /** 调页面代理的方法，返回远程对象 id（取元素交给 DOM.* 命令用）。 */
  async callObject(frameId: string, method: string, args: unknown[] = []): Promise<string> {
    const res = await this.callRaw(frameId, method, args, false);
    if (!res.objectId) {
      throw new ActionError('element_not_found', 'That element is no longer on the page. Call browser_read again.');
    }

    return res.objectId;
  }

  /** 把后端节点解析成框架隔离世界里的对象 id（文件选择框拦截给出的是后端节点）。 */
  async resolveNode(frameId: string, backendNodeId: number): Promise<string> {
    const ctx = await this.agent(frameId);
    const resolved = await this.cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode',
      { backendNodeId, executionContextId: ctx }, this.frameSession(frameId));
    if (!resolved.object.objectId) {
      throw new ActionError('element_not_found', 'That element is no longer on the page.');
    }

    return resolved.object.objectId;
  }

  /** 调页面代理的方法，第一个参数是给定的元素对象（同一框架隔离世界里的对象 id）。 */
  async callOnElement<T>(frameId: string, method: string, objectId: string, args: unknown[] = []): Promise<T> {
    const ctx = await this.agent(frameId);
    const res = await this.cdp.send<{
      result: { value?: unknown };
      exceptionDetails?: { exception?: { description?: string }; text?: string };
    }>('Runtime.callFunctionOn', {
      functionDeclaration: CALL_AGENT,
      executionContextId: ctx,
      arguments: [{ value: method }, { objectId }, ...args.map((v) => (v === undefined ? {} : { value: v }))],
      returnByValue: true,
      awaitPromise: true,
    }, this.frameSession(frameId));

    if (res.exceptionDetails) {
      throw agentError(res.exceptionDetails);
    }

    return res.result.value as T;
  }

  /** 已登记的框架（主框架在前）。 */
  frameIds(): string[] {
    const ids = [...this.frames.keys()];
    return [this.mainFrameId, ...ids.filter((id) => id !== this.mainFrameId)];
  }

  /** 框架内容区左上角在顶层视口里的位置（主框架是 0,0）。 */
  async frameOffset(frameId: string): Promise<{ x: number; y: number }> {
    let x = 0;
    let y = 0;
    let frame = this.frames.get(frameId);

    while (frame && frame.parentId) {
      const parent = this.frames.get(frame.parentId);
      if (!parent) {
        break;
      }

      const owner = await this.cdp.send<{ backendNodeId: number }>('DOM.getFrameOwner', { frameId: frame.id }, parent.sessionId);
      const ctx = await this.agent(parent.id);
      const resolved = await this.cdp.send<{ object: { objectId?: string } }>('DOM.resolveNode',
        { backendNodeId: owner.backendNodeId, executionContextId: ctx }, parent.sessionId);
      if (!resolved.object.objectId) {
        throw new ActionError('element_not_found', 'The frame holding that element is gone. Call browser_read again.');
      }

      const res = await this.cdp.send<{ result: { value?: { x: number; y: number } } }>('Runtime.callFunctionOn', {
        objectId: resolved.object.objectId,
        functionDeclaration: FRAME_CONTENT_ORIGIN,
        returnByValue: true,
      }, parent.sessionId);
      x += res.result.value?.x ?? 0;
      y += res.result.value?.y ?? 0;
      frame = parent;
    }

    return { x, y };
  }

  /** iframe 元素（由编号给出）所承载的框架 id。 */
  async childFrameOf(frameId: string, iframeRef: string): Promise<string | null> {
    const objectId = await this.callObject(frameId, 'element', [iframeRef]);
    const desc = await this.cdp.send<{ node: { frameId?: string } }>('DOM.describeNode', { objectId }, this.frameSession(frameId));
    const child = desc.node.frameId;
    return child && this.frames.has(child) ? child : null;
  }

  /** 页面主世界的执行上下文（browser_evaluate 在这里跑页面自己的脚本环境）。 */
  mainContextOf(frameId: string): number | null {
    return this.frames.get(frameId)?.mainContext ?? null;
  }

  /** 动作之后 AI 当前页的网址、标题、来源，以及未处理的对话框。不经页面脚本（对话框开着时脚本被阻塞）。 */
  async pageInfo(): Promise<PageInfo> {
    let url = '';
    let title = '';
    try {
      const tab = await chrome.tabs.get(this.tabId);
      url = tab.url ?? tab.pendingUrl ?? '';
      title = tab.title ?? '';
    } catch {
      // 标签页刚被关掉。
    }

    const info: PageInfo = { url, title, origin: siteOf(url) ?? '' };
    if (this.dialog) {
      const d: PageDialog = { type: this.dialog.type, message: this.dialog.message };
      if (this.dialog.default_prompt !== undefined) {
        d.default_prompt = this.dialog.default_prompt;
      }

      info.dialog = d;
    }

    return info;
  }

  /** 页面上开着对话框时，除了 dialog 动作都做不了（页面脚本被它阻塞）。 */
  assertNoDialog(): void {
    if (this.dialog) {
      throw new ActionError('action_failed', 'A dialog is open on the page; handle it with browser_dialog first.');
    }
  }

  // ---- 内部 ----

  private async callRaw(frameId: string, method: string, args: unknown[], byValue: boolean): Promise<{ value?: unknown; objectId?: string }> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctx = await this.agent(frameId);
      try {
        const res = await this.cdp.send<{
          result: { value?: unknown; objectId?: string };
          exceptionDetails?: { exception?: { description?: string }; text?: string };
        }>('Runtime.callFunctionOn', {
          functionDeclaration: CALL_AGENT,
          executionContextId: ctx,
          arguments: [{ value: method }, ...args.map((v) => (v === undefined ? {} : { value: v }))],
          returnByValue: byValue,
          awaitPromise: true,
        }, this.frameSession(frameId));

        if (res.exceptionDetails) {
          throw agentError(res.exceptionDetails);
        }

        return res.result;
      } catch (err) {
        // 上下文在调用前一刻没了（页面刚导航）：重新装一次代理再试一次。
        if (err instanceof CdpError && /context/i.test(err.message) && attempt === 0) {
          const f = this.frames.get(frameId);
          if (f) {
            f.agentContext = null;
          }

          continue;
        }

        throw err;
      }
    }

    throw new ActionError('action_failed', 'The page changed while the extension was working on it. Try again.');
  }

  /** 框架隔离世界里装好代理，返回上下文 id。并发调用共用一次安装。 */
  private agent(frameId: string): Promise<number> {
    const frame = this.frames.get(frameId);
    if (!frame) {
      return Promise.reject(new ActionError('element_not_found', 'That frame is no longer on the page. Call browser_read again.'));
    }

    if (frame.agentContext !== null) {
      return Promise.resolve(frame.agentContext);
    }

    if (frame.agentPending) {
      return frame.agentPending;
    }

    frame.agentPending = (async () => {
      try {
        const world = await this.cdp.send<{ executionContextId: number }>('Page.createIsolatedWorld',
          { frameId, worldName: WORLD_NAME, grantUniveralAccess: false }, frame.sessionId);
        const res = await this.cdp.send<{ exceptionDetails?: unknown }>('Runtime.evaluate', {
          expression: bootstrapExpression(frame.seq),
          contextId: world.executionContextId,
          returnByValue: true,
        }, frame.sessionId);
        if (res.exceptionDetails) {
          throw new ActionError('action_failed', 'The extension could not read this page.');
        }

        frame.agentContext = world.executionContextId;
        return world.executionContextId;
      } finally {
        frame.agentPending = null;
      }
    })();

    return frame.agentPending;
  }

  private async initSession(sessionId: string | undefined): Promise<void> {
    await Promise.all([
      this.cdp.send('Page.enable', {}, sessionId),
      this.cdp.send('Runtime.enable', {}, sessionId),
      this.cdp.send('Network.enable', {}, sessionId),
      this.cdp.send('Log.enable', {}, sessionId),
    ]);

    try {
      await this.cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, sessionId);
    } catch {
      // 不支持子会话的版本：跨源 iframe 读不到，其余照常。
    }
  }

  private registerTree(tree: FrameTree, sessionId: string | undefined): void {
    this.registerFrame(tree.frame.id, tree.frame.parentId ?? null, sessionId, tree.frame.url ?? '');
    for (const child of tree.childFrames ?? []) {
      this.registerTree(child, sessionId);
    }
  }

  private registerFrame(id: string, parentId: string | null, sessionId: string | undefined, url: string): void {
    const existing = this.frames.get(id);
    if (existing) {
      existing.sessionId = sessionId;
      existing.url = url || existing.url;
      if (parentId !== null) {
        existing.parentId = parentId;
      }

      existing.agentContext = null;
      existing.mainContext = null;
      return;
    }

    const seq = parentId === null && sessionId === undefined ? 0 : this.nextSeq++;
    this.frames.set(id, { id, parentId, sessionId, seq, url, agentContext: null, agentPending: null, mainContext: null });
    if (seq > 0) {
      this.seqToFrame.set(seq, id);
    }
  }

  private onEvent(method: string, params: Record<string, unknown>, sessionId: string | undefined): void {
    this.recorder.onEvent(method, params, sessionId);

    switch (method) {
      case 'Page.frameAttached':
        this.registerFrame(String(params.frameId), (params.parentFrameId as string | undefined) ?? null, sessionId, '');
        break;
      case 'Page.frameNavigated': {
        const frame = params.frame as { id: string; parentId?: string; url?: string };
        const f = this.frames.get(frame.id);
        if (f && f.sessionId === sessionId) {
          f.url = frame.url ?? '';
          f.agentContext = null;
          f.mainContext = null;
        } else if (!f) {
          this.registerFrame(frame.id, frame.parentId ?? null, sessionId, frame.url ?? '');
        }

        break;
      }
      case 'Page.frameDetached':
        // swap：框架换进了别的进程，等子会话附着时重新登记；remove：真没了。
        if (params.reason !== 'swap') {
          this.frames.delete(String(params.frameId));
        }

        break;
      case 'Runtime.executionContextCreated': {
        const ctx = params.context as { id: number; auxData?: { frameId?: string; isDefault?: boolean } };
        const f = ctx.auxData?.frameId ? this.frames.get(ctx.auxData.frameId) : undefined;
        if (f && f.sessionId === sessionId && ctx.auxData?.isDefault) {
          f.mainContext = ctx.id;
        }

        break;
      }
      case 'Runtime.executionContextDestroyed': {
        const id = Number(params.executionContextId);
        for (const f of this.frames.values()) {
          if (f.sessionId === sessionId) {
            if (f.agentContext === id) {
              f.agentContext = null;
            }

            if (f.mainContext === id) {
              f.mainContext = null;
            }
          }
        }

        break;
      }
      case 'Runtime.executionContextsCleared':
        for (const f of this.frames.values()) {
          if (f.sessionId === sessionId) {
            f.agentContext = null;
            f.mainContext = null;
          }
        }

        break;
      case 'Page.javascriptDialogOpening': {
        const d: PageDialog & { sessionId: string | undefined } = {
          type: String(params.type ?? 'alert'),
          message: String(params.message ?? '').slice(0, 2000),
          sessionId,
        };
        if (params.type === 'prompt' && typeof params.defaultPrompt === 'string') {
          d.default_prompt = params.defaultPrompt.slice(0, 2000);
        }

        this.dialog = d;
        break;
      }
      case 'Page.javascriptDialogClosed':
        this.dialog = null;
        break;
      case 'Page.downloadWillBegin':
        this.onDownloadWillBegin?.({
          url: String(params.url ?? ''),
          suggestedFilename: String(params.suggestedFilename ?? ''),
          guid: String(params.guid ?? ''),
        });
        break;
      case 'Target.attachedToTarget': {
        const info = params.targetInfo as { targetId: string; type: string };
        const child = String(params.sessionId);
        if (info.type === 'iframe') {
          void this.attachChild(child);
        } else {
          // 只要 iframe；别的（worker 等）不碰，放它运行。
          void this.cdp.send('Runtime.runIfWaitingForDebugger', {}, child).catch(() => undefined);
        }

        break;
      }
      case 'Target.detachedFromTarget': {
        const child = String(params.sessionId);
        for (const [id, f] of this.frames) {
          if (f.sessionId === child) {
            this.frames.delete(id);
          }
        }

        break;
      }
      default:
    }

    for (const l of this.listeners) {
      try {
        l(method, params, sessionId);
      } catch {
        // 忽略监听者的错误。
      }
    }
  }

  private async attachChild(sessionId: string): Promise<void> {
    try {
      await this.initSession(sessionId);
      const tree = await this.cdp.send<{ frameTree: FrameTree }>('Page.getFrameTree', {}, sessionId);
      this.registerTree(tree.frameTree, sessionId);
    } catch {
      // 子框架在初始化前就没了。
    }
  }
}
