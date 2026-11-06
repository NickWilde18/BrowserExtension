import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  define: {
    __PLATFORM_ORIGIN__: JSON.stringify('https://platform.test'),
    __TEST_HOOKS__: 'false',
    __FAKE_TRANSPORT__: 'false',
  },
  resolve: {
    alias: {
      'virtual:injected-source': fileURLToPath(new URL('./test/unit/stubs/injected-source.ts', import.meta.url)),
    },
  },
  test: {
    include: ['test/unit/**/*.test.ts'],
    environment: 'node',
  },
});
