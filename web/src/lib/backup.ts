import { defaultSettings, EQUIPMENT, EXPORT_TARGETS, MUSCLE_GROUPS, normalizeSettings } from './types';
import type { AppState, BodyWeight, Exercise, ExerciseSuggestion, ExportState, SavedVideo, SetEntry, Workout, WorkoutEntry } from './types';
import { toDateInputValue } from './units';

// Everything lives in this browser's storage, so a file is the only way to
// keep a copy or to move to another browser or device.

const BACKUP_APP = 'gym-tracker-web';
const BACKUP_VERSION = 1;

/** Message is written for the person restoring the file. */
export class BackupError extends Error {}

export const backupFilename = (now = Date.now()) => `gym-tracker-backup-${toDateInputValue(now)}.json`;

export function exportBackup(state: AppState, now = Date.now()): string {
  // API keys stay out: a backup gets emailed, synced and left in download folders.
  const data: AppState = { ...state, settings: { ...state.settings, apiKeys: defaultSettings().apiKeys } };
  return JSON.stringify({ app: BACKUP_APP, version: BACKUP_VERSION, exportedAt: now, data });
}

/** What the app holds after restoring `backup` over `current`: everything from the file, plus this browser's own API keys. */
export function restoreBackup(current: AppState, backup: Backup): AppState {
  return { ...backup.state, settings: { ...backup.state.settings, apiKeys: current.settings.apiKeys } };
}

export interface Backup {
  state: AppState;
  exportedAt: number | null;
}

type Raw = Record<string, unknown>;

const damaged = (what: string) => new BackupError(`The backup file is damaged (${what}).`);
const isObject = (value: unknown): value is Raw => typeof value === 'object' && value !== null && !Array.isArray(value);

function object(value: unknown, what: string): Raw {
  if (!isObject(value)) throw damaged(what);
  return value;
}

function list<T>(value: unknown, what: string, read: (raw: Raw) => T): T[] {
  if (!Array.isArray(value)) throw damaged(what);
  return value.map((item) => read(object(item, what)));
}

function id(raw: Raw, what: string): string {
  if (typeof raw.id !== 'string' || !raw.id) throw damaged(what);
  return raw.id;
}

function time(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw damaged(what);
  return value;
}

const str = (value: unknown) => (typeof value === 'string' ? value : '');
const strOrNull = (value: unknown) => (typeof value === 'string' && value ? value : null);
const numOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const oneOf = <T extends string>(values: readonly T[], value: unknown, fallback: T): T =>
  (values as readonly unknown[]).includes(value) ? (value as T) : fallback;

const readExercise = (raw: Raw): Exercise => ({
  id: id(raw, 'exercise'),
  name: str(raw.name),
  muscle: oneOf(MUSCLE_GROUPS, raw.muscle, 'other'),
  equipment: oneOf(EQUIPMENT, raw.equipment, 'other'),
  isCustom: raw.isCustom === true,
  notes: str(raw.notes),
  videoURL: strOrNull(raw.videoURL),
  videoId: strOrNull(raw.videoId),
  wantToTry: raw.wantToTry === true,
  createdAt: numOrNull(raw.createdAt) ?? 0,
});

const readSet = (raw: Raw): SetEntry => ({
  id: id(raw, 'set'),
  weight: numOrNull(raw.weight),
  reps: numOrNull(raw.reps),
  rpe: numOrNull(raw.rpe),
  isWarmup: raw.isWarmup === true,
  isDone: raw.isDone === true,
});

const readEntry = (raw: Raw): WorkoutEntry => ({
  id: id(raw, 'workout exercise'),
  exerciseId: strOrNull(raw.exerciseId),
  exerciseName: str(raw.exerciseName),
  notes: str(raw.notes),
  sets: list(raw.sets, 'sets', readSet),
});

/** Where the workout stands with Strava and Garmin; absent when it was never queued or sent. */
function readExports(raw: unknown): Workout['exports'] {
  if (!isObject(raw)) return undefined;
  const found: NonNullable<Workout['exports']> = {};
  for (const target of EXPORT_TARGETS) {
    const item = raw[target];
    if (!isObject(item)) continue;
    const state: ExportState = { status: oneOf(['waiting', 'sent', 'failed'] as const, item.status, 'failed'), at: numOrNull(item.at) ?? 0 };
    if (typeof item.url === 'string' && /^https:\/\//.test(item.url)) state.url = item.url;
    if (typeof item.error === 'string' && item.error) state.error = item.error;
    found[target] = state;
  }
  return Object.keys(found).length > 0 ? found : undefined;
}

const readWorkout = (raw: Raw): Workout => {
  const workout: Workout = {
    id: id(raw, 'workout'),
    name: str(raw.name),
    startedAt: time(raw.startedAt, 'workout date'),
    endedAt: numOrNull(raw.endedAt),
    notes: str(raw.notes),
    entries: list(raw.entries, 'workout exercises', readEntry),
  };
  const exports = readExports(raw.exports);
  if (exports) workout.exports = exports;
  return workout;
};

const readBodyWeight = (raw: Raw): BodyWeight => {
  const kg = numOrNull(raw.kg);
  if (kg === null || kg <= 0) throw damaged('body weight');
  return { id: id(raw, 'body weight'), date: time(raw.date, 'body weight date'), kg };
};

const readSuggestion = (raw: Raw): ExerciseSuggestion => ({
  name: str(raw.name),
  libraryMatch: strOrNull(raw.libraryMatch),
  muscleGroup: strOrNull(raw.muscleGroup),
  equipment: strOrNull(raw.equipment),
  notes: strOrNull(raw.notes),
  setsReps: strOrNull(raw.setsReps),
});

const readVideo = (raw: Raw): SavedVideo => ({
  id: id(raw, 'video'),
  url: str(raw.url),
  title: str(raw.title),
  caption: str(raw.caption),
  thumbnail: strOrNull(raw.thumbnail),
  addedAt: time(raw.addedAt, 'video date'),
  analyzedAt: numOrNull(raw.analyzedAt),
  analyzedBy: strOrNull(raw.analyzedBy),
  suggestions: list(raw.suggestions ?? [], 'video suggestions', readSuggestion),
});

/** Reads a file made by `exportBackup`, checking every record on the way in. */
export function parseBackup(text: string): Backup {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
  }
  if (!isObject(parsed) || parsed.app !== BACKUP_APP || !isObject(parsed.data)) {
    throw new BackupError("That file isn't a Gym Tracker backup.");
  }
  if (typeof parsed.version !== 'number' || parsed.version > BACKUP_VERSION) {
    throw new BackupError('That backup was made by a newer version of Gym Tracker.');
  }
  const data = parsed.data;
  const workouts = list(data.workouts, 'workouts', readWorkout);
  // Only one workout can be in progress; a file claiming more gets the extra ones closed.
  let seenActive = false;
  for (const workout of workouts.sort((a, b) => b.startedAt - a.startedAt)) {
    if (workout.endedAt !== null) continue;
    if (seenActive) workout.endedAt = workout.startedAt;
    seenActive = true;
  }
  return {
    exportedAt: numOrNull(parsed.exportedAt),
    state: {
      exercises: list(data.exercises, 'exercises', readExercise),
      workouts,
      bodyWeights: list(data.bodyWeights, 'body weights', readBodyWeight),
      videos: list(data.videos, 'videos', readVideo),
      // Keys are never taken from a file, whatever it claims to hold.
      settings: { ...normalizeSettings(data.settings), apiKeys: defaultSettings().apiKeys },
      libraryVersion: numOrNull(data.libraryVersion) ?? 0,
    },
  };
}
