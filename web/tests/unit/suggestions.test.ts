import { beforeEach, describe, expect, it } from 'vitest';
import { seedLibrary } from '../../src/lib/exercises';
import { nextWorkout, routines, toTryFor } from '../../src/lib/suggestions';
import { emptyState } from '../../src/lib/types';
import type { AppState, Exercise, Workout } from '../../src/lib/types';
import { fmtDaysAgo } from '../../src/lib/units';
import { startEmpty } from '../../src/lib/workouts';

// "Up next" on the home screen and "To try today" in a workout.

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 26, 18, 0).getTime();

const PUSH = ['Bench Press (Barbell)', 'Overhead Press (Dumbbell)', 'Triceps Rope Pushdown (Cable)'];
const PULL = ['Pull Up', 'Bent Over Row (Barbell)', 'Bicep Curl (Dumbbell)'];
const LEGS = ['Squat (Barbell)', 'Romanian Deadlift (Barbell)', 'Leg Extension (Machine)'];

let state: AppState;
let count = 0;

beforeEach(() => {
  state = emptyState();
  seedLibrary(state);
  count = 0;
});

const exercise = (name: string): Exercise => {
  const found = state.exercises.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`no exercise called ${name}`);
  return found;
};

/** A finished workout `daysAgo` days back with one completed set of each exercise. */
function session(name: string, daysAgo: number, exercises: string[]): Workout {
  const startedAt = NOW - daysAgo * DAY;
  const workout: Workout = {
    id: `w${++count}`, name, startedAt, endedAt: startedAt + 3_600_000, notes: '',
    entries: exercises.map((exerciseName, index) => ({
      id: `e${count}-${index}`, exerciseId: exercise(exerciseName).id, exerciseName, notes: '',
      sets: [{ id: `s${count}-${index}`, weight: 50, reps: 8, rpe: null, isWarmup: false, isDone: true }],
    })),
  };
  state.workouts.push(workout);
  return workout;
}

/** Three weeks of push / pull / legs, the last legs session `daysAgo` days back. */
function pushPullLegs(daysAgo = 0): void {
  for (const week of [2, 1, 0]) {
    session('Push', daysAgo + week * 7 + 4, PUSH);
    session('Pull', daysAgo + week * 7 + 2, PULL);
    session('Legs', daysAgo + week * 7, LEGS);
  }
}

function wantToTry(name: string, createdAt = 0): Exercise {
  const found = exercise(name);
  found.wantToTry = true;
  found.createdAt = createdAt;
  return found;
}

const names = (exercises: Exercise[]) => exercises.map((item) => item.name);

describe('the routine that is due', () => {
  it('is the one gone longest without', () => {
    pushPullLegs();
    expect(routines(state, NOW).map((routine) => [routine.latest.name, routine.sessions])).toEqual([['Legs', 3], ['Pull', 3], ['Push', 3]]);
    const next = nextWorkout(state, NOW)!;
    expect(next.latest.name).toBe('Push');
    expect(next.latest.startedAt).toBe(NOW - 4 * DAY); // its most recent session, the one a repeat copies
  });

  it('moves on once that routine is done', () => {
    pushPullLegs(1);
    session('Push', 0, PUSH);
    expect(nextWorkout(state, NOW)!.latest.name).toBe('Pull');
  });

  it('is nothing until something has been done twice', () => {
    expect(nextWorkout(state, NOW)).toBeNull();
    session('Legs', 3, LEGS);
    session('Push', 1, PUSH);
    expect(nextWorkout(state, NOW)).toBeNull();
    session('Legs', 0, LEGS);
    expect(nextWorkout(state, NOW)!.latest.name).toBe('Legs');
  });

  it('is nothing while a workout is in progress', () => {
    pushPullLegs();
    startEmpty(state, NOW);
    expect(nextWorkout(state, NOW)).toBeNull();
  });

  it('recognises routines nobody named, by what was done in them', () => {
    // The names the app gives by time of day say nothing about the routine.
    session('Evening Workout', 9, LEGS);
    session('Morning Workout', 7, PUSH);
    session('Midday Workout', 2, [...LEGS.slice(0, 2), 'Leg Press']); // one exercise swapped
    session('Evening Workout', 0, PUSH);
    const found = routines(state, NOW);
    expect(found.map((routine) => routine.sessions)).toEqual([2, 2]);
    expect(names(nextWorkout(state, NOW)!.latest.entries.map((entry) => exercise(entry.exerciseName)))).toEqual([...LEGS.slice(0, 2), 'Leg Press']);
  });

  it('keeps a named routine together when its exercises change', () => {
    session('Legs', 8, LEGS);
    session('legs ', 1, ['Leg Press', 'Seated Leg Curl (Machine)', 'Seated Calf Raise (Machine)']);
    expect(routines(state, NOW)).toHaveLength(1);
    expect(routines(state, NOW)[0].sessions).toBe(2);
  });

  it('treats the same exercises under two names as one routine', () => {
    session('Leg day', 8, LEGS);
    session('Lower body', 1, LEGS);
    expect(routines(state, NOW)).toHaveLength(1);
  });

  it('ignores workouts older than eight weeks and workouts with nothing in them', () => {
    session('Legs', 70, LEGS);
    session('Legs', 60, LEGS);
    session('Stretching', 3, []);
    session('Stretching', 1, []);
    expect(routines(state, NOW)).toEqual([]);
    expect(nextWorkout(state, NOW)).toBeNull();
  });

  it('lets go of a routine that was dropped for a new programme', () => {
    session('Full Body', 30, [...PUSH.slice(0, 1), ...PULL.slice(0, 1), ...LEGS.slice(0, 1)]);
    session('Full Body', 28, [...PUSH.slice(0, 1), ...PULL.slice(0, 1), ...LEGS.slice(0, 1)]);
    // Since then: upper / lower, four times each.
    for (const week of [3, 2, 1, 0]) {
      session('Upper', week * 6 + 3, [...PUSH.slice(0, 2), ...PULL.slice(0, 2)]);
      session('Lower', week * 6, LEGS);
    }
    expect(routines(state, NOW).map((routine) => routine.latest.name)).toEqual(['Lower', 'Upper']);
    expect(nextWorkout(state, NOW)!.latest.name).toBe('Upper');
  });

  it('still suggests after a break, when everything is equally old', () => {
    pushPullLegs(20);
    expect(nextWorkout(state, NOW)!.latest.name).toBe('Push');
  });
});

