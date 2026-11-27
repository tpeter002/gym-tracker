import { uid } from './ids';
import { LIBRARY, LIBRARY_VERSION } from './library';
import type { LibraryItem } from './library';
import { equipmentTitle, muscleTitle } from './types';
import type { AppState, Equipment, Exercise, MuscleGroup } from './types';

/**
 * Key used to recognise the same exercise across imports and AI results:
 * "Bench Press (Barbell)" and "bench press barbell" compare equal.
 */
export function normalizeName(name: string): string {
  return name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean).join(' ');
}

export const exerciseSubtitle = (exercise: Exercise) =>
  `${muscleTitle(exercise.muscle)} · ${equipmentTitle(exercise.equipment)}`;

export const byName = (a: Exercise, b: Exercise) => a.name.localeCompare(b.name, 'en');

export function findByName(state: AppState, name: string): Exercise | undefined {
  const key = normalizeName(name);
  return state.exercises.find((exercise) => normalizeName(exercise.name) === key);
}

export function newExercise(name: string, muscle: MuscleGroup, equipment: Equipment, isCustom: boolean): Exercise {
  return {
    id: uid(), name, muscle, equipment, isCustom,
    notes: '', videoURL: null, videoId: null, wantToTry: false, createdAt: Date.now(),
  };
}

/**
 * Adds the built-in exercises this database hasn't been offered yet: all of
 * them when it is new, otherwise only the ones the list has gained since. A
 * built-in you deleted or renamed is not offered twice, so it stays gone.
 */
export function seedLibrary(state: AppState, library: readonly LibraryItem[] = LIBRARY, version = LIBRARY_VERSION): void {
  // An empty list means the database is new, whatever version it claims.
  const isNew = state.exercises.length === 0;
  if (!isNew && state.libraryVersion >= version) return;
  const known = new Set(state.exercises.map((exercise) => normalizeName(exercise.name)));
  const ids = new Set(state.exercises.map((exercise) => exercise.id));
  for (const item of library) {
    const key = normalizeName(item.name);
    const id = libraryId(item.name);
    if (known.has(key) || ids.has(id) || (!isNew && item.since <= state.libraryVersion)) continue;
    known.add(key);
    state.exercises.push({ ...newExercise(item.name, item.muscle, item.equipment, false), id });
  }
  state.libraryVersion = version;
}

/**
 * A built-in exercise has the same id wherever it is added. Two devices of one
 * account may each add the library before they have heard from the other;
 * with ids of their own every exercise would then be there twice.
 */
export const libraryId = (name: string) => `lib_${normalizeName(name).replace(/[^a-z0-9]+/g, '_')}`;

export interface ExerciseFields {
  name: string;
  muscle: MuscleGroup;
  equipment: Equipment;
  notes: string;
  videoURL: string;
}

/** Creates a custom exercise, or updates the one with `id`. Returns its id. */
export function saveExercise(state: AppState, fields: ExerciseFields, id?: string): string {
  const name = fields.name.trim();
  let exercise = id ? state.exercises.find((candidate) => candidate.id === id) : undefined;
  if (exercise) {
    exercise.name = name;
    exercise.muscle = fields.muscle;
    exercise.equipment = fields.equipment;
    for (const workout of state.workouts) {
      for (const entry of workout.entries) {
        if (entry.exerciseId !== exercise.id) continue;
        // History rows keep their own copy of the name; keep them in step.
        entry.exerciseName = name;
        // No longer done with dumbbells: "both together" would go on halving its
        // weights, with the button that says otherwise gone from the screen.
        if (exercise.equipment !== 'dumbbell') delete entry.bothDumbbells;
      }
    }
  } else {
    exercise = newExercise(name, fields.muscle, fields.equipment, true);
    state.exercises.push(exercise);
  }
  exercise.notes = fields.notes.trim();
  exercise.videoURL = fields.videoURL.trim() || null;
  return exercise.id;
}

/** Past workouts keep their sets and the name; only the link to the exercise goes. */
export function deleteExercise(state: AppState, id: string): void {
  state.exercises = state.exercises.filter((exercise) => exercise.id !== id);
  for (const workout of state.workouts) {
    for (const entry of workout.entries) {
      if (entry.exerciseId === id) entry.exerciseId = null;
    }
  }
}

