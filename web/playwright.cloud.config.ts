import { defineConfig, devices } from '@playwright/test';

// The version with accounts, against the Firebase emulators. Not run on its
// own: `npm run test:e2e` in ../cloud builds the app, starts the emulators
// (which also serve it, with the headers the real host sends) and runs this.
export default defineConfig({
  testDir: 'tests/cloud',
  fullyParallel: true,
  // Every step here is a round trip to an emulator, and the emulators share this
  // computer with the browsers: fewer at once, and more patience than a page alone
  // needs. Freshly started, the Firestore emulator takes eight seconds and more
  // over a new account's first two hundred records; warmed up, one.
  workers: 3,
  timeout: 90_000,
  expect: { timeout: 30_000 },
  // For the emulators' and WebKit's own hiccups (a first page load cancelled, say).
  // A test that needed its second try is listed as flaky in the summary: look at it.
  retries: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:5055',
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'iphone', use: { ...devices['iPhone 15'] } },
  ],
});