describe('to-try exercises that fit a workout', () => {
  it('fit when the workout trains the same muscle', () => {
    wantToTry('Face Pull (Cable)'); // shoulders
    expect(names(toTryFor(state, session('Push', 0, PUSH)))).toEqual(['Face Pull (Cable)']);
    expect(toTryFor(state, session('Legs', 0, LEGS))).toEqual([]);
    expect(toTryFor(state, session('Pull', 0, PULL))).toEqual([]);
  });

  it('fit a leg day even when it has no exercise for that very muscle', () => {
    wantToTry('Hip Thrust (Barbell)'); // glutes; the workout below has quads and hamstrings only
    expect(names(toTryFor(state, session('Legs', 0, LEGS)))).toEqual(['Hip Thrust (Barbell)']);
    expect(toTryFor(state, session('Push', 0, PUSH))).toEqual([]);
  });

  it('need the workout to be about that part of the body, not just to touch it', () => {
    wantToTry('Chest Fly (Cable)'); // chest
    // One shoulder exercise among four doesn't make a pull day a push day…
    expect(toTryFor(state, session('Pull', 0, [...PULL, 'Face Pull (Cable)']))).toEqual([]);
    // …two of five does.
    expect(names(toTryFor(state, session('Upper', 0, [...PULL, 'Face Pull (Cable)', 'Lateral Raise (Dumbbell)'])))).toEqual(['Chest Fly (Cable)']);
  });

  it('leave out what is already in the workout and what is not waiting to be tried', () => {
    wantToTry('Face Pull (Cable)');
    wantToTry('Lateral Raise (Dumbbell)');
    const workout = session('Push', 0, [...PUSH, 'Face Pull (Cable)']);
    expect(names(toTryFor(state, workout))).toEqual(['Lateral Raise (Dumbbell)']);
    exercise('Lateral Raise (Dumbbell)').wantToTry = false;
    expect(toTryFor(state, workout)).toEqual([]);
  });

  it('are none for a workout with nothing in it yet', () => {
    wantToTry('Face Pull (Cable)');
    startEmpty(state, NOW);
    expect(toTryFor(state, state.workouts[0])).toEqual([]);
  });

  it('match core and other muscles only by the muscle itself', () => {
    wantToTry('Plank'); // core
    expect(toTryFor(state, session('Legs', 0, LEGS))).toEqual([]);
    expect(names(toTryFor(state, session('Legs and abs', 0, [...LEGS, 'Crunch'])))).toEqual(['Plank']);
  });

  it('come newest first', () => {
    wantToTry('Face Pull (Cable)', 100);
    wantToTry('Lateral Raise (Dumbbell)', 300);
    wantToTry('Reverse Fly (Cable)', 200);
    expect(names(toTryFor(state, session('Push', 0, PUSH)))).toEqual(['Lateral Raise (Dumbbell)', 'Reverse Fly (Cable)', 'Face Pull (Cable)']);
  });

  it('come in name order when saved at the same moment, whatever order storage returns them in', () => {
    wantToTry('Reverse Fly (Cable)', 100);
    wantToTry('Face Pull (Cable)', 100);
    const workout = session('Push', 0, PUSH);
    expect(names(toTryFor(state, workout))).toEqual(['Face Pull (Cable)', 'Reverse Fly (Cable)']);
    state.exercises.reverse();
    expect(names(toTryFor(state, workout))).toEqual(['Face Pull (Cable)', 'Reverse Fly (Cable)']);
  });

  it('cope with entries whose exercise has been deleted', () => {
    wantToTry('Hip Thrust (Barbell)');
    const workout = session('Legs', 0, LEGS);
    workout.entries[0].exerciseId = null;
    expect(names(toTryFor(state, workout))).toEqual(['Hip Thrust (Barbell)']);
  });
});

describe('how long ago', () => {
  const at = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).getTime();

  it('counts calendar days, not 24-hour stretches', () => {
    expect(fmtDaysAgo(at(26, 6), at(26, 22))).toBe('today');
    expect(fmtDaysAgo(at(25, 23, 50), at(26, 0, 10))).toBe('yesterday');
    expect(fmtDaysAgo(at(22, 18), at(26, 7))).toBe('4 days ago');
  });

  it('calls anything later than now today', () => {
    expect(fmtDaysAgo(at(27, 9), at(26, 9))).toBe('today');
  });
});
