import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addExercise, seed } from './helpers';

// The rest timer: ticking a set off starts a countdown beside Finish.

const chip = (page: Page) => page.getByRole('button', { name: /^Rest/ });
const bench = (page: Page) => page.getByRole('region', { name: 'Bench Press (Barbell)' });
const tick = (page: Page) => bench(page).getByRole('button', { name: 'Mark set as done' }).first().click();

/** Demo history and a new workout with bench press in it (three sets, last time's numbers on offer). */
async function startBench(page: Page): Promise<void> {
  await seed(page);
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await addExercise(page, 'bench press', 'Bench Press (Barbell)');
}

/** Looked at once, after a moment in which a chip would have appeared. */
async function expectNoRest(page: Page): Promise<void> {
  await page.waitForTimeout(500);
  expect(await chip(page).count()).toBe(0);
}

test('ticking a set starts the rest, which can be made longer or skipped', async ({ page }) => {
  await startBench(page);
  expect(await chip(page).count()).toBe(0);

  await tick(page);
  await expect(chip(page)).toHaveText(/^(2:00|1:5\d)$/);
  await expect(chip(page)).toHaveAccessibleName(/^Rest: (2:00|1:5\d) left$/);

  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Add 30 Seconds' }).click();
  await expect(chip(page)).toHaveText(/^2:[23]\d$/);

  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Skip Rest' }).click();
  await expect(chip(page)).toHaveCount(0);

  // The next set starts a new one; unticking a set starts nothing.
  await tick(page);
  await expect(chip(page)).toHaveText(/^(2:00|1:5\d)$/);
  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Skip Rest' }).click();
  await bench(page).getByRole('button', { name: 'Mark set as not done' }).first().click();
  await expectNoRest(page);
});

test('when the rest is over it says so, then goes away by itself', async ({ page }) => {
  await page.clock.install();
  await startBench(page);
  await tick(page);
  await expect(chip(page)).toHaveText(/^(2:00|1:5\d)$/);

  await page.clock.fastForward('01:00');
  await expect(chip(page)).toHaveText(/^(1:00|0:5\d)$/);
  await page.clock.fastForward('01:00');
  await expect(chip(page)).toHaveText('Rest over');
  await expect(chip(page)).toHaveAccessibleName('Rest over');

  await page.clock.fastForward('00:11');
  await expect(chip(page)).toHaveCount(0);
});

test('its length is a setting, and Off means no timer', async ({ page }) => {
  await startBench(page);
  await page.goto('/#/settings');
  const length = page.getByLabel('Rest timer');
  await expect(length).toHaveValue('120');
  await expect(length.locator('option')).toHaveText(['Off', '0:30', '0:45', '1:00', '1:30', '2:00', '2:30', '3:00', '4:00', '5:00']);
  await length.selectOption({ label: '0:45' });

  await page.goto('/#/workout');
  await tick(page);
  await expect(chip(page)).toHaveText(/^0:4\d$/);
  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Skip Rest' }).click();

  await page.goto('/#/settings');
  await page.getByLabel('Rest timer').selectOption({ label: 'Off' });
  // With no timer there is no sound to switch either.
  await expect(page.getByRole('switch', { name: 'Sound when the rest is over' })).toHaveCount(0);
  await page.reload();
  await expect(page.getByLabel('Rest timer')).toHaveValue('0');
  await page.goto('/#/workout');
  await tick(page);
  await expectNoRest(page);
});

test('a sound is set for the end of the rest, moved with it, and not made when switched off', async ({ page }) => {
  // A stand-in for the browser's sound: it keeps when each tone was set to start and whether it was called off.
  await page.addInitScript(() => {
    const tones: { at: number; calledOff: boolean }[] = [];
    Object.assign(window, { tones });
    class Node { connect(target: unknown) { return target; } }
    class Oscillator extends Node {
      frequency = { value: 0 };
      tone: { at: number; calledOff: boolean } | null = null;
      start(at: number) { this.tone = { at, calledOff: false }; tones.push(this.tone); }
      stop(at?: number) { if (at === undefined && this.tone) this.tone.calledOff = true; }
    }
    class Gain extends Node { gain = { setValueAtTime() {} }; }
    Object.assign(window, { AudioContext: class {
      currentTime = 1000;
      destination = new Node();
      resume() { return Promise.resolve(); }
      createOscillator() { return new Oscillator(); }
      createGain() { return new Gain(); }
    } });
  });
  const tones = () => page.evaluate(() => (window as unknown as { tones: { at: number; calledOff: boolean }[] }).tones);
  await startBench(page);

  await tick(page);
  expect(await tones()).toEqual([{ at: 1120, calledOff: false }]); // two minutes from "now"

  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Add 30 Seconds' }).click();
  const moved = await tones();
  expect(moved[0].calledOff).toBe(true);
  expect(moved[1].calledOff).toBe(false);
  expect(moved[1].at).toBeGreaterThan(1145); // about two and a half minutes from the start
  expect(moved[1].at).toBeLessThanOrEqual(1150);

  await chip(page).click();
  await page.getByRole('menuitem', { name: 'Skip Rest' }).click();
  expect((await tones()).map((tone) => tone.calledOff)).toEqual([true, true]);

  // Switched off: the rest still runs, silently.
  await page.goto('/#/settings');
  await page.getByRole('switch', { name: 'Sound when the rest is over' }).uncheck();
  await page.goto('/#/workout');
  await tick(page);
  await expect(chip(page)).toBeVisible();
  expect(await tones()).toHaveLength(2); // the two from before; this rest set none
});

test('the rest ends with the workout, and correcting an old workout starts none', async ({ page }) => {
  await startBench(page);
  await tick(page);
  await expect(chip(page)).toBeVisible();
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('alertdialog', { name: 'Finish workout?' }).getByRole('button', { name: 'Finish' }).click();
  await expect(page).toHaveURL(/#\/history$/);

  // Editing the workout just finished: ticking there is bookkeeping, not training.
  await page.getByRole('main').getByRole('link', { name: /Workout/ }).first().click();
  await page.getByRole('button', { name: 'Workout options' }).click();
  await page.getByRole('menuitem', { name: 'Edit Workout' }).click();
  await bench(page).getByRole('button', { name: 'Add Set' }).click();
  await bench(page).getByLabel('Reps').nth(1).fill('5');
  await bench(page).getByRole('button', { name: 'Mark set as done' }).click();
  await expectNoRest(page);
  await page.getByRole('button', { name: 'Done', exact: true }).click();

  // And a new workout starts without the old one's rest still running.
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await expectNoRest(page);
});