const SEARCH_ALIASES: Record<string, string> = { db: 'dumbbell', bb: 'barbell', kb: 'kettlebell', bw: 'bodyweight' };

/** Search used by both the Exercises tab and the in-workout picker. */
export function searchExercises(exercises: readonly Exercise[], query: string, muscle: MuscleGroup | null): Exercise[] {
  const tokens = normalizeName(query).split(' ').filter(Boolean).map((token) => SEARCH_ALIASES[token] ?? token);
  const phrase = tokens.join(' ');
  const scoped = muscle ? exercises.filter((exercise) => exercise.muscle === muscle) : [...exercises];
  if (tokens.length === 0) return scoped.sort(byName);

  const ranked: { exercise: Exercise; rank: number }[] = [];
  for (const exercise of scoped) {
    const name = normalizeName(exercise.name);
    const haystack = `${name} ${muscleTitle(exercise.muscle)} ${equipmentTitle(exercise.equipment)}`.toLowerCase();
    if (!tokens.every((token) => haystack.includes(token))) continue;
    ranked.push({ exercise, rank: name.startsWith(phrase) ? 0 : name.includes(phrase) ? 1 : 2 });
  }
  return ranked.sort((a, b) => a.rank - b.rank || byName(a.exercise, b.exercise)).map((item) => item.exercise);
}

// Order matters: "Leg Curl" must hit hamstrings before "curl" hits biceps.
const MUSCLE_RULES: [MuscleGroup, string[]][] = [
  ['shoulders', ['overhead press', 'shoulder', 'lateral raise', 'front raise', 'reverse fly', 'rear delt',
    'face pull', 'arnold', 'upright row', 'military']],
  ['hamstrings', ['leg curl', 'hamstring', 'romanian', 'stiff leg', 'good morning', 'nordic']],
  ['glutes', ['hip thrust', 'glute', 'abduct', 'adduct', 'pull through']],
  ['quads', ['squat', 'leg press', 'leg extension', 'lunge', 'step up']],
  ['calves', ['calf', 'tibialis']],
  ['forearms', ['wrist', 'forearm', 'farmer', 'dead hang']],
  ['cardio', ['running', 'treadmill', 'cycling', 'bike', 'elliptical', 'rowing', 'stair', 'jump rope', 'walking']],
  ['triceps', ['tricep', 'skull', 'pushdown', 'close grip bench', 'dip']],
  ['chest', ['bench', 'chest', 'pec', 'fly', 'push up', 'pushup', 'crossover']],
  ['back', ['row', 'pull up', 'pullup', 'chin up', 'pulldown', 'deadlift', 'back extension', 'shrug', 'rack pull']],
  ['biceps', ['curl']],
  ['core', ['crunch', 'plank', 'sit up', 'leg raise', 'knee raise', 'twist', 'rollout', 'woodchop', 'pallof', 'ab ']],
];

/** Best-effort grouping for exercises that aren't in the built-in library. */
export function guessMuscle(name: string): MuscleGroup {
  // Normalised, so "Pull-Up" and "Stiff-Leg Deadlift" read like the keywords, which are written with spaces.
  const text = `${normalizeName(name)} `;
  return MUSCLE_RULES.find(([, keywords]) => keywords.some((keyword) => text.includes(keyword)))?.[0] ?? 'other';
}

/** Strong puts the equipment in parentheses: "Bench Press (Barbell)". */
export function guessEquipment(name: string): Equipment {
  const open = name.lastIndexOf('(');
  const close = name.lastIndexOf(')');
  if (open < 0 || close < open) return 'other';
  const hint = name.slice(open + 1, close).toLowerCase();
  if (hint.includes('smith') || hint.includes('machine') || hint.includes('assisted')) return 'machine';
  if (hint.includes('barbell') || hint.includes('ez bar')) return 'barbell';
  if (hint.includes('dumbbell')) return 'dumbbell';
  if (hint.includes('cable')) return 'cable';
  if (hint.includes('kettlebell')) return 'kettlebell';
  if (hint.includes('band')) return 'band';
  if (hint.includes('bodyweight')) return 'bodyweight';
  return 'other';
}
