import { expect, test } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { exportBackup } from '../../src/lib/backup';
import { emptyState } from '../../src/lib/types';
import type { AppState } from '../../src/lib/types';
import { addExercise, demoBackup } from '../e2e/helpers';
import { comeBack, go, liveRecords, logWorkout, makeAccount, newAddress, recordsOf, restore, signIn, signOut, synced } from './helpers';

// One account on several devices, and several accounts side by side, against
// the Firebase emulators with the real rules.

/** Another device: a browser of its own, with nothing in it. */
async function anotherDevice(browser: Browser, email: string): Promise<Page> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await signIn(page, email);
  return page;
}

const historyLinks = (page: Page) => page.getByRole('main').getByRole('link');

/** A backup with one exercise and `count` finished workouts — small, so that the workouts are most of it. */
function smallBackup(count: number): string {
  const state: AppState = emptyState();
  state.libraryVersion = 1_000; // the built-in list counts as added: it is not wanted here
  state.exercises.push({ id: 'ex1', name: 'Bench Press (Barbell)', muscle: 'chest', equipment: 'barbell', isCustom: false, notes: '', videoURL: null, videoId: null, wantToTry: false, createdAt: 1 });
  for (let index = 0; index < count; index++) {
    const start = Date.now() - (index + 1) * 86_400_000;
    state.workouts.push({
      id: `w${index}`, name: `Workout ${index + 1}`, startedAt: start, endedAt: start + 3_600_000, notes: '',
      entries: [{ id: `e${index}`, exerciseId: 'ex1', exerciseName: 'Bench Press (Barbell)', notes: '', sets: [{ id: `s${index}`, weight: 80, reps: 8, rpe: null, isWarmup: false, isDone: true }] }],
    });
  }
  return exportBackup(state);
}

test('a workout logged on one device is on the other, and a deletion travels back', async ({ page, browser }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await logWorkout(page);
  await synced(page);
  const stored = await liveRecords(uid, 'workouts');
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ entries: [{ exerciseName: 'Bench Press (Barbell)', sets: [{ weight: 60, reps: 5 }] }] });

  const laptop = await anotherDevice(browser, email);
  await go(laptop, '/history');
  await expect(historyLinks(laptop)).toHaveCount(1);
  await historyLinks(laptop).first().click();
  await expect(laptop.getByText('60 kg × 5')).toBeVisible();

  // Deleted on the laptop; the phone hears of it when it next comes to the front.
  await laptop.getByRole('button', { name: 'Workout options' }).click();
  await laptop.getByRole('menuitem', { name: 'Delete Workout' }).click();
  await laptop.getByRole('alertdialog').getByRole('button', { name: 'Delete Workout' }).click();
  await synced(laptop);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(0);

  await go(page, '/history');
  await comeBack(page);
  await expect(page.getByRole('heading', { name: 'No Workouts Yet' })).toBeVisible();
  await laptop.context().close();
});

test('a setting changed on one device follows to the other, but nothing that belongs to one browser does', async ({ page, browser }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await go(page, '/settings');
  await page.getByRole('radiogroup', { name: 'Weight unit' }).getByText('lb').click();
  await page.getByLabel('Analyzer address').fill('https://analyzer.invalid');
  await synced(page);

  const settings = (await recordsOf(uid)).find((item) => item.key === 'settings_app')!.record!;
  expect(settings.unit).toBe('lb');
  // The inbox code this browser made for itself, the place for API keys, and the
  // address those keys are sent to all stayed behind.
  expect(Object.keys(settings)).not.toContain('shareCode');
  expect(Object.keys(settings)).not.toContain('apiKeys');
  expect(JSON.stringify(await recordsOf(uid))).not.toContain('analyzer.invalid');

  const laptop = await anotherDevice(browser, email);
  await go(laptop, '/settings');
  await expect(laptop.getByRole('radiogroup', { name: 'Weight unit' }).getByRole('radio', { name: 'lb' })).toBeChecked();
  await expect(laptop.getByLabel('Analyzer address')).toHaveValue('');
  await laptop.context().close();
});

test('a workout in progress stays on its device until it is finished', async ({ page, browser }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await addExercise(page, 'bench press', 'Bench Press (Barbell)');
  const bench = page.getByRole('region', { name: 'Bench Press (Barbell)' });
  await bench.getByLabel('Weight').first().fill('80');
  await bench.getByLabel('Reps').first().fill('8');
  await bench.getByRole('button', { name: 'Mark set as done' }).first().click();
  await synced(page);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(0);

  const laptop = await anotherDevice(browser, email);
  await expect(laptop.getByRole('button', { name: 'Start Empty Workout' })).toBeVisible();
  await expect(laptop.getByText('Resume')).toHaveCount(0);

  await go(page, '/workout');
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('alertdialog', { name: 'Finish workout?' }).getByRole('button', { name: 'Finish' }).click();
  await expect.poll(async () => (await liveRecords(uid, 'workouts')).length).toBe(1);
  await go(laptop, '/history');
  await comeBack(laptop);
  await expect(historyLinks(laptop)).toHaveCount(1);
  await laptop.context().close();
});

