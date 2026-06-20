import { defineConfig } from 'vitest/config';

// Unit tests only (pure logic — markdown pipeline, scroll-sync math). Node
// environment; no DOM. Browser behavior is covered separately by Playwright
// (tests/e2e), which Vitest must not pick up.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['tests/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'text-summary'],
      // Scope coverage to the pure logic the UNIT tests own. The React view
      // layer (App/Editor/Preview/SplitView) is covered by Playwright, and the
      // main process (main/preload/menu) is deferred to a later Electron E2E
      // suite — neither is a unit-test target, so counting them here would make
      // the number meaningless. Extend this list as more pure utilities land.
      include: [
        'src/renderer/markdown/pipeline.ts',
        'src/renderer/components/scrollSync.ts',
      ],
    },
  },
});
