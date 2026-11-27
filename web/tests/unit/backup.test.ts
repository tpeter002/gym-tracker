import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { BackupError, exportBackup, parseBackup } from '../../src/lib/backup';
import { seedLibrary } from '../../src/lib/exercises';
import { emptyState } from '../../src/lib/types';
import type { AppState } from '../../src/lib/types';
import { saveVideoLink } from '../../src/lib/videos';
import { addExercise, finishWorkout, startEmpty } from '../../src/lib/workouts';

// What a backup file may bring into the app. A file is somebody else's data
// until it has been read: it gets the same checks as an answer from the network.

type File = { app: string; version?: number; data: Record<string, any> };

function sample(): AppState {
  const state = emptyState();
  seedLibrary(state);
  for (const [index, name] of ['Legs', 'Push', 'Pull'].entries()) {
    // Deliberately not in order of time: Push is the oldest.
    const id = startEmpty(state, 1_795_000_000_000 + [2, 0, 1][index] * 86_400_000);
    addExercise(state, id, state.exercises[index].id);
    state.workouts.at(-1)!.name = name;
    state.workouts.at(-1)!.entries[0].sets[0] = { id: `set-${index}`, weight: 50, reps: 5, rpe: null, isWarmup: false, isDone: true };
    finishWorkout(state, id, state.workouts.at(-1)!.startedAt + 3_600_000);
  }
  state.bodyWeights.push({ id: 'w1', date: 1_795_000_000_000, kg: 80 });
  saveVideoLink(state, 'https://www.youtube.com/shorts/abcdefghijk');
  return state;
}

const file = (state = sample()) => JSON.parse(exportBackup(state)) as File;
const restore = (content: File) => parseBackup(JSON.stringify(content)).state;

describe('a backup file', () => {
  it('comes back as it went out, in the same order', () => {
    const state = sample();
    const restored = parseBackup(exportBackup(state)).state;
    expect(restored.workouts.map((workout) => workout.name)).toEqual(['Legs', 'Push', 'Pull']);
    expect(restored.workouts).toEqual(state.workouts);
    expect(restored.exercises).toEqual(state.exercises);
    expect(restored.videos).toEqual(state.videos);
    expect(restored.bodyWeights).toEqual(state.bodyWeights);
  });

  it('keeps a picture only when it is inside the file', () => {
    const embedded = 'data:image/jpeg;base64,AAAA';
    for (const [thumbnail, kept] of [
      [embedded, embedded],
      ['https://tracker.example/pixel.gif?who=me', null],  // would be fetched every time the video is shown
      ['http://192.168.1.1/', null], ['data:text/html,<script>1</script>', null], ['', null], [42, null], [null, null],
    ] as const) {
      const content = file();
      content.data.videos[0].thumbnail = thumbnail;
      expect(restore(content).videos[0].thumbnail).toBe(kept);
    }
  });

  it('takes the first record when an id is repeated', () => {
    const content = file();
    const [first] = content.data.workouts;
    content.data.workouts.push({ ...first, name: 'An impostor with the same id' });
    content.data.exercises.push({ ...content.data.exercises[0], name: 'Another impostor' });
    content.data.bodyWeights.push({ ...content.data.bodyWeights[0], kg: 999 });
    content.data.videos.push({ ...content.data.videos[0], title: 'Impostor' });
    const restored = restore(content);

    const original = sample();
    expect(restored.workouts.map((workout) => workout.name)).toEqual(['Legs', 'Push', 'Pull']);
    expect(restored.exercises).toHaveLength(original.exercises.length);
    expect(restored.exercises[0].name).toBe(original.exercises[0].name);
    expect(restored.bodyWeights).toEqual([{ id: 'w1', date: 1_795_000_000_000, kg: 80 }]);
    expect(restored.videos.map((video) => video.title)).toEqual(['']);
  });

  it('closes all but the newest of several workouts left in progress, without reordering anything', () => {
    const content = file();
    for (const workout of content.data.workouts) workout.endedAt = null;
    const restored = restore(content).workouts;
    expect(restored.map((workout) => workout.name)).toEqual(['Legs', 'Push', 'Pull']);
    // Legs started last, so it is the one still running.
    expect(restored.map((workout) => workout.endedAt === null)).toEqual([true, false, false]);
  });

  it.each([
    ['from a newer version', (content: File) => { content.version = 99; }, 'That backup was made by a newer version of Gym Tracker.'],
    ['without a version at all', (content: File) => { delete content.version; }, "That file isn't a Gym Tracker backup."],
    ['from another app', (content: File) => { content.app = 'strong'; }, "That file isn't a Gym Tracker backup."],
    ['with no data in it', (content: File) => { (content as Record<string, unknown>).data = null; }, "That file isn't a Gym Tracker backup."],
  ])('is turned down in the right words when it is %s', (_, damage, message) => {
    const content = file();
    damage(content);
    expect(() => restore(content)).toThrowError(new BackupError(message));
  });

  it('is turned down when it is not a file of this kind at all', () => {
    for (const text of ['', 'not json', '[]', '"a string"', 'null']) {
      expect(() => parseBackup(text)).toThrowError("That file isn't a Gym Tracker backup.");
    }
  });
});

