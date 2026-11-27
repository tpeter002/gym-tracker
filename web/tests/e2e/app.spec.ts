import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addExercise, CANNED_ANALYSIS, mockAnalyzer, seed } from './helpers';

// Every test starts in a fresh browser profile, i.e. with an empty database.

test('log, finish and repeat a workout', async ({ page }) => {
  await seed(page);
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await expect(page).toHaveURL(/#\/workout$/);

  await addExercise(page, 'bench press', 'Bench Press (Barbell)');
  const bench = page.getByRole('region', { name: 'Bench Press (Barbell)' });
  const weight = bench.getByLabel('Weight');
  const reps = bench.getByLabel('Reps');
  const tick = bench.getByRole('button', { name: /^Mark set as/ });
  // Last time was three sets, so three rows, each offering last time's numbers.
  await expect(weight).toHaveCount(3);
  await expect(bench.getByRole('button', { name: /^Use last time's numbers/ }).first()).toHaveText(/87\.5 kg × 8\s+@7\.5/);

  // Ticking an empty row takes last time's numbers over.
  await tick.nth(0).click();
  await expect(weight.nth(0)).toHaveValue('87.5');
  await expect(reps.nth(0)).toHaveValue('8');

  // The second set is typed in; the third is left alone.
  await weight.nth(1).fill('90');
  await reps.nth(1).fill('6');
  await bench.getByLabel('RPE').nth(1).selectOption('9');
  await tick.nth(1).click();
  await expect(tick.nth(1)).toHaveAttribute('aria-pressed', 'true');

  await page.getByRole('button', { name: 'Finish' }).click();
  const question = page.getByRole('alertdialog', { name: 'Finish workout?' });
  await expect(question).toContainText("Sets you haven't ticked off won't be saved.");
  await question.getByRole('button', { name: 'Finish' }).click();

  await expect(page).toHaveURL(/#\/history$/);
  const newest = page.getByRole('main').getByRole('link').first();
  await expect(newest).toContainText('2 × Bench Press (Barbell)');

  // It is in the browser's database, not just on screen.
  await page.reload();
  await page.getByRole('main').getByRole('link').first().click();
  await expect(page.getByText('87.5 kg × 8')).toBeVisible();
  await expect(page.getByText('90 kg × 6')).toBeVisible();
  await expect(page.getByText('RPE 9', { exact: true })).toBeVisible();
  await expect(page.getByText('Volume')).toBeVisible();

  await page.getByRole('button', { name: 'Repeat Workout' }).click();
  await expect(page).toHaveURL(/#\/workout$/);
  const again = page.getByRole('region', { name: 'Bench Press (Barbell)' });
  await expect(again.getByLabel('Weight')).toHaveCount(2);
  await expect(again.getByLabel('Weight').first()).toHaveValue('');
  await expect(again.getByRole('button', { name: /^Use last time's numbers/ }).nth(1)).toHaveText(/90 kg × 6\s+@9/);
});

test('sets can be added, marked as warm-up and deleted; exercises removed', async ({ page }) => {
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await addExercise(page, 'squat', 'Squat (Barbell)');
  await addExercise(page, 'plank', 'Plank');

  const squat = page.getByRole('region', { name: 'Squat (Barbell)' });
  await squat.getByRole('button', { name: 'Add Set' }).click();
  await expect(squat.getByLabel('Reps')).toHaveCount(4);

  await squat.getByRole('button', { name: 'Set 1 options' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Warm-up Set' }).click();
  await expect(squat.getByRole('button', { name: 'Warm-up set options' })).toHaveText('W');
  await expect(squat.getByRole('button', { name: 'Set 3 options' })).toBeVisible(); // the rest renumber 1–3

  await squat.getByRole('button', { name: 'Set 3 options' }).click();
  await page.getByRole('menuitem', { name: 'Delete Set' }).click();
  await expect(squat.getByLabel('Reps')).toHaveCount(3);

  // Without reps there is nothing to log: the tick does not take.
  await squat.getByRole('button', { name: 'Mark set as done' }).first().click();
  await expect(squat.getByRole('button', { name: 'Mark set as not done' })).toHaveCount(0);
  await expect(squat.getByLabel('Reps').first()).toBeFocused();

  await page.getByRole('button', { name: 'Plank options' }).click();
  await page.getByRole('menuitem', { name: 'Move Up' }).click();
  await expect(page.getByRole('region').first()).toHaveAccessibleName('Plank');
  await page.getByRole('button', { name: 'Plank options' }).click();
  await page.getByRole('menuitem', { name: 'Remove Exercise' }).click();
  await expect(page.getByRole('region', { name: 'Plank' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Finish' }).click();
  await expect(page.getByRole('alertdialog', { name: 'Nothing logged yet' })).toBeVisible();
  await page.getByRole('button', { name: 'OK' }).click();

  await page.getByRole('button', { name: 'Discard Workout' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Discard Workout' }).click();
  await expect(page.getByRole('button', { name: 'Start Empty Workout' })).toBeVisible();
});

test('starting a second workout asks first', async ({ page }) => {
  await seed(page);
  await page.goto('/#/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await page.getByLabel('Workout name').fill('First one');
  await page.getByRole('button', { name: 'Minimize' }).click();

  // The running workout stays one tap away.
  await expect(page.getByRole('button', { name: /First one.*In progress.*Resume/ })).toBeVisible();

  await page.getByRole('button', { name: 'Repeat Legs' }).first().click();
  const question = page.getByRole('alertdialog', { name: 'You already have a workout in progress' });
  await question.getByRole('button', { name: 'Resume Current Workout' }).click();
  await expect(page.getByLabel('Workout name')).toHaveValue('First one');

  await page.getByRole('button', { name: 'Minimize' }).click();
  await page.getByRole('button', { name: 'Repeat Legs' }).first().click();
  await question.getByRole('button', { name: 'Discard It and Start New' }).click();
  await expect(page.getByLabel('Workout name')).toHaveValue('Legs');
  await expect(page.getByRole('region', { name: 'Squat (Barbell)' })).toBeVisible();
  await expect(page.getByRole('region')).toHaveCount(3);
});

test('create and find a custom exercise', async ({ page }) => {
  await page.goto('/#/exercises');
  await page.getByRole('searchbox').fill('Zercher squat');
  await page.getByRole('button', { name: 'Create “Zercher squat”' }).click();

  const editor = page.getByRole('dialog', { name: 'New Exercise' });
  await expect(editor.getByLabel('Name')).toHaveValue('Zercher squat');
  await expect(editor.getByLabel('Muscle group')).toHaveValue('quads'); // guessed from the name
  await editor.getByLabel('Equipment').selectOption('barbell');
  await editor.getByRole('textbox', { name: 'Notes' }).fill('Bar in the crook of the elbows.');
  await editor.getByRole('button', { name: 'Save' }).click();
  await expect(editor).toBeHidden();

  await page.getByRole('searchbox').fill('zercher');
  await page.getByRole('link', { name: /Zercher squat/ }).click();
  await expect(page.getByRole('heading', { name: 'Zercher squat' })).toBeVisible();
  await expect(page.getByText('Bar in the crook of the elbows.')).toBeVisible();
  await expect(page.getByText("You haven't done this exercise yet.")).toBeVisible();

  // The same name twice is refused.
  await page.goto('/#/exercises');
  await page.getByRole('button', { name: 'New exercise' }).click();
  await page.getByLabel('Name').fill('zercher  SQUAT');
  await expect(page.getByText('An exercise with this name already exists.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled();
  await page.getByRole('button', { name: 'Cancel' }).click();

  // Deleting it takes it off the list.
  await page.getByRole('searchbox').fill('zercher');
  await page.getByRole('link', { name: /Zercher squat/ }).click();
  await page.getByRole('button', { name: 'Exercise options' }).click();
  await page.getByRole('menuitem', { name: 'Delete Exercise' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Exercise' }).click();
  await expect(page).toHaveURL(/#\/exercises$/);
  await page.getByRole('searchbox').fill('zercher');
  await expect(page.getByRole('link', { name: /Zercher squat/ })).toHaveCount(0);
});

test('to-try exercises lead the picker until they are done', async ({ page }) => {
  await seed(page);
  await page.goto('/#/');
  const toTry = page.getByRole('region', { name: 'To try' });
  await expect(toTry.getByRole('link', { name: /Face Pull \(Cable\)/ })).toContainText('To try');

  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await page.getByRole('button', { name: 'Add Exercise' }).click();
  const picker = page.getByRole('dialog', { name: 'Add Exercise' });
  await expect(picker.getByRole('heading', { name: 'To try · from your videos' })).toBeVisible();
  // First in the list, ahead of the alphabet.
  await expect(picker.locator('.card .row').first()).toContainText('Face Pull (Cable)');
  await picker.getByRole('button', { name: /^Face Pull \(Cable\)/ }).first().click();
  await picker.getByRole('button', { name: 'Add 1 Exercise' }).click();

  const facePull = page.getByRole('region', { name: 'Face Pull (Cable)' });
  await facePull.getByLabel('Weight').first().fill('20');
  await facePull.getByLabel('Reps').first().fill('15');
  await facePull.getByLabel('Reps').first().press('Enter'); // Enter ticks the set
  await page.getByRole('button', { name: 'Finish' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Finish' }).click();

  await page.goto('/#/');
  await expect(toTry.getByRole('link', { name: /Reverse Fly \(Cable\)/ })).toBeVisible();
  await expect(toTry.getByRole('link', { name: /Face Pull \(Cable\)/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Recent' }).getByRole('link').first()).toContainText('1 × Face Pull (Cable)');
});

test('save a video link and name its exercise by hand', async ({ page }) => {
  await page.goto('/#/videos');
  await expect(page.getByRole('heading', { name: 'No Saved Videos' })).toBeVisible();
  await page.getByRole('button', { name: 'Add Link', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Add Video Link' });

  await sheet.getByRole('textbox', { name: 'Video link' }).fill('not a link');
  await sheet.getByRole('button', { name: 'Save' }).click();
  await expect(sheet.getByText("That doesn't contain a link.")).toBeVisible();

  await sheet.getByRole('textbox', { name: 'Video link' }).fill('Check this out! https://www.instagram.com/reel/Cabc123/?igsh=tracking');
  await sheet.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('heading', { name: 'Instagram video' })).toBeVisible();
  // The tracking parameter is gone from the saved link.
  await expect(page.getByRole('link', { name: 'Open in Instagram' })).toHaveAttribute('href', 'https://www.instagram.com/reel/Cabc123/');
  await expect(page.getByText(/needs the analyzer running on your Mac/)).toBeVisible();

  await page.getByRole('button', { name: 'Add Exercise Manually' }).click();
  const picker = page.getByRole('dialog', { name: 'Add Exercise' });
  await picker.getByRole('searchbox').fill('hip thrust');
  await picker.getByRole('button', { name: /^Hip Thrust \(Barbell\)/ }).click();
  await picker.getByRole('button', { name: 'Add 1 Exercise' }).click();

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'On your list' })).toBeVisible();
  await expect(main.getByRole('link', { name: /Hip Thrust \(Barbell\)/ })).toContainText('To try');

  await page.goto('/#/');
  await expect(main.getByRole('link', { name: /Saved Videos/ })).toContainText('1');
  await main.getByRole('link', { name: /Hip Thrust \(Barbell\)/ }).click();
  await expect(page.getByRole('link', { name: 'Watch Video' })).toHaveAttribute('href', 'https://www.instagram.com/reel/Cabc123/');
  await expect(page.getByRole('switch', { name: 'Want to try' })).toBeChecked();

  // Saving the same clip again opens the one already saved.
  await page.goto('/#/videos');
  await page.getByRole('button', { name: 'Add link', exact: true }).click();
  await page.getByRole('textbox', { name: 'Video link' }).fill('https://www.instagram.com/reel/Cabc123/?igsh=other');
  await page.getByRole('button', { name: 'Save' }).click();
  await page.getByRole('button', { name: 'Remove Hip Thrust (Barbell)' }).click();
  await expect(main.getByRole('heading', { name: 'On your list' })).toHaveCount(0);
  await page.goto('/#/videos');
  await expect(main.getByRole('link')).toHaveCount(1);
});

test('an analyzed video fills the to-try list', async ({ page }) => {
  const requests = await mockAnalyzer(page, 200, CANNED_ANALYSIS);
  await page.goto('/#/videos');
  await page.getByRole('button', { name: 'Add Link', exact: true }).click();
  await page.getByRole('textbox', { name: 'Video link' }).fill('https://www.youtube.com/shorts/abcdefghijk?si=tracking');
  await page.getByRole('button', { name: 'Save' }).click();

  const main = page.getByRole('main');
  await expect(main.getByRole('heading', { name: 'On your list' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '3 cable moves for rear delts' })).toBeVisible();
  await expect(page.getByText('Save this for your next pull day')).toBeVisible();
  // A library exercise is reused under its own name; an unknown one is created.
  await expect(main.getByRole('link', { name: /Face Pull \(Cable\)/ })).toBeVisible();
  await expect(main.getByRole('link', { name: /Half-Kneeling Cable Y Raise/ })).toBeVisible();

  const sent = JSON.parse(requests[0]);
  expect(sent.url).toBe('https://www.youtube.com/shorts/abcdefghijk');
  expect(sent.known_exercises).toContain('Face Pull (Cable)');

  // The cue from the video is on the exercise, ready to read at the gym.
  await main.getByRole('link', { name: /Half-Kneeling Cable Y Raise/ }).click();
  await expect(page.getByText('One knee down, raise the arm up and out in a Y.')).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();

  // Removing one and identifying again only offers it; it isn't put back by itself.
  await page.getByRole('button', { name: 'Remove Half-Kneeling Cable Y Raise' }).click();
  await page.getByRole('button', { name: 'Identify Again' }).click();
  await expect(main.getByRole('heading', { name: 'Found in this video' })).toBeVisible();
  await expect(main.getByRole('link', { name: /Half-Kneeling Cable Y Raise/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add Half-Kneeling Cable Y Raise' }).click();
  await expect(main.getByRole('link', { name: /Half-Kneeling Cable Y Raise/ })).toBeVisible();
  expect(requests).toHaveLength(2);
});

test("the analyzer's error message is shown", async ({ page }) => {
  await mockAnalyzer(page, 422, { detail: 'That video is 10:35 long; this works on short clips (up to 10 minutes).' });
  await page.goto('/#/videos');
  await page.getByRole('button', { name: 'Add Link', exact: true }).click();
  await page.getByRole('textbox', { name: 'Video link' }).fill('https://www.youtube.com/watch?v=abcdefghijk');
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('That video is 10:35 long; this works on short clips (up to 10 minutes).')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Identify Exercises' })).toBeEnabled();
});

test('a link handed over in the address is saved', async ({ page }) => {
  const shared = 'Check this out https://www.tiktok.com/@coach/video/7300000000000000000?is_from_webapp=1';
  await page.goto(`/?text=${encodeURIComponent(shared)}`);
  await expect(page.getByRole('heading', { name: 'TikTok video' })).toBeVisible();
  await expect(page).toHaveURL(/\/#\/videos\/\w+$/);
  expect(new URL(page.url()).search).toBe('');
  await expect(page.getByRole('link', { name: 'Open in TikTok' }))
    .toHaveAttribute('href', 'https://www.tiktok.com/@coach/video/7300000000000000000');
});

test('import a Strong export', async ({ page }) => {
  const csv = '\uFEFF' + [
    'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE',
    '2023-03-01 18:05:10,"Push",1h 5m,"Bench Press (Barbell)",1,100.0,8,0,0,"","",8.5',
    '2023-03-01 18:05:10,"Push",1h 5m,"Bench Press (Barbell)",2,105.0,6,0,0,"","",',
    '2023-03-01 18:05:10,"Push",1h 5m,"Zercher Squat (Barbell)",1,60.0,5,0,0,"","",',
    '2023-03-03 07:30:00,"Pull",45m,"Pull Up",1,0,10,0,0,"","",',
  ].join('\r\n');
  const file = (name: string, text: string) => ({ name, mimeType: 'text/csv', buffer: Buffer.from(text) });

  await page.goto('/#/settings/import');
  await page.getByLabel('Strong export file').setInputFiles(file('contacts.csv', 'name,email\nA,b@example.com'));
  await expect(page.getByRole('alert')).toContainText("This doesn't look like a Strong export");

  await page.getByLabel('Strong export file').setInputFiles(file('strong.csv', csv));
  await expect(page.getByRole('alert')).toHaveCount(0);
  const main = page.getByRole('main');
  await expect(main.getByText('Period')).toBeVisible();
  await expect(main).toContainText('1 Mar 2023 – 3 Mar 2023');
  // The older layout doesn't name its unit, so the page asks.
  await page.getByRole('radiogroup', { name: 'Weights in the file are in' }).getByText('lb').click();
  await page.getByRole('button', { name: 'Import 2 Workouts' }).click();
  await expect(page.getByRole('status')).toHaveText('Imported 2 workouts and 4 sets');
  await expect(main).toContainText("1 exercise wasn't in the built-in list and was added as your own.");

  await page.goto('/#/history');
  await expect(main.getByRole('heading', { name: 'March 2023' })).toBeVisible();
  await main.getByRole('link', { name: /Push/ }).click();
  await expect(page.getByText('45.36 kg × 8')).toBeVisible(); // 100 lb
  await expect(page.getByText('1h 05m')).toBeVisible();

  // Importing the same file again adds nothing.
  await page.goto('/#/settings/import');
  await page.getByLabel('Strong export file').setInputFiles(file('strong.csv', csv));
  await page.getByRole('button', { name: 'Import 2 Workouts' }).click();
  await expect(main).toContainText('2 workouts were already here and were skipped.');
});

test('log body weight', async ({ page }) => {
  await page.goto('/#/body');
  await expect(page.getByRole('heading', { name: 'No Weigh-ins Yet' })).toBeVisible();
  await page.getByRole('button', { name: 'Log Weight', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Log Weight' });
  await expect(sheet.getByRole('button', { name: 'Save' })).toBeDisabled();
  await sheet.getByLabel('Body weight').fill('84,2'); // a comma works as well as a point
  await sheet.getByRole('button', { name: 'Save' }).click();

  const main = page.getByRole('main');
  await expect(main.locator('.hero')).toContainText('84.2 kg');
  await expect(main.getByText('Not enough weigh-ins in this range to draw a trend.')).toBeVisible();

  const weekAgo = new Date(Date.now() - 7 * 86_400_000);
  const day = `${weekAgo.getFullYear()}-${String(weekAgo.getMonth() + 1).padStart(2, '0')}-${String(weekAgo.getDate()).padStart(2, '0')}`;
  await page.getByRole('button', { name: 'Log weight', exact: true }).click();
  await sheet.getByLabel('Body weight').fill('85');
  await sheet.getByLabel('Date').fill(day);
  await sheet.getByLabel('Body weight').press('Enter');

  // Today's entry stays the headline; the change is measured from the older one.
  await expect(main.locator('.hero')).toContainText('84.2 kg');
  await expect(main.locator('.delta')).toHaveText('-0.8 kg');
  const chart = main.getByRole('group', { name: /^Body weight: 85 kg on .* to 84\.2 kg on / });
  await expect(chart).toBeVisible();
  await chart.focus();
  await expect(chart.locator('.chart-tip')).toContainText('84.2 kg');
  await chart.press('ArrowLeft');
  await expect(chart.locator('.chart-tip')).toContainText('85 kg');

  await main.getByRole('button', { name: /^Delete the entry from/ }).last().click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Weigh-in' }).click();
  await expect(main.getByRole('button', { name: /^Delete the entry from/ })).toHaveCount(1);
});

test('switch units and effort scale', async ({ page }) => {
  await seed(page);
  await page.getByRole('radiogroup', { name: 'Weight unit' }).getByText('lb').click();
  await page.getByRole('radiogroup', { name: 'Effort scale' }).getByText('RIR').click();

  await page.goto('/#/history');
  const main = page.getByRole('main');
  await main.getByRole('link', { name: /Push/ }).first().click();
  await expect(page.getByText('192.9 lb × 8')).toBeVisible(); // 87.5 kg
  await expect(page.getByText('2.5 RIR').first()).toBeVisible(); // RPE 7.5

  await page.getByRole('button', { name: 'Repeat Workout' }).click();
  const bench = page.getByRole('region', { name: 'Bench Press (Barbell)' });
  await expect(bench.getByLabel('RIR')).toHaveCount(3);
  await bench.getByLabel('Weight').first().fill('200');
  await bench.getByLabel('Reps').first().fill('5');
  await bench.getByLabel('RIR').first().selectOption('1');
  await bench.getByRole('button', { name: 'Mark set as done' }).first().click();

  // Stored in kilograms and as RPE: switching back shows the same set in the other terms.
  await page.goto('/#/settings');
  await page.getByRole('radiogroup', { name: 'Weight unit' }).getByText('kg').click();
  await page.getByRole('radiogroup', { name: 'Effort scale' }).getByText('RPE').click();
  await page.goto('/#/workout');
  await expect(bench.getByLabel('Weight').first()).toHaveValue('90.72');
  await expect(bench.getByLabel('RPE').first()).toHaveValue('9');

  await page.goto('/#/body');
  await expect(main.locator('.hero')).toContainText(' kg');
});

test('download a backup and restore it in a fresh browser', async ({ page, browser }) => {
  await seed(page);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download Backup' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/^gym-tracker-backup-\d{4}-\d{2}-\d{2}\.json$/);
  const text = await readFile(await saved.path(), 'utf8');
  expect(JSON.parse(text).data.workouts).toHaveLength(12);

  const context = await browser.newContext(); // a second browser, at the configured address
  const other = await context.newPage();
  await other.goto('/#/history');
  await expect(other.getByRole('heading', { name: 'No Workouts Yet' })).toBeVisible();

  await other.goto('/#/settings');
  await other.getByLabel('Backup file').setInputFiles({ name: 'notes.json', mimeType: 'application/json', buffer: Buffer.from('{"hello":1}') });
  await expect(other.getByText("That file isn't a Gym Tracker backup.")).toBeVisible();

  await other.getByLabel('Backup file').setInputFiles({ name: saved.suggestedFilename(), mimeType: 'application/json', buffer: Buffer.from(text) });
  await other.getByRole('alertdialog').getByRole('button', { name: 'Replace' }).click();
  await other.goto('/#/history');
  await expect(other.getByRole('main').getByRole('link', { name: /Legs/ })).toHaveCount(4);
  await context.close();
});

test('back returns to where you were', async ({ page }) => {
  await seed(page);
  await page.goto('/#/');
  const main = page.getByRole('main');
  await main.getByRole('link', { name: /Legs/ }).first().click();
  await main.getByRole('link', { name: 'Squat (Barbell)' }).click();
  await expect(page.getByRole('heading', { name: 'Squat (Barbell)', level: 1 })).toBeVisible();
  await expect(page.getByText('Estimated 1RM')).toBeVisible();
  await expect(main.getByRole('group', { name: /^Heaviest set of Squat \(Barbell\) per session/ })).toBeVisible();

  await page.getByRole('button', { name: 'Back' }).click();
  await expect(page.getByRole('heading', { name: 'Legs', level: 1 })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Workout', level: 1 })).toBeVisible();

  // Opened directly, a page's Back leads to its list instead of out of the app.
  await page.goto('/#/exercises');
  await page.getByRole('searchbox').fill('pull up');
  await main.getByRole('link', { name: /^Pull Up/ }).first().click();
  const address = page.url();
  const fresh = await page.context().newPage();
  await fresh.goto(address);
  await fresh.getByRole('button', { name: 'Back' }).click();
  await expect(fresh.getByRole('heading', { name: 'Exercises', level: 1 })).toBeVisible();
});

test('two tabs of the same browser stay in step', async ({ page, context }) => {
  await page.goto('/#/body');
  const other = await context.newPage();
  await other.goto('/#/body');
  await expect(other.getByRole('heading', { name: 'No Weigh-ins Yet' })).toBeVisible();

  await page.getByRole('button', { name: 'Log weight', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Log Weight' });
  await sheet.getByLabel('Body weight').fill('80');
  await sheet.getByRole('button', { name: 'Save' }).click();

  await expect(other.locator('.hero')).toContainText('80 kg');
});

test('says so when the browser gives it nowhere to store data', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(window, 'indexedDB', { value: undefined }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('nothing you log here will be kept');
  // It still works for as long as the tab stays open.
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await expect(page.getByLabel('Workout name')).toBeVisible();
});

test('a connection test overtaken by an edit of the address reports nothing', async ({ page, baseURL }) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  let answered = 0;
  await page.route(/\/(slow|quick)\/health$/, async (route) => {
    if (route.request().url().includes('/slow/')) await held;
    await route.fulfill({ json: { ok: true } });
    answered += 1;
  });
  await page.goto('/#/settings');
  const address = page.getByLabel('Analyzer address');
  const button = page.getByRole('button', { name: /^Test Connection/ });
  const host = new URL(baseURL!).host;

  await address.fill(`${host}/slow`);
  await button.click();
  await expect(button.locator('.spinner')).toBeVisible();
  // The address changes while the answer is on its way, so the answer is about another analyzer.
  await address.fill(`${host}/quick`);
  await expect(button.locator('.spinner')).toHaveCount(0);
  release();
  await expect.poll(() => answered).toBe(1);
  // Looked at once, after a pause: an assertion that waits could pass before the late answer had its chance to show.
  await page.waitForTimeout(300);
  expect(await button.getByText('Connected').count()).toBe(0);

  await button.click();
  await expect(button).toContainText('Connected');
});

/** Reaches past the app into its database: puts a workout record there, or takes the one with that id out again. */
async function tamper(page: Page, change: { put: Record<string, unknown> } | { remove: string }): Promise<void> {
  await page.evaluate(async (change) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('gym-tracker');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('workouts', 'readwrite');
      if ('put' in change) tx.objectStore('workouts').put(change.put);
      else tx.objectStore('workouts').delete(change.remove);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  }, change);
}

test('a record the app cannot draw leaves a way out instead of a blank page', async ({ page }) => {
  await page.goto('/#/history');
  await expect(page.getByRole('heading', { name: 'No Workouts Yet' })).toBeVisible(); // the database exists by now
  // A finished workout as no version of the app would write it.
  await tamper(page, { put: { id: 'damaged', name: 'Damaged', startedAt: 1_700_000_000_000, endedAt: 1_700_000_003_600, notes: '', entries: null } });
  await page.reload();

  const fallback = page.getByRole('alert');
  await expect(fallback.getByRole('heading', { name: 'Something went wrong' })).toBeVisible();
  await expect(fallback.getByRole('button', { name: 'Reload' })).toBeVisible();
  // The data can still be taken out, the damaged record included.
  const download = page.waitForEvent('download');
  await fallback.getByRole('button', { name: 'Download Backup' }).click();
  const saved = await download;
  expect(saved.suggestedFilename()).toMatch(/^gym-tracker-backup-\d{4}-\d{2}-\d{2}\.json$/);
  expect(JSON.parse(await readFile(await saved.path(), 'utf8')).data.workouts).toEqual([expect.objectContaining({ id: 'damaged' })]);

  // Reload starts the app afresh: once the record is gone, the page is back.
  await tamper(page, { remove: 'damaged' });
  await fallback.getByRole('button', { name: 'Reload' }).click();
  await expect(page.getByRole('heading', { name: 'No Workouts Yet' })).toBeVisible();
});

test('what is deleted stays deleted after the app is opened again', async ({ page }) => {
  await seed(page);
  await page.goto('/#/history');
  const main = page.getByRole('main');
  await expect(main.getByRole('link', { name: /Legs/ })).toHaveCount(4);
  await main.getByRole('link', { name: /Legs/ }).first().click();
  await page.getByRole('button', { name: 'Workout options' }).click();
  await page.getByRole('menuitem', { name: 'Delete Workout' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete Workout' }).click();
  await expect(main.getByRole('link', { name: /Legs/ })).toHaveCount(3);

  await page.reload();
  await expect(main.getByRole('link', { name: /Push/ })).toHaveCount(4); // the rest is back from storage…
  await expect(main.getByRole('link', { name: /Legs/ })).toHaveCount(3); // …and the deleted workout is not
});

test('an address that cannot be read is a page that is not there, not a blank screen', async ({ page }) => {
  await seed(page);
  await page.goto('/#/history/100%');
  await expect(page.getByRole('heading', { name: 'History', level: 1 })).toBeVisible();
  await page.goto('/#/exercises/%E0%A4%A');
  await expect(page.getByRole('heading', { name: 'Exercises', level: 1 })).toBeVisible();
});
