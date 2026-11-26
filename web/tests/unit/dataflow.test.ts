import { beforeEach, describe, expect, it } from 'vitest';
import { deleteExercise, newExercise, saveExercise, searchExercises, seedLibrary } from '../../src/lib/exercises';
import { LIBRARY } from '../../src/lib/library';
import { applyStrongImport, parseStrongCSV } from '../../src/lib/strong';
import { emptyState } from '../../src/lib/types';
import type { AppState, Exercise, ExerciseSuggestion, Workout } from '../../src/lib/types';
import {
  adoptSuggestion, applyAnalysis, canonicalLink, deleteVideo, exercisesFrom, firstURL, pendingSuggestions,
  saveVideoLink, unlinkExercise, youtubeThumbnail,
} from '../../src/lib/videos';
import {
  activeWorkout, addExercise, addSet, deleteWorkout, durationSeconds, finishWorkout, moveEntry, previousSets,
  rowLabels, sessionsFor, startEmpty, startRepeat, volumeKg,
} from '../../src/lib/workouts';

// The logic runs on a plain state object here; in the app the store hands it a draft of the same shape.
let state: AppState;

beforeEach(() => {
  state = emptyState();
});

function makeExercise(name: string, wantToTry = false): Exercise {
  const exercise = newExercise(name, 'chest', 'barbell', false);
  exercise.wantToTry = wantToTry;
  state.exercises.push(exercise);
  return exercise;
}

const workoutById = (id: string) => state.workouts.find((workout) => workout.id === id)!;

/** Logs `sets` ([kg, reps]) for one exercise and finishes the workout. */
function logWorkout(exercise: Exercise, sets: [number, number][], daysAgo: number): Workout {
  const start = Date.now() - daysAgo * 86_400_000;
  const workout = workoutById(startEmpty(state, start));
  workout.name = 'Session';
  addExercise(state, workout.id, exercise.id);
  const entry = workout.entries[0];
  while (entry.sets.length < sets.length) addSet(state, workout.id, entry.id);
  sets.forEach(([weight, reps], index) => Object.assign(entry.sets[index], { weight, reps, isDone: true }));
  finishWorkout(state, workout.id, start + 3_600_000);
  return workout;
}

