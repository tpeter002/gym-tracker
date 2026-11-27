import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addExercise, seed } from './helpers';

// Ranks: every lift's standing against strength standards, the overall rank,
// and the celebration when a set in the running workout lifts one.
//
// The demo lifter weighs 82.92 kg at the latest weigh-in and has benched
// 87.5 kg × 8 (an estimated 110.8 kg, which is Gold III by the men's standards).

const standards = (page: Page) => page.getByRole('radiogroup', { name: 'Strength standards' });
const choose = (page: Page, option: 'Off' | 'Men' | 'Women') => standards(page).getByText(option, { exact: true }).click();
const overall = (page: Page) => page.getByRole('region', { name: 'Overall rank' });
const lifts = (page: Page) => page.getByRole('region', { name: 'Lifts' });
const rankUp = (page: Page) => page.getByRole('status').filter({ hasText: /Rank up|First rank/ });

/** Demo history with the men's standards switched on; ends on the Ranks page. */
async function seedRanked(page: Page): Promise<void> {
  await seed(page);
  await page.goto('/#/ranks');
  await choose(page, 'Men');
  await expect(overall(page)).toBeVisible();
}

/**
 * Nothing is being celebrated a moment after the last change. Looked at once,
 * on purpose: an assertion that waits would pass as soon as a celebration that
 * shouldn't have happened went away by itself.
 */
async function expectNoRankUp(page: Page): Promise<void> {
  await page.waitForTimeout(1500);
  expect(await rankUp(page).count()).toBe(0);
}

async function logSet(page: Page, exercise: string, weight: string, reps: string, row = 0): Promise<void> {
  const section = page.getByRole('region', { name: exercise });
  await section.getByLabel('Weight').nth(row).fill(weight);
  await section.getByLabel('Reps').nth(row).fill(reps);
  await section.getByRole('button', { name: 'Mark set as done' }).first().click();
}

test('a lift that could be ranked says what is missing, once ranks are on', async ({ page }) => {
  // History without a single weigh-in: restore the demo data, then delete every body-weight entry.
  await seed(page);
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gym-tracker');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('bodyWeights', 'readwrite');
      tx.objectStore('bodyWeights').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });
  await page.goto('/#/ranks');
  await page.reload();
  await choose(page, 'Men');
  await expect(page.getByText(/Log your body weight to see yours\./)).toBeVisible();

  await page.goto('/#/exercises');
  await page.getByRole('searchbox').fill('bench press barbell');
  await page.getByRole('link', { name: /^Bench Press \(Barbell\)/ }).click();
  await expect(page.getByRole('region', { name: 'Rank' }).getByRole('link')).toHaveText(/Log your body weight to see where this lift stands/);
});

test('nothing is ranked until standards are chosen and a body weight is logged', async ({ page }) => {
  await page.goto('/#/');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Ranks' }).click();
  await expect(page.getByRole('heading', { name: 'Ranks', level: 1 })).toBeVisible();

  await expect(page.getByText(/Choose the standards to measure against to see yours\./)).toBeVisible();
  await expect(standards(page).getByRole('radio', { name: 'Off' })).toBeChecked();
  await expect(overall(page)).toHaveCount(0);
  // The ladder is there to look at from the start.
  await expect(page.getByRole('region', { name: 'The ladder' })).toContainText('IronBronzeSilverGoldPlatinumDiamondLegend');

  await choose(page, 'Men');
  await expect(page.getByText(/Log your body weight to see yours\./)).toBeVisible();

  await page.getByRole('link', { name: /Body weight\s*Log it/ }).click();
  await page.getByRole('button', { name: 'Log Weight', exact: true }).click();
  await page.getByLabel('Body weight').fill('80');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.goBack();

  await expect(page.getByRole('link', { name: /Body weight\s*80 kg/ })).toBeVisible();
  await expect(page.getByText(/Nothing is ranked yet\./)).toBeVisible();
  await expect(overall(page)).toHaveCount(0);
});

