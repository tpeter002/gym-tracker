import { defineConfig, devices } from '@playwright/test';

const PORT = 4173;

// Runs the production build in two browsers: a desktop Chromium (sidebar
// layout) and an iPhone-sized WebKit, the engine behind Safari (tab bar layout).
export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  reporter: 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    // With a service worker in the way, the tests couldn't stand in for the analyzer.
    // offline.spec.ts turns it back on.
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    // See vite.config.ts: keeps a real analyzer on this machine out of the tests.
    env: { GYM_TRACKER_NO_ANALYZER_PROXY: '1' },
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
  ],
});
