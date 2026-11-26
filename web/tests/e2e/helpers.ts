import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { exportBackup } from '../../src/lib/backup';
import { seedLibrary } from '../../src/lib/exercises';
import { uid } from '../../src/lib/ids';
import { emptyState } from '../../src/lib/types';
import type { AppState, Workout } from '../../src/lib/types';
import { linkExercise } from '../../src/lib/videos';

const DAY = 86_400_000;

/**
 * Four weeks of push / pull / legs, body-weight entries, and one saved video
 * with two exercises waiting on the to-try list — as a backup file's text.
 */
export function demoBackup(now = Date.now()): string {
  const state: AppState = emptyState();
  seedLibrary(state);
  const exercise = (name: string) => state.exercises.find((candidate) => candidate.name === name)!;

  const plans: { name: string; lifts: [string, number | null, number, number][] }[] = [
    { name: 'Push', lifts: [['Bench Press (Barbell)', 80, 8, 3], ['Overhead Press (Dumbbell)', 24, 10, 3], ['Triceps Rope Pushdown (Cable)', 27.5, 12, 3]] },
    { name: 'Pull', lifts: [['Pull Up', null, 9, 3], ['Bent Over Row (Barbell)', 70, 8, 3], ['Bicep Curl (Dumbbell)', 14, 12, 3]] },
    { name: 'Legs', lifts: [['Squat (Barbell)', 100, 6, 3], ['Romanian Deadlift (Barbell)', 90, 8, 3], ['Leg Extension (Machine)', 55, 12, 2]] },
  ];
  for (let week = 0; week < 4; week++) {
    plans.forEach((plan, index) => {
      // The latest one (Legs) ended an hour ago, so a workout logged in a test is the newest.
      const start = now - ((3 - week) * 7 + (4 - index * 2)) * DAY - 122 * 60_000;
      const workout: Workout = {
        id: uid(), name: plan.name, startedAt: start, endedAt: start + 62 * 60_000, notes: '',
        entries: plan.lifts.map(([name, weight, reps, sets]) => ({
          id: uid(), exerciseId: exercise(name).id, exerciseName: name, notes: '',
          sets: Array.from({ length: sets }, (_, setIndex) => ({
            id: uid(),
            weight: weight === null ? null : weight + week * 2.5,
            reps: reps - setIndex,
            rpe: 7.5 + setIndex * 0.5,
            isWarmup: false,
            isDone: true,
          })),
        })),
      };
      state.workouts.push(workout);
    });
  }

  for (let day = 56; day >= 0; day -= 4) {
    state.bodyWeights.push({ id: uid(), date: now - day * DAY, kg: 84.2 - (56 - day) * 0.03 + (day % 8 === 0 ? 0.4 : -0.1) });
  }

  const video = {
    id: uid(), url: 'https://www.youtube.com/shorts/demo', title: '3 cable moves for bigger rear delts', caption: '',
    thumbnail: null, addedAt: now, analyzedAt: now, suggestions: [],
  };
  state.videos.push(video);
  for (const name of ['Face Pull (Cable)', 'Reverse Fly (Cable)']) linkExercise(exercise(name), video);

  return exportBackup(state, now);
}

/** Loads the demo data the way a person would: Settings → Restore Backup. */
export async function seed(page: Page): Promise<void> {
  await page.goto('/#/settings');
  await page.getByLabel('Backup file').setInputFiles({
    name: 'gym-tracker-backup.json', mimeType: 'application/json', buffer: Buffer.from(demoBackup()),
  });
  await page.getByRole('button', { name: 'Replace' }).click();
  await expect(page.getByText('Restored 12 workouts from the backup.')).toBeVisible();
}

/** Opens the picker from the running workout and adds one exercise through search. */
export async function addExercise(page: Page, search: string, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add Exercise' }).click();
  const picker = page.getByRole('dialog', { name: 'Add Exercise' });
  await picker.getByRole('searchbox').fill(search);
  await picker.getByRole('button', { name: new RegExp(`^${escape(name)}`) }).click();
  await picker.getByRole('button', { name: 'Add 1 Exercise' }).click();
  await expect(picker).toBeHidden();
}

export const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Stands in for the analyzer: /health says yes, /analyze answers with `body`. */
export async function mockAnalyzer(page: Page, status: number, body: unknown): Promise<string[]> {
  const requests: string[] = [];
  await page.route('**/health', (route) => route.fulfill({ json: { ok: true } }));
  await page.route('**/analyze', (route) => {
    requests.push(route.request().postData() ?? '');
    return route.fulfill({ status, json: body });
  });
  return requests;
}

export const CANNED_ANALYSIS = {
  title: '3 cable moves for rear delts',
  caption: 'Save this for your next pull day',
  exercises: [
    {
      name: 'Cable Face Pull', library_match: 'Face Pull (Cable)', muscle_group: 'shoulders', equipment: 'cable',
      notes: 'Rope at eye level, pull to the forehead, elbows high.', sets_reps: '3 x 15',
    },
    {
      name: 'Half-Kneeling Cable Y Raise', library_match: null, muscle_group: 'shoulders', equipment: 'cable',
      notes: 'One knee down, raise the arm up and out in a Y.', sets_reps: null,
    },
  ],
};
