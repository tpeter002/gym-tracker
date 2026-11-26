// The analyzer (server/analyzer.py) answers with these same muscle and equipment values.
export const MUSCLE_GROUPS = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms', 'core',
  'quads', 'hamstrings', 'glutes', 'calves', 'fullBody', 'cardio', 'other',
] as const;
export type MuscleGroup = (typeof MUSCLE_GROUPS)[number];

export const EQUIPMENT = [
  'barbell', 'dumbbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'band', 'other',
] as const;
export type Equipment = (typeof EQUIPMENT)[number];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

export function muscleTitle(muscle: MuscleGroup): string {
  if (muscle === 'fullBody') return 'Full Body';
  if (muscle === 'glutes') return 'Glutes & Hips';
  return capitalize(muscle);
}

export function equipmentTitle(equipment: Equipment): string {
  return capitalize(equipment);
}

export type WeightUnit = 'kg' | 'lb';
export type EffortScale = 'rpe' | 'rir';

// All times are milliseconds since the epoch.

export interface Exercise {
  id: string;
  name: string;
  muscle: MuscleGroup;
  equipment: Equipment;
  isCustom: boolean;
  notes: string;
  /** Link to the clip this exercise came from, if any. */
  videoURL: string | null;
  /** The saved video it was added from; null once that video is deleted. */
  videoId: string | null;
  /** Saved from a video and not performed yet — surfaced when picking exercises. */
  wantToTry: boolean;
  createdAt: number;
}

export interface SetEntry {
  id: string;
  /** Kilograms; null for bodyweight. */
  weight: number | null;
  reps: number | null;
  /** Effort is stored as RPE whichever scale is shown. */
  rpe: number | null;
  isWarmup: boolean;
  isDone: boolean;
}

/** One exercise performed inside one workout. */
export interface WorkoutEntry {
  id: string;
  /** null once the exercise has been deleted. */
  exerciseId: string | null;
  /** Kept so history stays readable if the exercise is later deleted. */
  exerciseName: string;
  notes: string;
  sets: SetEntry[];
}

export interface Workout {
  id: string;
  name: string;
  startedAt: number;
  /** null while the workout is in progress. */
  endedAt: number | null;
  notes: string;
  entries: WorkoutEntry[];
}

export interface BodyWeight {
  id: string;
  date: number;
  kg: number;
}

/** One exercise the analyzer found in a video. */
export interface ExerciseSuggestion {
  name: string;
  /** Exact name of a library exercise when the analyzer recognised one. */
  libraryMatch: string | null;
  muscleGroup: string | null;
  equipment: string | null;
  /** Short how-to, in the analyzer's words. */
  notes: string | null;
  /** Sets × reps when the video prescribes them. */
  setsReps: string | null;
}

/** A workout clip saved from Instagram, TikTok, YouTube… */
export interface SavedVideo {
  id: string;
  url: string;
  title: string;
  caption: string;
  /** A small image as a data: URL, from the analyzer. */
  thumbnail: string | null;
  addedAt: number;
  analyzedAt: number | null;
  /** Kept so reopening the video doesn't cost another AI call. */
  suggestions: ExerciseSuggestion[];
}

export interface Settings {
  unit: WeightUnit;
  effort: EffortScale;
  /** Empty means the analyzer is the server this page came from. */
  analyzerURL: string;
}

export interface AppState {
  exercises: Exercise[];
  workouts: Workout[];
  bodyWeights: BodyWeight[];
  videos: SavedVideo[];
  settings: Settings;
  /** Version of the built-in exercise list that has been added so far. */
  libraryVersion: number;
}

export const DEFAULT_SETTINGS: Settings = { unit: 'kg', effort: 'rpe', analyzerURL: '' };

export function emptyState(): AppState {
  return {
    exercises: [],
    workouts: [],
    bodyWeights: [],
    videos: [],
    settings: { ...DEFAULT_SETTINGS },
    libraryVersion: 0,
  };
}
