import { expect, test } from '@playwright/test';
import { addExercise, seed } from './helpers';

// "Up next" on the home screen, and "To try today" inside a workout.
// The demo data is four weeks of push / pull / legs, legs most recently, with
// two shoulder exercises from a saved video waiting to be tried.

test('the routine that is due starts from the home screen and offers the exercises to try that fit it', async ({ page }) => {
  await seed(page);
  await page.goto('/#/');

  const next = page.getByRole('region', { name: 'Up next' });
  await expect(next.getByRole('heading', { name: 'Push' })).toBeVisible();
  await expect(next).toContainText('Last done 4 days ago');
  await expect(next).toContainText('3 × Bench Press (Barbell)');
  await expect(next).toContainText('2 to try: Face Pull (Cable), Reverse Fly (Cable)');

  await next.getByRole('button', { name: 'Start Push' }).click();
  await expect(page).toHaveURL(/#\/workout$/);
  await expect(page.getByRole('textbox', { name: 'Workout name' })).toHaveValue('Push');
  await expect(page.getByRole('region', { name: 'Overhead Press (Dumbbell)' })).toBeVisible();

  // Nothing was added behind your back: the two are offered, one tap each.
  const toTry = page.getByRole('region', { name: 'To try today' });
  await expect(toTry.getByText('Face Pull (Cable)')).toBeVisible();
  await expect(toTry.getByText('Reverse Fly (Cable)')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Face Pull (Cable)' })).toHaveCount(0);

  await toTry.getByRole('button', { name: 'Add Face Pull (Cable)' }).click();
  const facePull = page.getByRole('region', { name: 'Face Pull (Cable)' });
  await expect(facePull.getByLabel('Weight')).toHaveCount(3);
  await expect(toTry.getByText('Face Pull (Cable)')).toHaveCount(0);
  await expect(toTry.getByText('Reverse Fly (Cable)')).toBeVisible();

  // The offer goes away once everything in it is in the workout.
  await toTry.getByRole('button', { name: 'Add Reverse Fly (Cable)' }).click();
  await expect(toTry).toHaveCount(0);

  // Doing the exercise takes it off the to-try list, and the rotation moves on.
  await facePull.getByLabel('Weight').first().fill('20');
  await facePull.getByLabel('Reps').first().fill('12');
  await facePull.getByRole('button', { name: 'Mark set as done' }).first().click();
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('alertdialog', { name: 'Finish workout?' }).getByRole('button', { name: 'Finish' }).click();

  await page.goto('/#/');
  await expect(page.getByRole('region', { name: 'Up next' }).getByRole('heading', { name: 'Pull' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Up next' })).toContainText('Last done 2 days ago');
  const waiting = page.getByRole('region', { name: 'To try', exact: true });
  await expect(waiting.getByRole('link', { name: /Reverse Fly \(Cable\)/ })).toBeVisible();
  await expect(waiting.getByRole('link', { name: /Face Pull \(Cable\)/ })).toHaveCount(0);
});

test('a workout started empty is offered its to-try exercises once it trains the right muscle', async ({ page }) => {
  await seed(page);
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  const toTry = page.getByRole('region', { name: 'To try today' });
  await expect(page.getByRole('button', { name: 'Add Exercise' })).toBeVisible();
  await expect(toTry).toHaveCount(0);

  await addExercise(page, 'squat', 'Squat (Barbell)');
  await expect(page.getByRole('region', { name: 'Squat (Barbell)' })).toBeVisible();
  await expect(toTry).toHaveCount(0); // shoulder exercises don't belong on a leg day

  await addExercise(page, 'overhead press', 'Overhead Press (Dumbbell)');
  await expect(toTry.getByText('Face Pull (Cable)')).toBeVisible();
  await expect(toTry).toContainText('From your saved videos');
});

test('nothing is suggested without a routine, or while a workout is running', async ({ page }) => {
  await page.goto('/#/');
  await expect(page.getByRole('button', { name: 'Start Empty Workout' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Up next' })).toHaveCount(0);

  await seed(page);
  await page.goto('/#/');
  await expect(page.getByRole('region', { name: 'Up next' })).toBeVisible();

  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await expect(page).toHaveURL(/#\/workout$/);
  await page.goto('/#/');
  await expect(page.getByRole('button', { name: /Resume/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Up next' })).toHaveCount(0);
});