test('every ranked lift is listed strongest first under an overall rank', async ({ page }) => {
  await seedRanked(page);

  await expect(lifts(page).getByRole('link')).toHaveCount(9);
  await expect(lifts(page).getByRole('link').first()).toContainText('Overhead Press (Dumbbell)');
  const bench = lifts(page).getByRole('link', { name: /Bench Press \(Barbell\)/ });
  await expect(bench).toContainText('Gold III · Est. 1RM 110.8 kg');
  await expect(bench).toContainText('116.5 kg for Platinum I');
  const pullUp = lifts(page).getByRole('link', { name: /Pull Up/ });
  await expect(pullUp).toContainText('Silver I · Best set 9 reps');
  await expect(pullUp).toContainText('10 reps for Silver II');

  // Best push, pull and leg lift, and their average.
  await expect(overall(page)).toContainText('Gold III');
  await expect(overall(page).getByRole('link', { name: /Push/ })).toContainText('Overhead Press (Dumbbell)');
  await expect(overall(page).getByRole('link', { name: /Pull/ })).toContainText('Bent Over Row (Barbell)');
  await expect(overall(page).getByRole('link', { name: /Legs/ })).toContainText('Romanian Deadlift (Barbell)');

  // A lift opens its exercise page, which shows the same rank.
  await bench.click();
  await expect(page.getByRole('heading', { name: 'Bench Press (Barbell)', level: 1 })).toBeVisible();
  const rank = page.getByRole('region', { name: 'Rank' });
  await expect(rank.getByRole('link', { name: /^Gold III/ })).toBeVisible();
  await expect(rank).toContainText('116.5 kg for Platinum I');
});

