import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { logAndFinishWorkout, mockConnections, seed } from './helpers';

// Settings → Strava / Garmin Connect, and what happens to a workout when it is finished.

const autoSend = (page: Page, service: 'Strava' | 'Garmin Connect') =>
  page.getByRole('region', { name: service }).getByRole('switch', { name: 'Send finished workouts automatically' });

/** Opens the newest workout from History. */
async function openLatestWorkout(page: Page): Promise<void> {
  await page.goto('/#/history');
  await page.getByRole('main').getByRole('link', { name: /Workout/ }).first().click();
  await expect(page.getByRole('button', { name: 'Repeat Workout' })).toBeVisible();
}

test('a finished workout goes to the service that is switched on, and shows where it went', async ({ page }) => {
  const mock = await mockConnections(page, { strava: true, garmin: true });
  await page.goto('/#/settings');
  const strava = page.getByRole('region', { name: 'Strava' });
  await expect(strava).toContainText('Sam Lifter');
  await expect(autoSend(page, 'Strava')).not.toBeChecked(); // nothing is sent anywhere until asked
  await expect(autoSend(page, 'Garmin Connect')).not.toBeChecked();
  await autoSend(page, 'Strava').check();

  await logAndFinishWorkout(page);
  await expect.poll(() => mock.exports.length).toBe(1);
  const { target, body } = mock.exports[0];
  expect(target).toBe('strava');
  expect(body).toMatchObject({ unit: 'kg', effort: 'rpe' });
  expect(body.workout.exercises).toEqual([
    { name: 'Bench Press (Barbell)', muscle: 'chest', sets: [{ weight: 80, reps: 8, rpe: null, warmup: false }] },
  ]);

  await openLatestWorkout(page);
  const sentTo = page.getByRole('region', { name: 'Sent to' });
  await expect(sentTo).toContainText('Sent');
  await expect(sentTo.getByRole('link', { name: 'Open on Strava' })).toHaveAttribute('href', 'https://example.org/strava/activity/1');

  // Garmin is connected but not automatic: it can be sent by hand.
  await sentTo.getByRole('button', { name: 'Send to Garmin Connect' }).click();
  await expect(sentTo.getByRole('link', { name: 'Open on Garmin Connect' })).toHaveAttribute('href', 'https://example.org/garmin/activity/2');
  expect(mock.exports.map((item) => item.target)).toEqual(['strava', 'garmin']);
  expect(mock.exports[1].body.workout.id).toBe(body.workout.id);

  // It stays that way after the app is opened again, and nothing is sent a second time.
  await page.reload();
  await expect(page.getByRole('region', { name: 'Sent to' }).getByRole('link', { name: 'Open on Strava' })).toBeVisible();
  await page.goto('/#/');
  await page.goto('/#/history');
  await page.waitForLoadState('networkidle'); // whatever it was going to send, it has sent by now
  expect(mock.exports).toHaveLength(2);
});

test('with the analyzer out of reach a workout waits, and goes out when it is back', async ({ page }) => {
  const mock = await mockConnections(page, { strava: true });
  await page.goto('/#/settings');
  await autoSend(page, 'Strava').check();

  mock.online = false; // at the gym, away from the Mac
  await logAndFinishWorkout(page);
  await openLatestWorkout(page);
  await expect(page.getByRole('region', { name: 'Sent to' })).toContainText('Waiting to be sent');
  expect(mock.attempts).toEqual([]); // it doesn't even try: the analyzer's /health goes unanswered first

  mock.online = true; // home again: opening the app is enough
  await page.reload();
  await expect(page.getByRole('region', { name: 'Sent to' }).getByRole('link', { name: 'Open on Strava' })).toBeVisible();
  expect(mock.exports).toHaveLength(1);
});

