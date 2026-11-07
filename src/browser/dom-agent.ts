// 由 scripting 在隔离世界加载。快照依赖以构建时 JS 嵌入，不使用 eval/Function。
import { InjectedScript } from 'virtual:injected-runtime';
import { pageAgent } from './page-agent';
import type { ReadArgs } from '../protocol/args';
import type { DomReadResult } from './dom-read';

(() => {
  const world = globalThis as typeof globalThis & {
    __browserRead?: (input: ReadArgs & { origin: string }) => DomReadResult;
    __browserReadToken?: string;
  };
  if (world.__browserRead) return;
  const token = Array.from(crypto.getRandomValues(new Uint32Array(4)), (n) => n.toString(16)).join('-');
  let agent: ReturnType<typeof pageAgent> | null = null;
  world.__browserReadToken = token;
  world.__browserRead = (input) => {
    if (location.origin !== input.origin) return { error: 'site_changed' };
    // 基础子集不输出看似完整但遗漏 frame 的快照，也不绕过跨源权限。
    if (document.querySelector('iframe,frame') || !window.innerWidth || !window.innerHeight) return { error: 'unsupported_page' };
    try {
      if (!agent) {
        const injected = new InjectedScript(globalThis, {
          isUnderTest: false, sdkLanguage: 'javascript', frameSeq: 0, testIdAttributeName: 'data-testid',
          stableRafCount: 1, browserName: 'generic', shouldPrependErrorPrefix: false, isUtilityWorld: true, customEngines: [],
        });
        agent = pageAgent(injected);
      }
      const snapshot = agent.snapshot(input.ref ?? null, input.depth ?? null, input.boxes);
      if (snapshot.iframeRefs.length) return { error: 'unsupported_page' };
      return { snapshot: snapshot.text, token,
        page: { url: location.href, title: document.title, origin: location.origin } };
    } catch (error) {
      return { error: error instanceof Error && error.message.includes('bx:element_not_found') ? 'element_not_found' : 'action_failed' };
    }
  };
})();
