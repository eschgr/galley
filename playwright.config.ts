import { defineConfig, devices } from '@playwright/test';

// Basic browser/behavior tests for the renderer (PRD R45/R18 view behaviour).
// They run against the real `npm run devapp` page in headless Chromium —
// Electron's renderer is Chromium, so this faithfully exercises the same UI.
// Electron-only behaviour (window auto-resize, native menu, openExternal) is a
// separate, later E2E suite.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5181',
    viewport: { width: 1200, height: 800 },
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'npm run devapp',
    url: 'http://localhost:5181',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