describe('logging', () => {
  it('keeps only the ticked sets when finishing', () => {
    const bench = makeExercise('Bench Press (Barbell)');
    const curl = makeExercise('Bicep Curl (Barbell)');
    const workout = workoutById(startEmpty(state));
    addExercise(state, workout.id, bench.id);
    addExercise(state, workout.id, curl.id);
    expect(workout.entries.map((entry) => entry.sets.length)).toEqual([3, 3]);

    Object.assign(workout.entries[0].sets[0], { weight: 80, reps: 8, isDone: true });
    Object.assign(workout.entries[0].sets[2], { weight: 85, reps: 5, isDone: true });
    expect(activeWorkout(state)).toBe(workout);

    finishWorkout(state, workout.id);

    expect(activeWorkout(state)).toBeUndefined();
    expect(workout.endedAt).not.toBeNull();
    // An exercise with no ticked sets is dropped.
    expect(workout.entries.map((entry) => entry.exerciseName)).toEqual(['Bench Press (Barbell)']);
    expect(workout.entries[0].sets.map((set) => set.weight)).toEqual([80, 85]);
  });

  it('repeats a workout with its layout and offers the last numbers', () => {
    const bench = makeExercise('Bench Press (Barbell)');
    logWorkout(bench, [[70, 10], [75, 8]], 7);
    const latest = logWorkout(bench, [[80, 8], [82.5, 6], [85, 4]], 2);

    const again = workoutById(startRepeat(state, latest.id)!);

    expect(again.name).toBe(latest.name);
    expect(again.endedAt).toBeNull();
    const sets = again.entries[0].sets;
    expect(sets).toHaveLength(3);
    // Repeated sets start empty; the row shows last time's numbers instead.
    expect(sets.every((set) => set.weight === null && set.reps === null && !set.isDone)).toBe(true);
    const previous = previousSets(state.workouts, bench.id);
    expect(previous.map((set) => set.weight)).toEqual([80, 82.5, 85]);
    expect(previous.map((set) => set.reps)).toEqual([8, 6, 4]);
  });

  it('keeps a finished workout linked to its exercises', () => {
    const bench = makeExercise('Bench Press (Barbell)');
    const row = makeExercise('Bent Over Row (Barbell)');
    logWorkout(bench, [[80, 8], [80, 8], [80, 7]], 7);

    const workout = workoutById(startEmpty(state));
    addExercise(state, workout.id, bench.id);
    addExercise(state, workout.id, row.id);
    for (const entry of workout.entries) {
      Object.assign(entry.sets[0], { weight: 82.5, reps: 8, isDone: true });
      Object.assign(entry.sets[1], { weight: 85, reps: 5, rpe: 8.5, isDone: true });
    }
    finishWorkout(state, workout.id);

    expect(workout.entries.map((entry) => entry.sets.length)).toEqual([2, 2]);
    expect(workout.entries.map((entry) => entry.exerciseId)).toEqual([bench.id, row.id]);
    expect(sessionsFor(state.workouts, bench.id)).toHaveLength(2);

    const again = workoutById(startRepeat(state, workout.id)!);
    expect(again.entries.map((entry) => entry.exerciseName)).toEqual(['Bench Press (Barbell)', 'Bent Over Row (Barbell)']);
    expect(again.entries.map((entry) => entry.sets.length)).toEqual([2, 2]);
    expect(previousSets(state.workouts, bench.id).map((set) => set.weight)).toEqual([82.5, 85]);
  });

  it('mirrors the last set count when adding an exercise', () => {
    const bench = makeExercise('Bench Press (Barbell)');
    logWorkout(bench, [[80, 8], [80, 8], [80, 7], [80, 6]], 3);

    const workout = workoutById(startEmpty(state));
    addExercise(state, workout.id, bench.id);

    expect(workout.entries[0].sets).toHaveLength(4);
  });

  it('takes an exercise off the to-try list once it has been done', () => {
    const facePull = makeExercise('Face Pull (Cable)', true);
    const untouched = makeExercise('Reverse Fly (Cable)', true);

    logWorkout(facePull, [[20, 15]], 0);

    expect(facePull.wantToTry).toBe(false);
    expect(untouched.wantToTry).toBe(true);
  });

  it('keeps the exercise when its workout is deleted', () => {
    const bench = makeExercise('Bench Press (Barbell)');
    const workout = logWorkout(bench, [[80, 8]], 1);

    deleteWorkout(state, workout.id);

    expect(state.workouts).toHaveLength(0);
    expect(state.exercises).toHaveLength(1);
    expect(previousSets(state.workouts, bench.id)).toEqual([]);
  });

  it('keeps history readable when an exercise is renamed or deleted', () => {
    const bench = makeExercise('Bench Press (Barbell)');
    const workout = logWorkout(bench, [[80, 8]], 1);

    saveExercise(state, { name: ' Flat Bench ', muscle: 'chest', equipment: 'barbell', notes: '', videoURL: '' }, bench.id);
    expect(workout.entries[0].exerciseName).toBe('Flat Bench');

    deleteExercise(state, bench.id);
    expect(workout.entries[0]).toMatchObject({ exerciseId: null, exerciseName: 'Flat Bench' });
    // Nothing to log against any more, so a repeat leaves it out.
    expect(workoutById(startRepeat(state, workout.id)!).entries).toEqual([]);
  });

  it('reorders exercises and numbers working sets', () => {
    const workout = workoutById(startEmpty(state));
    for (const name of ['A', 'B', 'C']) addExercise(state, workout.id, makeExercise(name).id);
    moveEntry(state, workout.id, workout.entries[2].id, -1);
    moveEntry(state, workout.id, workout.entries[0].id, -1); // already first: no change
    expect(workout.entries.map((entry) => entry.exerciseName)).toEqual(['A', 'C', 'B']);

    const sets = workout.entries[0].sets;
    sets[0].isWarmup = true;
    expect(rowLabels(sets)).toEqual(['W', '1', '2']);
  });

  it('totals volume without warm-ups', () => {
    const workout = logWorkout(makeExercise('Bench Press (Barbell)'), [[40, 10], [80, 8], [80, 6]], 1);
    workout.entries[0].sets[0].isWarmup = true;
    expect(volumeKg(workout)).toBe(80 * 8 + 80 * 6);
    expect(durationSeconds(workout)).toBe(3600);
  });
});

