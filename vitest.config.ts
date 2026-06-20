import { defineConfig } from 'vitest/config';

// Unit tests only (pure logic — markdown pipeline, scroll-sync math). Node
// environment; no DOM. Browser behavior is covered separately by Playwright
// (tests/e2e), which Vitest must not pick up.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['tests/**', 'node_modules/**'],
  },
});