test("two people on the same site never see each other's data", async ({ page, browser }) => {
  const first = newAddress('first');
  const second = newAddress('second');
  const firstId = await makeAccount(first);
  const secondId = await makeAccount(second);
  await signIn(page, first);
  await logWorkout(page);
  await synced(page);

  const other = await anotherDevice(browser, second);
  await go(other, '/history');
  await expect(other.getByRole('heading', { name: 'No Workouts Yet' })).toBeVisible();
  await synced(other);
  expect(await liveRecords(firstId, 'workouts')).toHaveLength(1);
  expect(await liveRecords(secondId, 'workouts')).toHaveLength(0);
  await other.context().close();

  // The same browser, the next person: the first one's data is not left behind for them.
  await signOut(page);
  await signIn(page, second);
  await go(page, '/history');
  await expect(page.getByRole('heading', { name: 'No Workouts Yet' })).toBeVisible();
});

test('what is logged without a connection is sent when it returns', async ({ page }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await synced(page);

  await page.route(/localhost:8089/, (route) => route.abort());
  await logWorkout(page);
  await go(page, '/settings');
  await page.getByRole('button', { name: /Sync Now/ }).click();
  await expect(page.getByText("Couldn't reach the server. What you log is kept on this device")).toBeVisible();
  expect(await liveRecords(uid, 'workouts')).toHaveLength(0);

  // Closed and opened again with still no connection: the app opens, and the workout is there.
  await page.reload();
  await go(page, '/history');
  await expect(historyLinks(page)).toHaveCount(1);

  await page.unroute(/localhost:8089/);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect.poll(async () => (await liveRecords(uid, 'workouts')).length).toBe(1);
});

test('restoring a backup replaces the account on every device', async ({ page, browser }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  const laptop = await anotherDevice(browser, email);

  await restore(page, demoBackup(), 'Restored 12 workouts from the backup.');
  await synced(page);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(12);
  await expect(page.getByText('no longer on this device')).toHaveCount(0); // it was asked for; no second question

  await go(laptop, '/history');
  await comeBack(laptop);
  await expect(historyLinks(laptop)).toHaveCount(12);
  await laptop.context().close();
});

test('records that vanish from a device are not removed from the account without a yes', async ({ page }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await restore(page, smallBackup(30), 'Restored 30 workouts from the backup.');
  await synced(page);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(30);

  // Something empties the device's workouts behind the app's back — a fault, not a decision.
  await page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('workouts', 'readwrite');
      tx.objectStore('workouts').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  }, `gym-tracker-${uid}`);
  await go(page, '/history');
  await page.reload();
  await expect(page.getByRole('heading', { name: 'No Workouts Yet' })).toBeVisible();

  // Syncing stops and asks, here and under Settings; the account still has them all.
  await expect(page.getByRole('alert').filter({ hasText: '30 items your account holds are no longer on this device' })).toBeVisible();
  expect(await liveRecords(uid, 'workouts')).toHaveLength(30);
  await page.getByRole('link', { name: 'Open Settings' }).click();
  await expect(page.getByText('30 items that your account holds are no longer on this device')).toBeVisible();

  await page.getByRole('button', { name: 'Bring Them Back' }).click();
  await expect(page.getByRole('button', { name: /Sync Now/ })).toContainText('Up to date');
  await go(page, '/history');
  await expect(historyLinks(page)).toHaveCount(30);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(30);
});

test('saying yes removes them from the account', async ({ page }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await restore(page, smallBackup(30), 'Restored 30 workouts from the backup.');
  await synced(page);

  await page.evaluate(async (name) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('workouts', 'readwrite');
      tx.objectStore('workouts').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  }, `gym-tracker-${uid}`);
  await go(page, '/settings');
  await page.reload();
  await page.getByRole('button', { name: 'Remove From Account' }).click();
  await expect(page.getByRole('button', { name: /Sync Now/ })).toContainText('Up to date');
  expect(await liveRecords(uid, 'workouts')).toHaveLength(0);
  expect((await recordsOf(uid)).filter((item) => item.kind === 'workouts' && item.deleted)).toHaveLength(30);
});
