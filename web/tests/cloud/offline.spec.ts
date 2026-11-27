import { expect, test } from '@playwright/test';
import { go, liveRecords, logWorkout, makeAccount, newAddress, signIn, synced, watchPolicy } from './helpers';

// The service worker is what lets the app open at the gym with no signal. The
// other tests switch it off; here it runs, under the same headers as the rest.
test.use({ serviceWorkers: 'allow' });

test('opens signed in without a connection, logs, and sends when the connection returns', async ({ page, context, browserName }) => {
  test.skip(browserName !== 'chromium', "Playwright's WebKit can't take a page offline with a service worker in play");
  const refused = watchPolicy(page);
  const email = newAddress('gym');
  const uid = await makeAccount(email);
  await signIn(page, email);
  await logWorkout(page);
  await synced(page);
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
  });

  await context.setOffline(true);
  await page.reload();
  // Still signed in, with what was logged: nothing about opening needs the network.
  await expect(page.getByText(`Signed in as${email}`)).toBeVisible();
  await go(page, '/history');
  await expect(page.getByRole('main').getByRole('link', { name: /Bench Press/ })).toHaveCount(1);

  await logWorkout(page, 'squat', 'Squat (Barbell)');
  expect(await liveRecords(uid, 'workouts')).toHaveLength(1);

  await context.setOffline(false);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await liveRecords(uid, 'workouts')).length).toBe(2);
  expect(refused).toEqual([]);
});
