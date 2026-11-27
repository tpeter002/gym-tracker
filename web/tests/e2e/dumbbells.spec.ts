import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';
import { addExercise, seed } from './helpers';

// Dumbbell weights are typed in for one dumbbell or for the pair together; a
// button on each logged dumbbell exercise says which. And the top-set chart
// names the reps along with the weight.
//
// The demo lifter pressed 31.5 kg dumbbells overhead for 10, 9 and 8 last time,
// and 24, 26.5 and 29 kg in the three weeks before.

const PRESS = 'Overhead Press (Dumbbell)';
const toggle = (within: Page | Locator) => within.getByRole('button', { name: 'Both dumbbells together' });

async function startWorkoutWith(page: Page, search: string, name: string): Promise<Locator> {
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await addExercise(page, search, name);
  return page.getByRole('region', { name });
}

test('saying that the weights are both dumbbells turns last time around, and is remembered', async ({ page }) => {
  await seed(page);
  const press = await startWorkoutWith(page, 'overhead press', PRESS);

  // One dumbbell unless said otherwise, as it has always been.
  await expect(toggle(press)).toHaveAttribute('aria-pressed', 'false');
  await expect(toggle(press)).toHaveText('Per dumbbell');
  await expect(press.getByRole('button', { name: /^Use last time's numbers: 31\.5 kg × 10/ })).toBeVisible();

  await toggle(press).click();
  await expect(toggle(press)).toHaveAttribute('aria-pressed', 'true');
  await expect(toggle(press)).toHaveText('Both dumbbells');
  // Last time's 31.5 kg a side is 63 kg said this way — in the column, the hint, and what a tick takes over.
  await expect(press.getByRole('button', { name: /^Use last time's numbers: 63 kg × 10/ })).toBeVisible();
  await expect(press.getByLabel('Weight').first()).toHaveAttribute('placeholder', '63');
  await press.getByRole('button', { name: 'Mark set as done' }).first().click();
  await expect(press.getByLabel('Weight').first()).toHaveValue('63');

  // Only dumbbell exercises ask.
  await addExercise(page, 'bench press', 'Bench Press (Barbell)');
  await expect(toggle(page.getByRole('region', { name: 'Bench Press (Barbell)' }))).toHaveCount(0);

  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('alertdialog', { name: 'Finish workout?' }).getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('main').getByRole('link', { name: /Workout/ }).first().click();

  // The finished workout shows what was typed and how it was meant; its volume counts one dumbbell.
  const logged = page.getByRole('region', { name: PRESS });
  await expect(logged).toContainText('63 kg × 10');
  await expect(toggle(logged)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByText('Volume').locator('..')).toContainText('315 kg');

  // Next time the exercise starts out counted the same way.
  const again = await startWorkoutWith(page, 'overhead press', PRESS);
  await expect(toggle(again)).toHaveAttribute('aria-pressed', 'true');
  await expect(again.getByRole('button', { name: /^Use last time's numbers: 63 kg × 10/ })).toBeVisible();
  await toggle(again).click();
  await expect(again.getByRole('button', { name: /^Use last time's numbers: 31\.5 kg × 10/ })).toBeVisible();
});

test("an old session typed the other way can be put right on the exercise's page", async ({ page }) => {
  await seed(page);
  await page.goto('/#/exercises');
  await page.getByRole('searchbox').fill('overhead press dumbbell');
  await page.getByRole('link', { name: /^Overhead Press \(Dumbbell\)/ }).click();
  const main = page.getByRole('main');
  const heaviest = main.getByText('Heaviest weight').locator('..');
  const mixed = main.getByText(/Some sessions count one dumbbell; records and the chart show them as both dumbbells together/);

  await expect(heaviest).toContainText('31.5 kg');
  await expect(toggle(main)).toHaveCount(4); // one per session
  await expect(mixed).toHaveCount(0);

  // Say the latest session's 31.5 kg was the pair together: everything is then read as pairs,
  // and the 29 kg dumbbells of the week before — 58 kg together — become the heaviest.
  await toggle(main).first().click();
  await expect(toggle(main).first()).toHaveText('Both dumbbells');
  await expect(heaviest).toContainText('58 kg');
  await expect(mixed).toBeVisible();
  // The session itself still shows what was typed.
  await expect(main.getByRole('region').filter({ has: toggle(page).and(page.locator('[aria-pressed="true"]')) })).toContainText('31.5 kg × 10');

  // It is kept.
  await page.reload();
  await expect(toggle(main).first()).toHaveAttribute('aria-pressed', 'true');
  await expect(heaviest).toContainText('58 kg');

  await toggle(main).first().click();
  await expect(heaviest).toContainText('31.5 kg');
  await expect(mixed).toHaveCount(0);
});

test('the top-set chart names the reps with the weight', async ({ page }) => {
  await seed(page);
  await page.goto('/#/exercises');
  await page.getByRole('searchbox').fill('bench press barbell');
  await page.getByRole('link', { name: /^Bench Press \(Barbell\)/ }).click();

  const chart = page.getByRole('main').getByRole('group', {
    name: /^Heaviest set of Bench Press \(Barbell\) per session: 80 kg × 8 on .* to 87\.5 kg × 8 on /,
  });
  await expect(chart).toBeVisible();
  await chart.focus();
  await expect(chart.locator('.chart-tip')).toContainText('87.5 kg × 8');
  await chart.press('ArrowLeft');
  await expect(chart.locator('.chart-tip')).toContainText('85 kg × 8');
});

test('with two sets at the top weight, the chart shows the one with more reps', async ({ page }) => {
  await seed(page);
  const bench = await startWorkoutWith(page, 'bench press', 'Bench Press (Barbell)');
  for (const [row, reps] of [[0, '3'], [1, '6'], [2, '5']] as const) {
    await bench.getByLabel('Weight').nth(row).fill('90');
    await bench.getByLabel('Reps').nth(row).fill(reps);
    await bench.getByRole('button', { name: 'Mark set as done' }).first().click();
  }
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.goto('/#/exercises');
  await page.getByRole('searchbox').fill('bench press barbell');
  await page.getByRole('link', { name: /^Bench Press \(Barbell\)/ }).click();

  const chart = page.getByRole('main').getByRole('group', { name: /^Heaviest set of Bench Press \(Barbell\) per session/ });
  await chart.focus();
  await expect(chart.locator('.chart-tip')).toContainText('90 kg × 6');
});