test('a refusal is shown with its reason and can be tried again', async ({ page }) => {
  const mock = await mockConnections(page, { strava: true });
  mock.answers.strava = { status: 422, json: { detail: "Strava didn't take the workout (400) (Bad Request)" } };
  await page.goto('/#/settings');
  await autoSend(page, 'Strava').check();
  await logAndFinishWorkout(page);
  await openLatestWorkout(page);

  const sentTo = page.getByRole('region', { name: 'Sent to' });
  await expect(sentTo).toContainText('Not sent');
  await expect(sentTo).toContainText("Strava: Strava didn't take the workout (400) (Bad Request)");
  await page.reload(); // a refused workout is not retried by itself
  await expect(page.getByRole('region', { name: 'Sent to' })).toContainText('Not sent');
  await page.waitForLoadState('networkidle');
  expect(mock.attempts).toHaveLength(1);

  delete mock.answers.strava;
  await page.getByRole('region', { name: 'Sent to' }).getByRole('button', { name: 'Try Again' }).click();
  await expect(page.getByRole('region', { name: 'Sent to' }).getByRole('link', { name: 'Open on Strava' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Sent to' })).not.toContainText("didn't take");
});

test('workouts from before are never sent by themselves', async ({ page }) => {
  const mock = await mockConnections(page, { strava: true, garmin: true });
  await page.goto('/#/settings');
  await autoSend(page, 'Strava').check();
  await autoSend(page, 'Garmin Connect').check();
  await seed(page); // twelve workouts arrive from a backup, as they would from a Strong import

  await page.goto('/#/');
  await page.goto('/#/history');
  await page.getByRole('main').getByRole('link', { name: /Legs/ }).first().click();
  // Each can still be sent on request.
  await expect(page.getByRole('region', { name: 'Sent to' }).getByRole('button', { name: 'Send to Strava' })).toBeVisible();
  expect(mock.exports).toHaveLength(0);
});

test('nothing is sent while automatic sending is off', async ({ page }) => {
  const mock = await mockConnections(page, { strava: true });
  await logAndFinishWorkout(page);
  await openLatestWorkout(page);
  await expect(page.getByRole('region', { name: 'Sent to' }).getByRole('button', { name: 'Send to Strava' })).toBeVisible();
  expect(mock.exports).toHaveLength(0);
});

test('connecting Garmin takes the password once, and a code when Garmin asks for one', async ({ page }) => {
  const mock = await mockConnections(page);
  mock.garminNeedsCode = true;
  await page.goto('/#/settings');
  const garmin = page.getByRole('region', { name: 'Garmin Connect' });
  await expect(garmin).toContainText('unofficial');
  const connect = garmin.getByRole('button', { name: 'Connect Garmin' });
  await expect(connect).toBeDisabled();

  await garmin.getByLabel('Garmin email').fill('sam@example.org');
  await garmin.getByLabel('Garmin password').fill('wrong');
  await connect.click();
  await expect(garmin).toContainText("Garmin didn't accept the login (Invalid credentials).");

  await garmin.getByLabel('Garmin password').fill('correct-horse');
  await connect.click();
  await expect(garmin).toContainText('Garmin sent a verification code');
  await garmin.getByLabel('Verification code').fill('123456');
  await garmin.getByRole('button', { name: 'Finish Connecting' }).click();

  await expect(garmin).toContainText('Sam Lifter');
  await expect(garmin).toContainText('Garmin Connect is connected.');
  await expect(garmin.getByLabel('Garmin password')).toHaveCount(0);
  await expect(autoSend(page, 'Garmin Connect')).not.toBeChecked();
  expect(mock.garminLogins).toEqual([
    { email: 'sam@example.org', password: 'wrong' },
    { email: 'sam@example.org', password: 'correct-horse' },
    { mfa_code: '123456' },
  ]);
  // The password is nowhere in what the app keeps.
  const stored = await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve) => {
      const request = indexedDB.open('gym-tracker');
      request.onsuccess = () => resolve(request.result);
    });
    const settings = await new Promise((resolve) => {
      const request = database.transaction('meta').objectStore('meta').get('settings');
      request.onsuccess = () => resolve(request.result);
    });
    return JSON.stringify(settings) + JSON.stringify({ ...localStorage });
  });
  expect(stored).not.toContain('correct-horse');

  await garmin.getByRole('button', { name: 'Disconnect Garmin' }).click();
  await expect(garmin.getByRole('button', { name: 'Connect Garmin' })).toBeVisible();
});

test('connecting Strava leaves for Strava and comes back with the outcome', async ({ page, baseURL }) => {
  const mock = await mockConnections(page);
  await page.goto('/#/settings');
  const strava = page.getByRole('region', { name: 'Strava' });
  const link = strava.getByRole('link', { name: 'Connect Strava' });
  await expect(link).toHaveAttribute('href', `${baseURL}/strava/connect?back=%2F%23%2Fsettings`);

  // Back from Strava having said no…
  await page.goto('/?strava=denied#/settings');
  await expect(page.getByRole('region', { name: 'Strava' })).toContainText("Strava wasn't connected: the request was declined.");
  await expect(page).toHaveURL(`${baseURL}/#/settings`); // the marker is gone, so a reload doesn't repeat the message

  // …and having said yes.
  mock.services.strava = { configured: true, connected: true, account: 'Sam Lifter' };
  await page.goto('/?strava=connected#/settings');
  await expect(page.getByRole('region', { name: 'Strava' })).toContainText('Strava is connected.');
  await expect(page.getByRole('region', { name: 'Strava' })).toContainText('Sam Lifter');
  await expect(page).toHaveURL(`${baseURL}/#/settings`);

  await page.getByRole('region', { name: 'Strava' }).getByRole('button', { name: 'Disconnect Strava' }).click();
  await expect(page.getByRole('region', { name: 'Strava' }).getByRole('link', { name: 'Connect Strava' })).toBeVisible();
});

test('says what is missing when Strava is not set up, or the analyzer is not there', async ({ page }) => {
  const mock = await mockConnections(page, { stravaConfigured: false });
  await page.goto('/#/settings');
  const strava = page.getByRole('region', { name: 'Strava' });
  await expect(strava).toContainText('Not available');
  await expect(strava).toContainText('STRAVA_CLIENT_ID');
  await expect(strava.getByRole('link', { name: 'Connect Strava' })).toHaveCount(0);

  mock.online = false;
  await page.reload();
  await expect(page.getByRole('region', { name: 'Connections' })).toContainText("The analyzer isn't reachable");
  await expect(page.getByRole('region', { name: 'Strava' })).toHaveCount(0);
});
