import { describe, expect, it } from 'vitest';
import { guessEquipment, guessMuscle, saveExercise, seedLibrary } from '../../src/lib/exercises';
import { LIBRARY, LIBRARY_VERSION } from '../../src/lib/library';
import type { LibraryItem } from '../../src/lib/library';
import { EQUIPMENT, emptyState, MUSCLE_GROUPS } from '../../src/lib/types';
import type { AppState } from '../../src/lib/types';
import { addExercise, finishWorkout, setBothDumbbells, startEmpty, volumeKg } from '../../src/lib/workouts';

// The exercise list: the built-in library, what is added to it, and editing an exercise.

const item = (name: string, since = 1): LibraryItem => ({ name, muscle: 'chest', equipment: 'barbell', since });
const names = (state: AppState) => state.exercises.map((exercise) => exercise.name);

describe('the built-in library', () => {
  it('is a table of known muscles and equipment, each name once', () => {
    expect(LIBRARY.length).toBeGreaterThan(190);
    for (const entry of LIBRARY) {
      expect(MUSCLE_GROUPS, entry.name).toContain(entry.muscle);
      expect(EQUIPMENT, entry.name).toContain(entry.equipment);
      expect(entry.name.trim(), entry.name).toBe(entry.name);
      expect(entry.since, entry.name).toBeGreaterThanOrEqual(1);
      expect(entry.since, entry.name).toBeLessThanOrEqual(LIBRARY_VERSION);
    }
    expect(new Set(LIBRARY.map((entry) => entry.name.toLowerCase())).size).toBe(LIBRARY.length);
  });

  it('fills a new database with everything', () => {
    const state = emptyState();
    seedLibrary(state);
    expect(state.exercises).toHaveLength(LIBRARY.length);
    expect(state.libraryVersion).toBe(LIBRARY_VERSION);
    expect(state.exercises.every((exercise) => !exercise.isCustom && !exercise.wantToTry)).toBe(true);
  });

  it('adds nothing when the database has seen this version of the list', () => {
    const state = emptyState();
    seedLibrary(state);
    state.exercises = state.exercises.filter((exercise) => exercise.name !== 'Bench Press (Barbell)'); // deleted by hand
    seedLibrary(state);
    expect(names(state)).not.toContain('Bench Press (Barbell)');
  });

  it('offers only what the list has gained when it grows, so a deleted built-in stays deleted', () => {
    const first = [item('Bench Press (Barbell)'), item('Squat (Barbell)'), item('Deadlift (Barbell)')];
    const state = emptyState();
    seedLibrary(state, first, 1);
    state.exercises = state.exercises.filter((exercise) => exercise.name !== 'Squat (Barbell)'); // deleted
    state.exercises.find((exercise) => exercise.name === 'Deadlift (Barbell)')!.name = 'Conventional Deadlift'; // renamed

    const second = [...first, item('Zercher Squat (Barbell)', 2), item('Bench Press (Barbell)', 2)];
    seedLibrary(state, second, 2);

    // The addition arrives; the deleted and the renamed do not come back; what is there already is not doubled.
    expect(names(state).sort()).toEqual(['Bench Press (Barbell)', 'Conventional Deadlift', 'Zercher Squat (Barbell)']);
    expect(state.libraryVersion).toBe(2);
  });

  it('gives a database that was emptied the whole list again, whatever version it claims', () => {
    const state = emptyState();
    state.libraryVersion = 2;
    seedLibrary(state, [item('Bench Press (Barbell)'), item('Zercher Squat (Barbell)', 2)], 2);
    expect(names(state)).toEqual(['Bench Press (Barbell)', 'Zercher Squat (Barbell)']);
  });

  it('fills in what a database from before the list was versioned is missing', () => {
    const state = emptyState();
    seedLibrary(state, [item('Bench Press (Barbell)')], 1);
    state.libraryVersion = 0; // as stored by a version that didn't keep one
    seedLibrary(state, [item('Bench Press (Barbell)'), item('Squat (Barbell)')], 1);
    expect(names(state)).toEqual(['Bench Press (Barbell)', 'Squat (Barbell)']);
  });
});

describe('guessing what an unknown exercise trains', () => {
  it.each([
    ['Pull-Up', 'back'], ['Chin-Up', 'back'], ['Push-Up', 'chest'], ['Sit-Up', 'core'], ['Step-Up (Dumbbell)', 'quads'],
    ['Stiff-Leg Deadlift (Barbell)', 'hamstrings'], ['Close-Grip Bench Press', 'triceps'],
    ['pull_up', 'back'], ['PULL UP', 'back'],
    // As before, for names written with spaces.
    ['Seated Leg Curl (Machine)', 'hamstrings'], ['Hammer Curl (Dumbbell)', 'biceps'], ['Upright Row (Barbell)', 'shoulders'],
    ['Ab Wheel Rollout', 'core'], ['Something Nobody Has Heard Of', 'other'], ['', 'other'],
  ])('%s → %s', (name, muscle) => {
    expect(guessMuscle(name)).toBe(muscle);
  });

  it('takes the equipment from the parentheses', () => {
    expect(guessEquipment('Bench Press (Smith Machine)')).toBe('machine');
    expect(guessEquipment('Curl (EZ Bar)')).toBe('barbell');
    expect(guessEquipment('Pull Up')).toBe('other');
  });
});

describe('editing an exercise', () => {
  function withDumbbellSession(): { state: AppState; id: string } {
    const state = emptyState();
    seedLibrary(state);
    const id = state.exercises.find((exercise) => exercise.name === 'Bench Press (Dumbbell)')!.id;
    const workoutId = startEmpty(state, 1_795_000_000_000);
    addExercise(state, workoutId, id);
    const entry = state.workouts[0].entries[0];
    entry.sets = [{ id: 's1', weight: 60, reps: 10, rpe: null, isWarmup: false, isDone: true }];
    setBothDumbbells(state, workoutId, entry.id, true);
    finishWorkout(state, workoutId, 1_795_000_360_000);
    return { state, id };
  }
  const fields = { name: 'Bench Press (Dumbbell)', muscle: 'chest', equipment: 'dumbbell', notes: '', videoURL: '' } as const;

  it('keeps how its dumbbells were counted while it stays a dumbbell exercise', () => {
    const { state, id } = withDumbbellSession();
    saveExercise(state, { ...fields, name: 'Flat Dumbbell Press', notes: 'Elbows at 45°.' }, id);
    const entry = state.workouts[0].entries[0];
    expect(entry.exerciseName).toBe('Flat Dumbbell Press');
    expect(entry.bothDumbbells).toBe(true);
    expect(volumeKg(state.workouts[0])).toBe(30 * 10);
  });

  it('stops halving its weights once it is no longer done with dumbbells', () => {
    const { state, id } = withDumbbellSession();
    saveExercise(state, { ...fields, equipment: 'barbell' }, id);
    const entry = state.workouts[0].entries[0];
    // The button that could say "one dumbbell" is gone with the dumbbells, so the marker must be too.
    expect('bothDumbbells' in entry).toBe(false);
    expect(volumeKg(state.workouts[0])).toBe(60 * 10);
  });
});