describe('exercise library', () => {
  it('is seeded once and does not bring deleted built-ins back', () => {
    seedLibrary(state);
    expect(state.exercises).toHaveLength(LIBRARY.length);
    expect(new Set(state.exercises.map((exercise) => exercise.name)).size).toBe(LIBRARY.length);

    deleteExercise(state, state.exercises[0].id);
    seedLibrary(state);
    expect(state.exercises).toHaveLength(LIBRARY.length - 1);
  });

  it('finds exercises by words, abbreviations and muscle', () => {
    seedLibrary(state);
    const names = (query: string) => searchExercises(state.exercises, query, null).map((exercise) => exercise.name);

    // Names starting with the phrase come first, then the ones merely containing it.
    expect(names('pull up')).toEqual([
      'Pull Up', 'Pull Up (Assisted)', 'Pull Up (Weighted)', 'Neutral Grip Pull Up',
    ]);
    expect(names('db incline bench')).toEqual(['Incline Bench Press (Dumbbell)']);
    expect(names('zzz')).toEqual([]);
    expect(searchExercises(state.exercises, '', 'calves').every((exercise) => exercise.muscle === 'calves')).toBe(true);
  });
});

const strongCSV = [
  'Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,Distance,Seconds,Notes,Workout Notes,RPE',
  '2023-03-01 18:05:10,"Push",1h 5m,"Bench Press (Barbell)",1,100.0,8,0,0,"","",8.5',
  '2023-03-01 18:05:10,"Push",1h 5m,"Bench Press (Barbell)",2,105.0,6,0,0,"","",',
  '2023-03-01 18:05:10,"Push",1h 5m,"Zercher Squat (Barbell)",1,60.0,5,0,0,"","",',
  '2023-03-03 07:30:00,"Pull",45m,"Pull Up",1,0,10,0,0,"","",',
].join('\n');

describe('Strong import', () => {
  it('builds history and can be repeated without duplicates', () => {
    const bench = makeExercise('Bench Press (Barbell)');
    const parsed = parseStrongCSV(strongCSV);

    const first = applyStrongImport(state, parsed, 'kg');

    expect(first).toMatchObject({ workouts: 2, sets: 4, newExercises: 2 }); // Zercher Squat and Pull Up are new
    const workouts = [...state.workouts].sort((a, b) => a.startedAt - b.startedAt);
    expect(workouts.map((workout) => workout.name)).toEqual(['Push', 'Pull']);
    expect(durationSeconds(workouts[0])).toBe(3900);
    expect(workouts[0].entries[0].exerciseId).toBe(bench.id); // known names reuse the existing exercise
    expect(workouts[0].entries[0].sets.map((set) => set.weight)).toEqual([100, 105]);
    expect(workouts[0].entries[0].sets[0].rpe).toBe(8.5);
    const zercher = state.exercises.find((exercise) => exercise.id === workouts[0].entries[1].exerciseId)!;
    expect(zercher).toMatchObject({ isCustom: true, muscle: 'quads', equipment: 'barbell' });
    expect(activeWorkout(state)).toBeUndefined(); // imported workouts are finished ones

    const second = applyStrongImport(state, parsed, 'kg');

    expect(second).toMatchObject({ workouts: 0, alreadyImported: 2 });
    expect(state.workouts).toHaveLength(2);
  });

  it('converts pounds to kilograms', () => {
    applyStrongImport(state, parseStrongCSV(strongCSV), 'lb');
    const weights = state.workouts.flatMap((workout) => workout.entries).flatMap((entry) => entry.sets).map((set) => set.weight ?? 0);
    expect(Math.max(...weights)).toBeCloseTo(105 * 0.45359237, 2);
  });
});

