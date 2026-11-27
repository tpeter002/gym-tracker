import { describe, expect, it } from 'vitest';
import { exportBackup, parseBackup } from '../../src/lib/backup';
import { seedLibrary } from '../../src/lib/exercises';
import { emptyState } from '../../src/lib/types';
import type { AppState, Workout } from '../../src/lib/types';
import {
  addExercise, deleteWorkout, finishWorkout, removeRoutine, restoreWorkout, ROUTINE_NAME_MAX, saveAsRoutine, savedRoutines, startEmpty,
  startRepeat,
} from '../../src/lib/workouts';

// Routines made on purpose: a finished workout kept under a name, to start new workouts from.

const DAY = 86_400_000;
const START = new Date(2026, 10, 2, 18, 0).getTime();

/** Three finished workouts — Push, Pull, Legs — one exercise each, plus one still running. */
function history(): { state: AppState; push: Workout; pull: Workout; legs: Workout; running: Workout } {
  const state = emptyState();
  seedLibrary(state);
  const plan = [['Push', 'Bench Press (Barbell)'], ['Pull', 'Pull Up'], ['Legs', 'Squat (Barbell)']] as const;
  plan.forEach(([name, exercise], index) => {
    const id = startEmpty(state, START + index * 2 * DAY);
    addExercise(state, id, state.exercises.find((candidate) => candidate.name === exercise)!.id);
    const workout = state.workouts.at(-1)!;
    workout.name = name;
    workout.entries[0].sets = workout.entries[0].sets.slice(0, 2).map((set, number) => ({ ...set, weight: 60, reps: 8 - number, isDone: true }));
    finishWorkout(state, id, workout.startedAt + 3_600_000);
  });
  startEmpty(state, START + 10 * DAY);
  const [push, pull, legs, running] = state.workouts;
  return { state, push, pull, legs, running };
}

const routineNames = (state: AppState) => savedRoutines(state).map((workout) => workout.routine);

describe('saving a workout as a routine', () => {
  it('keeps it under the name given, tidied', () => {
    const { state, push, legs } = history();
    saveAsRoutine(state, push.id, '  Push A  ');
    saveAsRoutine(state, legs.id, 'Leg day');
    expect(push.routine).toBe('Push A');
    expect(routineNames(state)).toEqual(['Leg day', 'Push A']); // listed by name
    expect(savedRoutines(state).map((workout) => workout.id)).toEqual([legs.id, push.id]);
  });

  it('needs a name, and cuts one that goes on too long', () => {
    const { state, push } = history();
    saveAsRoutine(state, push.id, '   ');
    expect('routine' in push).toBe(false);
    saveAsRoutine(state, push.id, 'x'.repeat(200));
    expect(push.routine).toHaveLength(ROUTINE_NAME_MAX);
  });

  it('has one routine per name: saving another workout under it moves the routine there', () => {
    const { state, push, pull } = history();
    saveAsRoutine(state, push.id, 'Upper');
    saveAsRoutine(state, pull.id, 'UPPER'); // capitals don't make it another routine
    expect('routine' in push).toBe(false);
    expect(pull.routine).toBe('UPPER');
    expect(routineNames(state)).toEqual(['UPPER']);
  });

  it('can be renamed by saving the same workout again', () => {
    const { state, push } = history();
    saveAsRoutine(state, push.id, 'Push');
    saveAsRoutine(state, push.id, 'Push day');
    expect(routineNames(state)).toEqual(['Push day']);
  });

  it('is only for finished workouts that exist', () => {
    const { state, running } = history();
    saveAsRoutine(state, running.id, 'Not yet');
    saveAsRoutine(state, 'no-such-workout', 'Nothing');
    expect(savedRoutines(state)).toEqual([]);
    expect('routine' in running).toBe(false);
  });

  it('is undone by removing it, and goes with the workout when that is deleted', () => {
    const { state, push, pull } = history();
    saveAsRoutine(state, push.id, 'Push');
    saveAsRoutine(state, pull.id, 'Pull');
    removeRoutine(state, push.id);
    expect('routine' in push).toBe(false);
    expect(state.workouts).toContain(push); // the workout itself stays
    deleteWorkout(state, pull.id);
    expect(savedRoutines(state)).toEqual([]);
  });

  it('survives an edit of the workout being called off', () => {
    const { state, push } = history();
    saveAsRoutine(state, push.id, 'Push');
    const snapshot = structuredClone(push);
    removeRoutine(state, push.id);
    restoreWorkout(state, snapshot);
    expect(routineNames(state)).toEqual(['Push']);
  });
});

describe('starting a routine', () => {
  it('repeats the workout it was saved from, under the routine\'s name', () => {
    const { state, push } = history();
    deleteWorkout(state, state.workouts.at(-1)!.id); // nothing running
    saveAsRoutine(state, push.id, 'Push A');
    const id = startRepeat(state, push.id, START + 20 * DAY, 'Push A')!;
    const started = state.workouts.find((workout) => workout.id === id)!;
    expect(started.name).toBe('Push A');
    expect(started.endedAt).toBeNull();
    expect(started.entries.map((entry) => [entry.exerciseName, entry.sets.length])).toEqual([['Bench Press (Barbell)', 2]]);
    expect(started.entries[0].sets.every((set) => !set.isDone && set.weight === null)).toBe(true);
    // The new workout is a workout, not a second routine.
    expect('routine' in started).toBe(false);
    expect(routineNames(state)).toEqual(['Push A']);
  });

  it('still carries the workout\'s own name when it is simply repeated', () => {
    const { state, push } = history();
    const id = startRepeat(state, push.id, START + 20 * DAY)!;
    expect(state.workouts.find((workout) => workout.id === id)!.name).toBe('Push');
  });
});

describe('a backup', () => {
  it('keeps routines', () => {
    const { state, push, legs } = history();
    saveAsRoutine(state, push.id, 'Push A');
    saveAsRoutine(state, legs.id, 'Leg day');
    const restored = parseBackup(exportBackup(state)).state;
    expect(routineNames(restored)).toEqual(['Leg day', 'Push A']);
    expect(restored.workouts).toEqual(state.workouts);
  });

  it('takes a routine name only from a finished workout, as text, within the limit', () => {
    const { state, push } = history();
    saveAsRoutine(state, push.id, 'Push');
    const file = JSON.parse(exportBackup(state)) as { data: { workouts: Record<string, unknown>[] } };
    const [first, second, third, running] = file.data.workouts;
    first.routine = `  ${'y'.repeat(200)}  `;
    second.routine = 42;
    third.routine = '   ';
    running.routine = 'On a workout still in progress';
    const restored = parseBackup(JSON.stringify(file)).state.workouts;
    expect(restored[0].routine).toBe('y'.repeat(ROUTINE_NAME_MAX));
    expect(restored.slice(1).map((workout) => 'routine' in workout)).toEqual([false, false, false]);
  });
});
