import { defineConfig } from '@playwright/test';

// 端到端测试：加载 dist-test（测试构建：连接换成内存假传输，测试代码扮演 Chat），对本地夹具站点真跑动作。
// 每个用例自己起一个持久化上下文（插件只能装在持久化上下文里），所以串行跑。
export default defineConfig({
  testDir: 'test/e2e',
  testMatch: /.*\.spec\.ts/,
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  globalSetup: './test/e2e/global-setup.ts',
});
