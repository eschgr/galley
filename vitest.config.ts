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
      // Electron glue (main.ts, preload, menu.ts) is deferred to a later E2E
      // suite — neither is a unit-test target, so counting them would make the
      // number meaningless. The pure main-process helpers extracted OUT of main.ts
      // (the startupFiles.ts precedent, #44) ARE unit-test targets, so they belong
      // here. Extend this list as more pure utilities land.
      include: [
        'src/renderer/markdown/pipeline.ts',
        'src/renderer/components/scrollSync.ts',
        // Pure, Electron-free main-process helpers, each with a sibling *.test.ts.
        'src/main/keyCommand.ts',
        'src/main/sourceVisibleBounds.ts',
        'src/main/pendingQueue.ts',
        'src/main/startup.ts',
        'src/main/startupFiles.ts',
        'src/main/crashReload.ts',
        'src/main/pdfName.ts',
        'src/main/cliHelp.ts',
        'src/main/cliShim.ts',
        'src/main/debounce.ts',
        'src/main/projectArg.ts',
        'src/main/appVersion.ts',
      ],
    },
  },
});
