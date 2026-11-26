import type { AppState, Exercise, MuscleGroup, Workout } from './types';
import { activeWorkout, finishedWorkouts } from './workouts';

// What to do next: the routine that is due, and the saved-video exercises
// that would fit into a workout.

const DAY = 86_400_000;
/** How far back a workout still says something about the current routine. */
const ROUTINE_WINDOW = 56 * DAY;
/** Two sessions count as the same routine when they share at least this much of their exercises. */
const SAME_ROUTINE_OVERLAP = 0.5;

/** Names given by this app (or Strong) to a workout nobody named; they say nothing about what was trained. */
const GENERIC_NAME = /^((early )?morning|midday|lunch|afternoon|evening|night)?\s*workout$/i;

/** A workout the person keeps coming back to. */
export interface Routine {
  /** Its most recent session: what "do it again" repeats. */
  latest: Workout;
  /** How many times it was done in the window. */
  sessions: number;
}

const exerciseKeys = (workout: Workout) =>
  new Set(workout.entries.map((entry) => entry.exerciseId ?? entry.exerciseName.trim().toLowerCase()));

/** Shared exercises as a share of all the exercises in either workout. */
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  return shared / (a.size + b.size - shared);
}

const chosenName = (workout: Workout): string | null => {
  const name = workout.name.trim().toLowerCase();
  return name && !GENERIC_NAME.test(name) ? name : null;
};

/**
 * The finished workouts of the last eight weeks, sorted into routines.
 * Sessions belong together when they carry the same name someone chose, or —
 * since many workouts are never named — when they share half their exercises.
 * Something done only once is not a routine. Newest routine first.
 */
export function routines(state: AppState, now = Date.now()): Routine[] {
  const recent = finishedWorkouts(state).filter((workout) => workout.startedAt >= now - ROUTINE_WINDOW && workout.entries.length > 0);
  const groups: { latest: Workout; keys: Set<string>; sessions: number; position: number }[] = [];
  recent.forEach((workout, position) => {
    const keys = exerciseKeys(workout);
    const name = chosenName(workout);
    const group = groups.find((candidate) =>
      (name !== null && chosenName(candidate.latest) === name) || overlap(candidate.keys, keys) >= SAME_ROUTINE_OVERLAP);
    if (group) group.sessions += 1;
    else groups.push({ latest: workout, keys, sessions: 1, position });
  });
  const repeated = groups.filter((group) => group.sessions >= 2);
  // A routine skipped for twice as many workouts as there are routines has been
  // dropped (a change of programme), however recent it still looks on the calendar.
  const patience = Math.max(4, repeated.length * 2);
  return repeated
    .filter((group) => group.position < patience)
    .map(({ latest, sessions }) => ({ latest, sessions }));
}

/**
 * The routine gone longest without — what a rotation such as push / pull / legs
 * calls for next. Null while a workout is in progress, or when nothing has
 * been done twice yet.
 */
export function nextWorkout(state: AppState, now = Date.now()): Routine | null {
  if (activeWorkout(state)) return null;
  const found = routines(state, now);
  if (found.length === 0) return null;
  return found.reduce((due, routine) => (routine.latest.startedAt < due.latest.startedAt ? routine : due));
}

// Leg day, push day, pull day: a to-try exercise fits a workout that is
// largely about the same part of the body, even if not the very same muscle.
const REGIONS: Partial<Record<MuscleGroup, 'legs' | 'push' | 'pull'>> = {
  quads: 'legs', hamstrings: 'legs', glutes: 'legs', calves: 'legs',
  chest: 'push', shoulders: 'push', triceps: 'push',
  back: 'pull', biceps: 'pull', forearms: 'pull',
};
/** How much of a workout has to be about a body region for that region's exercises to fit it. */
const REGION_SHARE = 1 / 3;

/** Newest first; by name where that doesn't decide, so the order never depends on how storage hands records back. */
export const byNewest = (a: Exercise, b: Exercise) => b.createdAt - a.createdAt || a.name.localeCompare(b.name);

/**
 * Exercises still waiting to be tried that suit `workout`: it already trains
 * the same muscle, or at least a third of it is about the same part of the
 * body. Leaves out what is in the workout already. Newest first.
 */
export function toTryFor(state: AppState, workout: Workout): Exercise[] {
  const byId = new Map(state.exercises.map((exercise) => [exercise.id, exercise]));
  const present = workout.entries.flatMap((entry) => {
    const exercise = entry.exerciseId ? byId.get(entry.exerciseId) : undefined;
    return exercise ? [exercise] : [];
  });
  if (present.length === 0) return [];

  const included = new Set(present.map((exercise) => exercise.id));
  const muscles = new Set(present.map((exercise) => exercise.muscle));
  const share = (region: string) => present.filter((exercise) => REGIONS[exercise.muscle] === region).length / present.length;
  const fits = (exercise: Exercise) => {
    if (muscles.has(exercise.muscle)) return true;
    const region = REGIONS[exercise.muscle];
    return region !== undefined && share(region) >= REGION_SHARE;
  };
  return state.exercises
    .filter((exercise) => exercise.wantToTry && !included.has(exercise.id) && fits(exercise))
    .sort(byNewest);
}