describe('a backup file made by the first version of the format', () => {
  // A real file, kept in the repository. If this stops passing, files people have on disk have stopped restoring:
  // change the reader so it still takes them, never the fixture.
  const text = readFileSync(new URL('../fixtures/backup-v1.json', import.meta.url), 'utf8');

  it('still restores, with everything it holds', () => {
    const { state, exportedAt } = parseBackup(text);
    expect(exportedAt).toBe(1_795_800_000_000);
    expect(state.libraryVersion).toBe(1);
    expect(state.exercises.map((exercise) => exercise.name)).toEqual(['Bench Press (Barbell)', 'Overhead Press (Dumbbell)', 'Half-Kneeling Cable Y Raise']);
    expect(state.exercises[2]).toMatchObject({ isCustom: true, wantToTry: true, videoId: 'video-1', notes: 'One knee down.\nFrom the video: 3 x 12' });

    const [finished, running] = state.workouts;
    expect(finished).toMatchObject({ name: 'Push', notes: 'Felt strong.', endedAt: 1_795_603_720_000 });
    expect(finished.exports).toEqual({
      strava: { status: 'sent', at: 1_795_603_800_000, url: 'https://www.strava.com/activities/1' },
      garmin: { status: 'failed', at: 1_795_603_900_000, error: 'Garmin Connect refused the request (400: HTTP 400).' },
    });
    expect(finished.entries.map((entry) => [entry.exerciseName, entry.exerciseId, entry.bothDumbbells ?? false, entry.sets.length])).toEqual([
      ['Bench Press (Barbell)', 'ex-bench', false, 2],
      ['Overhead Press (Dumbbell)', 'ex-press', true, 1],
      ['An Exercise Deleted Since', null, false, 1],
    ]);
    expect(finished.entries[0].sets[0]).toEqual({ id: 'set-1', weight: 40, reps: 10, rpe: null, isWarmup: true, isDone: true });
    expect(running).toMatchObject({ name: 'Evening Workout', endedAt: null });
    expect(running.entries[0].sets[1]).toEqual({ id: 'set-6', weight: null, reps: null, rpe: null, isWarmup: false, isDone: false });

    expect(state.bodyWeights).toEqual([{ id: 'weight-1', date: 1_795_500_000_000, kg: 82.9 }, { id: 'weight-2', date: 1_795_000_000_000, kg: 83.4 }]);
    expect(state.videos[0]).toMatchObject({ title: '3 cable moves for rear delts', analyzedBy: 'gemini-3-flash-preview', thumbnail: 'data:image/jpeg;base64,AAAA' });
    expect(state.videos[0].suggestions).toHaveLength(2);
    expect(state.settings).toMatchObject({
      unit: 'lb', effort: 'rir', analyzerURL: 'my-mac.local:8787', modelProvider: 'gemini', rankStandards: 'men',
      autoExport: { strava: true, garmin: false }, shareCode: '',
    });
    expect(state.settings.models.gemini).toBe('gemini-3-flash-preview');
    expect(Object.values(state.settings.apiKeys)).toEqual(['', '', '', '']);
  });

  it('loses nothing on the way through today\'s app', () => {
    // Written out again, everything the file held is still there. Newer settings may have joined it; nothing may have left.
    const { state, exportedAt } = parseBackup(text);
    const rewritten = exportBackup(state, exportedAt!);
    expect(JSON.parse(rewritten)).toMatchObject(JSON.parse(text));
    expect(parseBackup(rewritten).state).toEqual(state);
  });
});
