import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { RANK_SETTLE_MS } from '../../src/lib/timing';
import { logAndFinishWorkout, mockConnections, seed } from './helpers';

// A finished workout opened again: a wrong number put right, an exercise taken
// out, its times changed — or the edit called off.
//
// The demo lifter's latest push day: bench press 87.5 kg × 8, 7, 6; overhead
// press 31.5 kg dumbbells; triceps pushdown 35 kg. The week before: bench 85 kg.

const bench = (page: Page) => page.getByRole('region', { name: 'Bench Press (Barbell)' });

async function openLatestPush(page: Page): Promise<void> {
  await page.goto('/#/history');
  await page.getByRole('main').getByRole('link', { name: /Push/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Push', level: 1 })).toBeVisible();
}

async function startEditing(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Workout options' }).click();
  await page.getByRole('menuitem', { name: 'Edit Workout' }).click();
  await expect(page.getByRole('heading', { name: 'Edit Workout', level: 1 })).toBeVisible();
}

test('a finished workout can be put right', async ({ page }) => {
  await seed(page);
  await openLatestPush(page);
  await startEditing(page);

  // As it was logged, every set ticked — and "previous" is the push day before this one, not this one.
  await expect(bench(page).getByLabel('Weight').first()).toHaveValue('87.5');
  await expect(bench(page).getByRole('button', { name: 'Mark set as not done' })).toHaveCount(3);
  await expect(bench(page).getByRole('button', { name: /^Use last time's numbers: 85 kg × 8/ })).toBeVisible();
  // It is not a workout in progress: nothing to minimise, discard or be offered.
  await expect(page.getByRole('button', { name: 'Minimize' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Discard Workout' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'To try today' })).toHaveCount(0);

  // A wrong number, a set that was forgotten, an exercise that wasn't done, a better name.
  await bench(page).getByLabel('Weight').first().fill('90');
  await bench(page).getByRole('button', { name: 'Add Set' }).click();
  await bench(page).getByLabel('Weight').nth(3).fill('80');
  await bench(page).getByLabel('Reps').nth(3).fill('10');
  await bench(page).getByRole('button', { name: 'Mark set as done' }).click();
  await page.getByRole('button', { name: 'Triceps Rope Pushdown (Cable) options' }).click();
  await page.getByRole('menuitem', { name: 'Remove Exercise' }).click();
  await page.getByLabel('Workout name').fill('Push A');
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // Back on the workout's page, which shows what was changed.
  await expect(page.getByRole('heading', { name: 'Push A', level: 1 })).toBeVisible();
  await expect(bench(page)).toContainText('90 kg × 8');
  await expect(bench(page)).toContainText('80 kg × 10');
  await expect(bench(page)).not.toContainText('87.5 kg × 8');
  await expect(page.getByRole('region', { name: 'Triceps Rope Pushdown (Cable)' })).toHaveCount(0);
  await expect(page.getByText('Sets', { exact: true }).locator('..')).toContainText('7');

  // It is still a finished workout of that day, and what is worked out from it follows.
  await page.reload();
  await expect(bench(page)).toContainText('90 kg × 8');
  await page.goto('/#/history');
  await expect(page.getByRole('main').getByRole('link', { name: /Push A/ })).toHaveCount(1);
  await page.getByRole('main').getByRole('link', { name: /Push A/ }).click();
  await page.getByRole('link', { name: 'Bench Press (Barbell)' }).click();
  await expect(page.getByText('Heaviest weight').locator('..')).toContainText('90 kg');
});

test('an edit can be called off, and everything is as it was', async ({ page }) => {
  await seed(page);
  await openLatestPush(page);
  await startEditing(page);

  await bench(page).getByLabel('Weight').first().fill('200');
  await page.getByRole('button', { name: 'Overhead Press (Dumbbell) options' }).click();
  await page.getByRole('menuitem', { name: 'Remove Exercise' }).click();
  await page.getByLabel('Workout name').fill('Never mind');
  await page.getByRole('button', { name: 'Cancel' }).click();

  await expect(page.getByRole('heading', { name: 'Push', level: 1 })).toBeVisible();
  await expect(bench(page)).toContainText('87.5 kg × 8');
  await expect(page.getByRole('region', { name: 'Overhead Press (Dumbbell)' })).toContainText('31.5 kg × 10');
  await page.reload();
  await expect(bench(page)).toContainText('87.5 kg × 8');
  await expect(page.getByRole('region', { name: 'Overhead Press (Dumbbell)' })).toBeVisible();
});

test('leaving an edit without pressing Done keeps the changes and drops what was not ticked', async ({ page }) => {
  await seed(page);
  await openLatestPush(page);
  await startEditing(page);

  await bench(page).getByLabel('Weight').first().fill('90');
  await bench(page).getByRole('button', { name: 'Add Set' }).click(); // left empty and unticked
  await bench(page).getByRole('button', { name: 'Mark set as not done' }).last().click(); // the third set, unticked
  await page.goBack();

  await expect(page.getByRole('heading', { name: 'Push', level: 1 })).toBeVisible();
  await expect(bench(page)).toContainText('90 kg × 8');
  await expect(bench(page)).toContainText('87.5 kg × 7');
  await expect(bench(page)).not.toContainText('87.5 kg × 6');
  await expect(page.getByText('Sets', { exact: true }).locator('..')).toContainText('8');
});

test('a workout cannot be saved with nothing left in it, and asks before dropping unticked sets', async ({ page }) => {
  await seed(page);
  await openLatestPush(page);
  await startEditing(page);

  // One set unticked: Done asks first.
  await bench(page).getByRole('button', { name: 'Mark set as not done' }).last().click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const question = page.getByRole('alertdialog', { name: 'Save the changes?' });
  await expect(question).toContainText("Sets you haven't ticked off will be removed.");
  await question.getByRole('button', { name: 'Keep Editing' }).click();

  // Everything unticked: there is nothing to save.
  for (let left = await page.getByRole('button', { name: 'Mark set as not done' }).count(); left > 0; left--) {
    await page.getByRole('button', { name: 'Mark set as not done' }).first().click();
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('alertdialog', { name: 'Nothing left in this workout' })).toBeVisible();
  await page.getByRole('alertdialog').getByRole('button', { name: 'OK' }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  await expect(bench(page)).toContainText('87.5 kg × 6'); // called off: all nine sets are back
});

test('its start can be moved and its end changed', async ({ page }) => {
  await seed(page);
  await openLatestPush(page);
  await expect(page.getByText('Duration').locator('..')).toContainText('1h 02m');
  await startEditing(page);

  // Another morning altogether: the workout moves there and keeps its hour and two minutes.
  await page.getByLabel('Started').fill('2026-03-01T07:30');
  await expect(page.getByLabel('Finished')).toHaveValue('2026-03-01T08:32');
  // It ended earlier than was logged.
  await page.getByLabel('Finished').fill('2026-03-01T08:00');
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  await expect(page.getByText('Date', { exact: true }).locator('..')).toContainText('1 Mar 2026');
  await expect(page.getByText('Date', { exact: true }).locator('..')).toContainText('07:30');
  await expect(page.getByText('Duration').locator('..')).toContainText('30m');
  // It has moved down the history to where that day belongs.
  await page.goto('/#/history');
  await expect(page.getByRole('region', { name: 'March 2026' }).getByRole('link', { name: /Push/ })).toHaveCount(1);
});

test('raising a lift in an old workout changes its rank quietly', async ({ page }) => {
  await seed(page);
  await page.goto('/#/ranks');
  await page.getByRole('radiogroup', { name: 'Strength standards' }).getByText('Men', { exact: true }).click();
  await openLatestPush(page);
  await expect(bench(page)).toContainText('Gold III');
  await startEditing(page);

  await bench(page).getByLabel('Weight').first().fill('120'); // 120 kg × 8: well into the next tiers
  await expect(bench(page).getByRole('img', { name: /Diamond/ })).toBeVisible();
  // Looked at once, after the moment a celebration would have appeared: correcting a number is not an achievement.
  await page.waitForTimeout(RANK_SETTLE_MS + 900);
  expect(await page.getByRole('status').filter({ hasText: /Rank up|First rank/ }).count()).toBe(0);

  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(bench(page)).toContainText('Diamond');
});

test('a workout that was already sent says that the copy there will not follow', async ({ page }) => {
  await mockConnections(page, { strava: true });
  await page.goto('/#/settings');
  await page.getByRole('region', { name: 'Strava' }).getByRole('switch', { name: 'Send finished workouts automatically' }).check();
  await logAndFinishWorkout(page);
  await page.getByRole('main').getByRole('link', { name: /Workout/ }).first().click();
  await expect(page.getByRole('region', { name: 'Sent to' }).getByRole('link', { name: 'Open on Strava' })).toBeVisible();

  await startEditing(page);
  await expect(page.getByText('Already sent to Strava: what you change here stays in this app.')).toBeVisible();
});
