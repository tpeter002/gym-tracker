import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { seed } from './helpers';

// Routines made on purpose: a finished workout saved under a name and started from the Workout tab.

const routines = (page: Page) => page.getByRole('region', { name: 'Routines' });
const menu = (page: Page, item: string | RegExp) => page.getByRole('menuitem', { name: item });

async function openWorkout(page: Page, name: RegExp, which: 'first' | 'last' = 'first'): Promise<void> {
  await page.goto('/#/history');
  await page.getByRole('main').getByRole('link', { name })[which]().click();
}

async function saveAsRoutine(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Workout options' }).click();
  await menu(page, 'Save as Routine…').click();
  const sheet = page.getByRole('dialog', { name: 'Save as Routine' });
  await sheet.getByLabel('Routine name').fill(name);
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet).toBeHidden();
}

test('a finished workout becomes a routine that starts from the Workout tab', async ({ page }) => {
  await seed(page);
  await page.goto('/#/');
  await expect(routines(page)).toHaveCount(0); // none until one is made

  await openWorkout(page, /Push/);
  // The sheet offers the workout's own name to begin with.
  await page.getByRole('button', { name: 'Workout options' }).click();
  await menu(page, 'Save as Routine…').click();
  const sheet = page.getByRole('dialog', { name: 'Save as Routine' });
  await expect(sheet.getByLabel('Routine name')).toHaveValue('Push');
  await sheet.getByLabel('Routine name').fill('Push A');
  await sheet.getByLabel('Routine name').press('Enter');
  await expect(page.getByText('Routine', { exact: true }).locator('..')).toContainText('Push A');

  await page.goto('/#/');
  const row = routines(page).getByRole('link', { name: /Push A/ });
  await expect(row).toContainText('3 exercises');
  await expect(row).toContainText('3 × Bench Press (Barbell)');

  // Start: the same exercises and sets, last time's numbers on offer, under the routine's name.
  await routines(page).getByRole('button', { name: 'Start Push A' }).click();
  await expect(page).toHaveURL(/#\/workout$/);
  await expect(page.getByLabel('Workout name')).toHaveValue('Push A');
  const bench = page.getByRole('region', { name: 'Bench Press (Barbell)' });
  await expect(bench.getByLabel('Weight')).toHaveCount(3);
  await expect(bench.getByRole('button', { name: /^Use last time's numbers: 87\.5 kg × 8/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Triceps Rope Pushdown (Cable)' })).toBeVisible();

  // It is kept: there after the app is opened again.
  await page.getByRole('button', { name: 'Discard Workout' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard Workout' }).click();
  await page.reload();
  await expect(routines(page).getByRole('link', { name: /Push A/ })).toBeVisible();
});

test('a routine can be renamed, brought up to date from a newer workout, and removed', async ({ page }) => {
  await seed(page);
  await openWorkout(page, /Legs/, 'last'); // the oldest leg day
  await saveAsRoutine(page, 'Leg day');

  // Renamed from the same workout.
  await page.getByRole('button', { name: 'Workout options' }).click();
  await expect(menu(page, 'Save as Routine…')).toHaveCount(0);
  await menu(page, 'Rename Routine…').click();
  const rename = page.getByRole('dialog', { name: 'Rename Routine' });
  await expect(rename.getByLabel('Routine name')).toHaveValue('Leg day');
  await rename.getByLabel('Routine name').fill('Legs A');
  await rename.getByRole('button', { name: 'Save' }).click();
  await page.goto('/#/');
  await expect(routines(page).getByRole('link')).toHaveText([/Legs A/]);

  // Saving the newest leg day under the same name moves the routine to it — after saying so.
  await openWorkout(page, /Legs/, 'first');
  const newest = page.url();
  await page.getByRole('button', { name: 'Workout options' }).click();
  await menu(page, 'Save as Routine…').click();
  const sheet = page.getByRole('dialog', { name: 'Save as Routine' });
  await sheet.getByLabel('Routine name').fill('legs a');
  await expect(sheet).toContainText(/“Legs A” is saved from your workout of .* Saving moves it to this one\./);
  await sheet.getByRole('button', { name: 'Save' }).click();
  await page.goto('/#/');
  await expect(routines(page).getByRole('link')).toHaveCount(1);
  await routines(page).getByRole('link', { name: /legs a/ }).click();
  expect(page.url()).toBe(newest);

  // Removed: the workout stays, the routine goes.
  await page.getByRole('button', { name: 'Workout options' }).click();
  await menu(page, 'Remove from Routines').click();
  await expect(page.getByText('Routine', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Legs', level: 1 })).toBeVisible();
  await page.goto('/#/');
  await expect(page.getByRole('region', { name: 'Recent' })).toBeVisible(); // the page is up; so the next line means "none"
  await expect(routines(page)).toHaveCount(0);
});

test('deleting a workout says when a routine goes with it', async ({ page }) => {
  await seed(page);
  await openWorkout(page, /Pull/);
  await saveAsRoutine(page, 'Pull day');

  await page.getByRole('button', { name: 'Workout options' }).click();
  await menu(page, 'Delete Workout').click();
  const question = page.getByRole('alertdialog', { name: 'Delete this workout?' });
  await expect(question).toContainText('The routine “Pull day” was saved from it and goes with it.');
  await question.getByRole('button', { name: 'Delete Workout' }).click();
  await page.goto('/#/');
  await expect(page.getByRole('region', { name: 'Recent' })).toBeVisible();
  await expect(routines(page)).toHaveCount(0);

  // A workout that is no routine is deleted without that remark.
  await openWorkout(page, /Push/);
  await page.getByRole('button', { name: 'Workout options' }).click();
  await menu(page, 'Delete Workout').click();
  await expect(page.getByRole('alertdialog', { name: 'Delete this workout?' })).not.toContainText('routine');
});
