import { uid } from './ids';
import type { AppState, SetEntry, Workout, WorkoutEntry } from './types';

// Everything that changes a workout's shape lives here. The functions change
// the state they are given; the store runs them on a draft (see store.ts).

export function defaultWorkoutName(at: number = Date.now()): string {
  const hour = new Date(at).getHours();
  if (hour >= 5 && hour < 11) return 'Morning Workout';
  if (hour >= 11 && hour < 14) return 'Midday Workout';
  if (hour >= 14 && hour < 18) return 'Afternoon Workout';
  if (hour >= 18 && hour < 23) return 'Evening Workout';
  return 'Night Workout';
}

export const activeWorkout = (state: AppState) => state.workouts.find((workout) => workout.endedAt === null);

/** Finished workouts, newest first. */
export const finishedWorkouts = (state: AppState) =>
  state.workouts.filter((workout) => workout.endedAt !== null).sort((a, b) => b.startedAt - a.startedAt);

const blankSet = (isWarmup = false): SetEntry =>
  ({ id: uid(), weight: null, reps: null, rpe: null, isWarmup, isDone: false });

const findWorkout = (state: AppState, id: string) => state.workouts.find((workout) => workout.id === id);
const findEntry = (state: AppState, workoutId: string, entryId: string) =>
  findWorkout(state, workoutId)?.entries.find((entry) => entry.id === entryId);

export function startEmpty(state: AppState, now = Date.now()): string {
  const workout: Workout = {
    id: uid(), name: defaultWorkoutName(now), startedAt: now, endedAt: null, notes: '', entries: [],
  };
  state.workouts.push(workout);
  return workout.id;
}

/**
 * Same exercises and set layout as the source. Values are left empty on
 * purpose: each row shows last time's numbers and takes them over when ticked.
 */
export function startRepeat(state: AppState, sourceId: string, now = Date.now()): string | null {
  const source = findWorkout(state, sourceId);
  if (!source) return null;
  const names = new Map(state.exercises.map((exercise) => [exercise.id, exercise.name]));
  const entries: WorkoutEntry[] = [];
  for (const old of source.entries) {
    // An exercise deleted since then can't be logged against.
    const name = old.exerciseId ? names.get(old.exerciseId) : undefined;
    if (name === undefined) continue;
    entries.push({
      id: uid(), exerciseId: old.exerciseId, exerciseName: name, notes: '',
      sets: old.sets.map((set) => blankSet(set.isWarmup)),
    });
  }
  const workout: Workout = { id: uid(), name: source.name, startedAt: now, endedAt: null, notes: '', entries };
  state.workouts.push(workout);
  return workout.id;
}

export function addExercise(state: AppState, workoutId: string, exerciseId: string): void {
  const workout = findWorkout(state, workoutId);
  const exercise = state.exercises.find((candidate) => candidate.id === exerciseId);
  if (!workout || !exercise) return;
  // Mirror last time's set count so the "previous" column lines up.
  const previous = previousSets(state.workouts, exerciseId);
  const sets = previous.length > 0
    ? previous.map((set) => blankSet(set.isWarmup))
    : [blankSet(), blankSet(), blankSet()];
  workout.entries.push({ id: uid(), exerciseId, exerciseName: exercise.name, notes: '', sets });
}

export function addSet(state: AppState, workoutId: string, entryId: string): void {
  findEntry(state, workoutId, entryId)?.sets.push(blankSet());
}

export function updateSet(state: AppState, workoutId: string, entryId: string, setId: string, patch: Partial<SetEntry>): void {
  const set = findEntry(state, workoutId, entryId)?.sets.find((candidate) => candidate.id === setId);
  if (set) Object.assign(set, patch);
}

export function deleteSet(state: AppState, workoutId: string, entryId: string, setId: string): void {
  const entry = findEntry(state, workoutId, entryId);
  if (entry) entry.sets = entry.sets.filter((set) => set.id !== setId);
}

export function removeEntry(state: AppState, workoutId: string, entryId: string): void {
  const workout = findWorkout(state, workoutId);
  if (workout) workout.entries = workout.entries.filter((entry) => entry.id !== entryId);
}