test("the same lifts stand higher against the women's standards, and Off hides ranks everywhere", async ({ page }) => {
  await seedRanked(page);
  await expect(lifts(page).getByRole('link', { name: /Bench Press \(Barbell\)/ })).toContainText('Gold III');

  await choose(page, 'Women');
  await expect(lifts(page).getByRole('link', { name: /Bench Press \(Barbell\)/ })).toContainText('Diamond III');

  // The choice is a setting like any other: there after a reload, and under Settings too.
  await page.reload();
  await expect(standards(page).getByRole('radio', { name: 'Women' })).toBeChecked();
  await page.goto('/#/settings');
  await expect(standards(page).getByRole('radio', { name: 'Women' })).toBeChecked();

  await choose(page, 'Off');
  await page.goto('/#/ranks');
  await expect(overall(page)).toHaveCount(0);
  await expect(lifts(page)).toHaveCount(0);
  await page.goto('/#/exercises');
  await page.getByRole('searchbox').fill('bench press');
  await expect(page.getByRole('link', { name: /^Bench Press \(Barbell\)/ })).toBeVisible();
  await expect(page.getByRole('img', { name: /Gold|Diamond/ })).toHaveCount(0);
  // Nor does the exercise's own page bring them up.
  await page.getByRole('link', { name: /^Bench Press \(Barbell\)/ }).click();
  await expect(page.getByText('Estimated 1RM')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Rank' })).toHaveCount(0);
});

test('the exercise list marks ranked lifts, and only those', async ({ page }) => {
  await seedRanked(page);
  await page.goto('/#/exercises');
  await page.getByRole('searchbox').fill('bench press');

  await expect(page.getByRole('link', { name: /^Bench Press \(Barbell\)/ }).getByRole('img', { name: 'Gold III' })).toBeVisible();
  // Never done, so no rank.
  await expect(page.getByRole('link', { name: /^Incline Bench Press \(Barbell\)/ }).getByRole('img')).toHaveCount(0);

  await page.getByRole('link', { name: /^Incline Bench Press \(Barbell\)/ }).click();
  await expect(page.getByRole('heading', { name: 'Incline Bench Press (Barbell)', level: 1 })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Rank' })).toHaveCount(0);
});

test('a set that lifts a rank is celebrated once, and the badge follows', async ({ page }) => {
  await seedRanked(page);
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await addExercise(page, 'bench press', 'Bench Press (Barbell)');
  const bench = page.getByRole('region', { name: 'Bench Press (Barbell)' });
  // The rank it starts from, before anything is ticked.
  await expect(bench.getByRole('img', { name: 'Gold III' })).toBeVisible();
  await expectNoRankUp(page); // what already stood is not news

  // 120 kg × 5 is an estimated 140 kg: Platinum III.
  await logSet(page, 'Bench Press (Barbell)', '120', '5');
  await expect(rankUp(page)).toBeVisible();
  await expect(rankUp(page)).toContainText('Rank up');
  await expect(rankUp(page)).toContainText('Platinum III');
  await expect(rankUp(page)).toContainText('Bench Press (Barbell)');
  await expect(bench.getByRole('img', { name: 'Platinum III' })).toBeVisible();

  // It leaves by itself.
  await expect(rankUp(page)).toHaveCount(0, { timeout: 8000 });

  // Unticking and ticking the same set again is not a second climb…
  await bench.getByRole('button', { name: 'Mark set as not done' }).click();
  await expect(bench.getByRole('img', { name: 'Gold III' })).toBeVisible();
  await page.waitForTimeout(1000); // long enough for the lower rank to have settled
  await bench.getByRole('button', { name: 'Mark set as done' }).first().click();
  await expect(bench.getByRole('img', { name: 'Platinum III' })).toBeVisible();
  // …and neither is a set that changes nothing.
  await logSet(page, 'Bench Press (Barbell)', '87.5', '7', 1);
  await expectNoRankUp(page);

  // A lift done for the first time gets its first rank.
  await addExercise(page, 'incline bench', 'Incline Bench Press (Barbell)');
  await logSet(page, 'Incline Bench Press (Barbell)', '60', '5');
  await expect(rankUp(page)).toContainText('First rank');
  await expect(rankUp(page)).toContainText('Incline Bench Press (Barbell)');
  // A tap sends it away.
  await rankUp(page).click();
  await expect(rankUp(page)).toHaveCount(0);

  // Once finished, the new rank is the lift's rank.
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('alertdialog', { name: 'Finish workout?' }).getByRole('button', { name: 'Finish' }).click();
  await page.goto('/#/ranks');
  await expect(lifts(page).getByRole('link', { name: /^Bench Press \(Barbell\)/ })).toContainText('Platinum III · Est. 1RM 140 kg');
  await expect(lifts(page).getByRole('link')).toHaveCount(10);
});

test("a finished workout's page shows each lift's rank as it stood then, and what the workout earned", async ({ page }) => {
  await seedRanked(page);
  await page.goto('/#/history');
  const pushes = page.getByRole('main').getByRole('link', { name: /Push/ });

  // The latest push day took the bench press from Gold II to Gold III.
  await pushes.first().click();
  const bench = page.getByRole('region', { name: 'Bench Press (Barbell)' });
  await expect(bench).toContainText('Gold III');
  await expect(bench).toContainText('Up from Gold II');
  await expect(page.getByRole('region', { name: 'Overhead Press (Dumbbell)' })).toContainText('Platinum I');
  await expect(page.getByRole('region', { name: 'Triceps Rope Pushdown (Cable)' })).toContainText('Up from Silver III');

  // The pull-ups of the latest pull day were the same nine as every week: a rank, and nothing earned.
  await page.goto('/#/history');
  await page.getByRole('main').getByRole('link', { name: /Pull/ }).first().click();
  const pullUp = page.getByRole('region', { name: 'Pull Up' });
  await expect(pullUp).toContainText('Silver I');
  await expect(pullUp).not.toContainText('Up from');
  await expect(pullUp).not.toContainText('First rank');

  // The first push day ever is where each of its lifts got a rank at all — the rank of that day, not today's.
  await page.goto('/#/history');
  await pushes.last().click();
  const first = page.getByRole('region', { name: 'Bench Press (Barbell)' });
  await expect(first).toContainText('Gold II');
  await expect(first).toContainText('First rank');
  await expect(first).not.toContainText('Gold III');

  // With ranks off the page is what it was.
  await page.goto('/#/settings');
  await choose(page, 'Off');
  await page.goto('/#/history');
  await pushes.first().click();
  await expect(page.getByRole('region', { name: 'Bench Press (Barbell)' })).toContainText('87.5 kg × 8');
  await expect(page.getByRole('region', { name: 'Bench Press (Barbell)' })).not.toContainText('Gold');
});

test('with ranks off, a workout shows no badges and celebrates nothing', async ({ page }) => {
  await seed(page);
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await addExercise(page, 'bench press', 'Bench Press (Barbell)');
  await logSet(page, 'Bench Press (Barbell)', '120', '5');
  await expectNoRankUp(page);
  await expect(page.getByRole('region', { name: 'Bench Press (Barbell)' }).getByRole('img')).toHaveCount(0);
});
