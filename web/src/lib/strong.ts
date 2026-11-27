import { guessEquipment, guessMuscle, newExercise, normalizeName } from './exercises';
import { uid } from './ids';
import type { AppState, Exercise, WeightUnit } from './types';
import { parseDecimal, toKg } from './units';

// Workout history as read from a Strong export, before it touches the database.

export interface ParsedSet {
  weight: number | null;
  reps: number | null;
  rpe: number | null;
  isWarmup: boolean;
}

export interface ParsedExercise {
  name: string;
  notes: string;
  sets: ParsedSet[];
}

export interface ParsedWorkout {
  date: number;
  name: string;
  /** Seconds. */
  duration: number | null;
  notes: string;
  exercises: ParsedExercise[];
}

export interface StrongImport {
  workouts: ParsedWorkout[];
  /** Set when the header names the unit ("Weight (kg)"); older exports don't. */
  headerUnit: WeightUnit | null;
  skippedRows: number;
}

export const setCount = (data: StrongImport) =>
  data.workouts.reduce((sum, workout) => sum + workout.exercises.reduce((inner, exercise) => inner + exercise.sets.length, 0), 0);

export const exerciseNames = (data: StrongImport) =>
  new Set(data.workouts.flatMap((workout) => workout.exercises.map((exercise) => exercise.name)));

/** Message is written for the person importing the file. */
export class StrongFormatError extends Error {}

/**
 * Reads both Strong CSV layouts: the older comma-separated one
 * (`Date,Workout Name,Duration,Exercise Name,Set Order,Weight,Reps,…,RPE`) and the
 * newer semicolon-separated one (`Workout #;Date;…;Duration (sec);…;Weight (kg);…`).
 */
export function parseStrongCSV(input: string): StrongImport {
  const text = input.startsWith('\uFEFF') ? input.slice(1) : input; // a byte-order mark, as Excel writes
  const firstLine = text.split(/\r\n|\n|\r/).find((line) => line.length > 0);
  if (firstLine === undefined) throw new StrongFormatError('The file is empty.');
  const count = (character: string) => firstLine.split(character).length - 1;
  const rows = csvRecords(text, count(';') > count(',') ? ';' : ',');
  const header = (rows.shift() ?? []).map((cell) => cell.trim().toLowerCase());
  const column = (matches: (name: string) => boolean) => {
    const index = header.findIndex(matches);
    return index < 0 ? null : index;
  };

  const dateCol = column((name) => name === 'date');
  const exerciseCol = column((name) => name === 'exercise name');
  const setCol = column((name) => name === 'set order');
  const weightCol = column((name) => name.startsWith('weight'));
  const repsCol = column((name) => name === 'reps');
  const required: [string, number | null][] = [
    ['Date', dateCol], ['Exercise Name', exerciseCol], ['Set Order', setCol], ['Weight', weightCol], ['Reps', repsCol],
  ];
  const missing = required.filter(([, index]) => index === null).map(([name]) => name);
  if (dateCol === null || exerciseCol === null || setCol === null || weightCol === null || repsCol === null) {
    throw new StrongFormatError(`This doesn't look like a Strong export — missing column(s): ${missing.join(', ')}.`);
  }
  const numberCol = column((name) => name === 'workout #');
  const nameCol = column((name) => name === 'workout name');
  const durationCol = column((name) => name.startsWith('duration') || name.startsWith('workout duration'));
  const rpeCol = column((name) => name === 'rpe');
  const secondsCol = column((name) => name === 'seconds');
  const notesCol = column((name) => name === 'notes');
  const workoutNotesCol = column((name) => name === 'workout notes');

  const result: StrongImport = { workouts: [], headerUnit: null, skippedRows: 0 };
  if (header[weightCol].includes('kg')) result.headerUnit = 'kg';
  if (header[weightCol].includes('lb')) result.headerUnit = 'lb';

  const workoutByKey = new Map<string, ParsedWorkout>();
  for (const row of rows) {
    const cell = (index: number | null) => (index !== null && index < row.length ? row[index].trim() : '');
    const date = parseStrongDate(cell(dateCol));
    const exerciseName = cell(exerciseCol);
    if (date === null || !exerciseName) {
      result.skippedRows += 1;
      continue;
    }

    const workoutName = cell(nameCol);
    // The export's own workout number where it has one; a row without it must
    // not be lumped together with every other such row.
    const key = cell(numberCol) || `${cell(dateCol)}|${workoutName}`;
    let workout = workoutByKey.get(key);
    if (!workout) {
      workout = {
        date,
        name: workoutName || 'Workout',
        duration: parseStrongDuration(cell(durationCol)),
        notes: cell(workoutNotesCol),
        exercises: [],
      };
      workoutByKey.set(key, workout);
      result.workouts.push(workout);
    }

    // Consecutive rows of the same exercise form one block; the same
    // exercise appearing again later in the workout starts a new one.
    let exercise = workout.exercises.at(-1);
    if (!exercise || exercise.name !== exerciseName) {
      exercise = { name: exerciseName, notes: '', sets: [] };
      workout.exercises.push(exercise);
    }

    const setOrder = cell(setCol).toLowerCase();
    if (setOrder === 'note') {
      exercise.notes = cell(notesCol);
      continue;
    }
    if (setOrder.includes('rest')) continue;

    const positive = (value: number | null) => (value !== null && value > 0 ? value : null);
    const weight = positive(parseDecimal(cell(weightCol)));
    const repsValue = positive(parseDecimal(cell(repsCol)));
    let reps = repsValue === null ? null : positive(Math.round(repsValue));
    // Timed exercises (planks…) carry seconds instead of reps.
    const seconds = positive(parseDecimal(cell(secondsCol)));
    if (reps === null && seconds !== null) reps = Math.round(seconds);
    if (weight === null && reps === null) {
      result.skippedRows += 1;
      continue;
    }
    const rpeValue = parseDecimal(cell(rpeCol));
    const rpe = rpeValue !== null && rpeValue >= 1 && rpeValue <= 10 ? rpeValue : null;
    exercise.sets.push({ weight, reps, rpe, isWarmup: setOrder === 'w' });
  }

  for (const workout of result.workouts) {
    workout.exercises = workout.exercises.filter((exercise) => exercise.sets.length > 0);
  }
  result.workouts = result.workouts
    .filter((workout) => workout.exercises.length > 0)
    .sort((a, b) => a.date - b.date);
  return result;
}