/** Swaps an exercise with its neighbour (`offset` −1 = up, +1 = down). */
export function moveEntry(state: AppState, workoutId: string, entryId: string, offset: -1 | 1): void {
  const entries = findWorkout(state, workoutId)?.entries;
  if (!entries) return;
  const index = entries.findIndex((entry) => entry.id === entryId);
  const target = index + offset;
  if (index < 0 || target < 0 || target >= entries.length) return;
  [entries[index], entries[target]] = [entries[target], entries[index]];
}

/** Completed sets from the most recent finished workout containing the exercise. */
export function previousSets(workouts: readonly Workout[], exerciseId: string): SetEntry[] {
  let latest: { startedAt: number; entry: WorkoutEntry } | null = null;
  for (const workout of workouts) {
    if (workout.endedAt === null) continue;
    for (const entry of workout.entries) {
      if (entry.exerciseId !== exerciseId || !entry.sets.some((set) => set.isDone)) continue;
      if (!latest || workout.startedAt > latest.startedAt) latest = { startedAt: workout.startedAt, entry };
    }
  }
  return latest ? latest.entry.sets.filter((set) => set.isDone) : [];
}

export const hasCompletedSets = (workout: Workout) =>
  workout.entries.some((entry) => entry.sets.some((set) => set.isDone));

export const hasOpenSets = (workout: Workout) =>
  workout.entries.some((entry) => entry.sets.some((set) => !set.isDone));

/** Drops unticked sets and empty exercises, then closes the workout. */
export function finishWorkout(state: AppState, workoutId: string, endedAt = Date.now()): void {
  const workout = findWorkout(state, workoutId);
  if (!workout) return;
  for (const entry of workout.entries) entry.sets = entry.sets.filter((set) => set.isDone);
  workout.entries = workout.entries.filter((entry) => entry.sets.length > 0);

  const performed = new Set(workout.entries.map((entry) => entry.exerciseId));
  for (const exercise of state.exercises) {
    if (exercise.wantToTry && performed.has(exercise.id)) exercise.wantToTry = false;
  }
  if (!workout.name.trim()) workout.name = defaultWorkoutName(workout.startedAt);
  workout.endedAt = endedAt;
}

export function deleteWorkout(state: AppState, workoutId: string): void {
  state.workouts = state.workouts.filter((workout) => workout.id !== workoutId);
}

// MARK: Reading

export const doneSets = (workout: Workout) =>
  workout.entries.flatMap((entry) => entry.sets).filter((set) => set.isDone);

/** Total kilograms moved, warm-ups excluded. */
export const volumeKg = (workout: Workout) =>
  doneSets(workout).filter((set) => !set.isWarmup).reduce((sum, set) => sum + (set.weight ?? 0) * (set.reps ?? 0), 0);

export const durationSeconds = (workout: Workout, now = Date.now()) =>
  ((workout.endedAt ?? now) - workout.startedAt) / 1000;

/** Working sets are numbered 1, 2, 3…; warm-ups show "W" and don't count. */
export function rowLabels(sets: readonly SetEntry[]): string[] {
  let number = 0;
  return sets.map((set) => (set.isWarmup ? 'W' : String(++number)));
}

/** Epley estimate; only meaningful for weighted sets. */
export function estimatedOneRepMax(set: SetEntry): number | null {
  if (!set.weight || !set.reps || set.weight <= 0 || set.reps <= 0) return null;
  return set.reps === 1 ? set.weight : set.weight * (1 + set.reps / 30);
}

export interface Session {
  workout: Workout;
  entry: WorkoutEntry;
}

/** Every finished session of an exercise with at least one completed set, newest first. */
export function sessionsFor(workouts: readonly Workout[], exerciseId: string): Session[] {
  const sessions: Session[] = [];
  for (const workout of workouts) {
    if (workout.endedAt === null) continue;
    for (const entry of workout.entries) {
      if (entry.exerciseId === exerciseId && entry.sets.some((set) => set.isDone)) sessions.push({ workout, entry });
    }
  }
  return sessions.sort((a, b) => b.workout.startedAt - a.workout.startedAt);
}