describe('saved videos', () => {
  const facePull: ExerciseSuggestion = {
    name: 'Cable Face Pull', libraryMatch: 'Face Pull (Cable)', muscleGroup: 'shoulders', equipment: 'cable',
    notes: 'Rope at eye level.', setsReps: '3 x 15',
  };
  const yRaise: ExerciseSuggestion = {
    name: 'Half-Kneeling Cable Y Raise', libraryMatch: null, muscleGroup: 'shoulders', equipment: 'cable',
    notes: 'One knee down.', setsReps: null,
  };
  const result = { title: '3 cable moves', caption: 'Save this', thumbnail: null, exercises: [facePull, yRaise] };

  it('strips tracking parameters from share links', () => {
    const canonical = (link: string) => canonicalLink(new URL(link));
    expect(canonical('https://www.instagram.com/reel/Cxyz123/?igsh=abc123&utm_source=ig')).toBe('https://www.instagram.com/reel/Cxyz123/');
    expect(canonical('https://youtube.com/shorts/abc?si=tracking#frag')).toBe('https://youtube.com/shorts/abc');
    expect(canonical('https://www.youtube.com/watch?v=abc&si=tracking&t=42')).toBe('https://www.youtube.com/watch?v=abc&t=42');
  });

  it('finds the link inside shared text', () => {
    const shared = 'Check this out 💪 https://www.tiktok.com/@coach/video/7300000000000000000?is_from_webapp=1 #gym';
    expect(firstURL(shared)?.hostname).toBe('www.tiktok.com');
    expect(firstURL('Watch (https://youtu.be/abcdefghijk).')?.href).toBe('https://youtu.be/abcdefghijk');
    expect(firstURL('no link here')).toBeNull();
    expect(firstURL('javascript:alert(1)')).toBeNull();
  });

  it('saves the same clip only once', () => {
    const first = saveVideoLink(state, 'https://www.instagram.com/reel/Cxyz123/?igsh=one');
    const second = saveVideoLink(state, 'look https://www.instagram.com/reel/Cxyz123/?igsh=two');
    expect(first).toMatchObject({ created: true });
    expect(second).toEqual({ id: first!.id, created: false });
    expect(state.videos).toHaveLength(1);
    expect(saveVideoLink(state, 'nothing')).toBeNull();
  });

  it('puts the first analysis on the to-try list', () => {
    const existing = makeExercise('Face Pull (Cable)');
    const { id } = saveVideoLink(state, 'https://www.youtube.com/shorts/abcdefghijk')!;

    applyAnalysis(state, id, result, 1000);

    const video = state.videos[0];
    expect(video).toMatchObject({ title: '3 cable moves', caption: 'Save this', analyzedAt: 1000 });
    const added = exercisesFrom(state, id);
    expect(added.map((exercise) => exercise.name).sort()).toEqual(['Face Pull (Cable)', 'Half-Kneeling Cable Y Raise']);
    // The library exercise is reused rather than duplicated under the video's name for it.
    expect(existing).toMatchObject({ wantToTry: true, videoURL: video.url, notes: 'Rope at eye level.\nFrom the video: 3 x 15' });
    expect(state.exercises.find((exercise) => exercise.name === yRaise.name)).toMatchObject({ isCustom: true, muscle: 'shoulders', equipment: 'cable' });
    expect(pendingSuggestions(state, video)).toEqual([]);
  });

  it('only suggests on later runs, so removed exercises stay removed', () => {
    const { id } = saveVideoLink(state, 'https://www.youtube.com/shorts/abcdefghijk')!;
    applyAnalysis(state, id, result, 1000);
    const removed = state.exercises.find((exercise) => exercise.name === yRaise.name)!;

    unlinkExercise(state, removed.id, id);
    applyAnalysis(state, id, result, 2000);

    expect(removed).toMatchObject({ wantToTry: false, videoId: null, videoURL: null });
    expect(pendingSuggestions(state, state.videos[0])).toEqual([yRaise]);

    adoptSuggestion(state, yRaise, id);
    expect(removed.wantToTry).toBe(true);
    expect(pendingSuggestions(state, state.videos[0])).toEqual([]);
  });

  it('leaves the exercises behind when a video is deleted', () => {
    const { id } = saveVideoLink(state, 'https://www.youtube.com/shorts/abcdefghijk')!;
    applyAnalysis(state, id, result);

    deleteVideo(state, id);

    expect(state.videos).toEqual([]);
    expect(state.exercises.filter((exercise) => exercise.wantToTry)).toHaveLength(2);
    expect(state.exercises.every((exercise) => exercise.videoId === null)).toBe(true);
  });

  it('knows where YouTube keeps its stills', () => {
    const still = 'https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg';
    expect(youtubeThumbnail('https://www.youtube.com/shorts/abcdefghijk')).toBe(still);
    expect(youtubeThumbnail('https://youtu.be/abcdefghijk')).toBe(still);
    expect(youtubeThumbnail('https://www.youtube.com/watch?v=abcdefghijk&t=42')).toBe(still);
    expect(youtubeThumbnail('https://www.instagram.com/reel/Cxyz123/')).toBeNull();
  });
});
