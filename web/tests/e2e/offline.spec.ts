import { expect, test } from '@playwright/test';

// The service worker is what lets the app open at the gym with no signal.
test.use({ serviceWorkers: 'allow' });

test('opens and saves without a connection after the first visit', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', "Playwright's WebKit can't take a page offline with a service worker in play");

  await page.goto('/');
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Workout', level: 1 })).toBeVisible();

  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await page.getByLabel('Workout name').fill('Offline session');
  await page.reload();
  await expect(page.getByLabel('Workout name')).toHaveValue('Offline session');
});