/** "2024-05-02 17:45:11", in local time. */
function parseStrongDate(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  const date = new Date(year, month - 1, day, hour, minute, second);
  // The constructor rolls impossible dates over (month 13 → next January) instead of failing.
  return date.getMonth() === month - 1 && date.getDate() === day ? date.getTime() : null;
}

/** "1h 5m", "45m", "30s" or plain seconds. */
export function parseStrongDuration(raw: string): number | null {
  const text = raw.trim().toLowerCase();
  if (!text) return null;
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text) > 0 ? Number(text) : null;
  const factors: Record<string, number> = { h: 3600, m: 60, s: 1 };
  let total = 0;
  for (const [, digits, unit] of text.matchAll(/(\d+)\s*([hms])/g)) total += Number(digits) * factors[unit];
  return total > 0 ? total : null;
}

/**
 * RFC 4180 record splitter: quoted fields may contain the delimiter,
 * line breaks and doubled quotes.
 */
export function csvRecords(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (inQuotes) {
      if (character !== '"') {
        field += character;
      } else if (text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = false;
      }
    } else if (character === '"') {
      inQuotes = true;
    } else if (character === delimiter) {
      row.push(field);
      field = '';
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1;
      row.push(field);
      field = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
    } else {
      field += character;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export interface ImportSummary {
  workouts: number;
  sets: number;
  newExercises: number;
  alreadyImported: number;
}

/** Writes a parsed Strong export into the state. `unit` is the unit the file's weights are in. */
export function applyStrongImport(state: AppState, data: StrongImport, unit: WeightUnit): ImportSummary {
  const summary: ImportSummary = { workouts: 0, sets: 0, newExercises: 0, alreadyImported: 0 };
  const exercisesByKey = new Map<string, Exercise>();
  for (const exercise of state.exercises) {
    const key = normalizeName(exercise.name);
    if (!exercisesByKey.has(key)) exercisesByKey.set(key, exercise);
  }
  // Re-importing the same file must not duplicate history.
  const second = (time: number) => Math.floor(time / 1000);
  const knownStarts = new Set(state.workouts.map((workout) => second(workout.startedAt)));

  for (const parsed of data.workouts) {
    if (knownStarts.has(second(parsed.date))) {
      summary.alreadyImported += 1;
      continue;
    }
    knownStarts.add(second(parsed.date));

    const entries = parsed.exercises.map((parsedExercise) => {
      const key = normalizeName(parsedExercise.name);
      let exercise = exercisesByKey.get(key);
      if (!exercise) {
        exercise = newExercise(parsedExercise.name, guessMuscle(parsedExercise.name), guessEquipment(parsedExercise.name), true);
        state.exercises.push(exercise);
        exercisesByKey.set(key, exercise);
        summary.newExercises += 1;
      }
      summary.sets += parsedExercise.sets.length;
      return {
        id: uid(),
        exerciseId: exercise.id,
        exerciseName: exercise.name,
        notes: parsedExercise.notes,
        sets: parsedExercise.sets.map((set) => ({
          id: uid(),
          weight: set.weight === null ? null : toKg(unit, set.weight),
          reps: set.reps,
          rpe: set.rpe,
          isWarmup: set.isWarmup,
          isDone: true,
        })),
      };
    });
    state.workouts.push({
      id: uid(),
      name: parsed.name,
      startedAt: parsed.date,
      endedAt: parsed.date + (parsed.duration ?? 0) * 1000,
      notes: parsed.notes,
      entries,
    });
    summary.workouts += 1;
  }
  return summary;
}
