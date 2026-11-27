import { describe, expect, it } from 'vitest';
import { seedLibrary } from '../../src/lib/exercises';
import { emptyState } from '../../src/lib/types';
import type { AppState, Workout } from '../../src/lib/types';
import { fromDateTimeInputValue, toDateTimeInputValue } from '../../src/lib/units';
import {
  addExercise, addSet, finishEditing, finishWorkout, previousEntry, previousSets, restoreWorkout, setWorkoutTimes, startEmpty,
  updateSet, volumeKg,
} from '../../src/lib/workouts';

// Opening a finished workout again to put something right.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const MONDAY = new Date(2026, 10, 23, 18, 0).getTime();

const idOf = (state: AppState, name: string) => state.exercises.find((exercise) => exercise.name === name)!.id;

/** A state with bench press logged on three days: 80, 85 and 90 kg for 5. */
function threeSessions(): { state: AppState; workouts: Workout[] } {
  const state = emptyState();
  seedLibrary(state);
  for (const [day, weight] of [[0, 80], [2, 85], [4, 90]] as const) {
    const id = startEmpty(state, MONDAY + day * DAY);
    addExercise(state, id, idOf(state, 'Bench Press (Barbell)'));
    const entry = state.workouts.at(-1)!.entries[0];
    entry.sets = [{ id: `set-${day}`, weight, reps: 5, rpe: null, isWarmup: false, isDone: true }];
    finishWorkout(state, id, MONDAY + day * DAY + HOUR);
  }
  return { state, workouts: state.workouts };
}

describe('"last time", seen from a workout that is not the newest', () => {
  it('is the session before it, not itself and not a later one', () => {
    const { state, workouts } = threeSessions();
    const bench = idOf(state, 'Bench Press (Barbell)');
    const weights = (before?: number) => previousSets(state.workouts, bench, undefined, before).map((set) => set.weight);

    expect(weights()).toEqual([90]); // for a workout being logged now
    expect(weights(workouts[2].startedAt)).toEqual([85]);
    expect(weights(workouts[1].startedAt)).toEqual([80]);
    expect(weights(workouts[0].startedAt)).toEqual([]); // the first time it was ever done
    expect(previousEntry(state.workouts, bench, workouts[1].startedAt)).toBe(workouts[0].entries[0]);
  });
});

describe('ending an edit', () => {
  it('keeps what is ticked, drops the rest, and leaves the times alone', () => {
    const { state, workouts } = threeSessions();
    const workout = workouts[1];
    const entry = workout.entries[0];
    updateSet(state, workout.id, entry.id, entry.sets[0].id, { weight: 87.5 });
    addSet(state, workout.id, entry.id); // added, never ticked
    addExercise(state, workout.id, idOf(state, 'Pull Up')); // added, nothing logged in it
    workout.name = '   ';

    finishEditing(state, workout.id);

    expect(workout.entries).toHaveLength(1);
    expect(workout.entries[0].sets.map((set) => [set.weight, set.reps])).toEqual([[87.5, 5]]);
    expect(workout.name).toBe('Evening Workout'); // a blanked name gets the usual one for that hour
    expect([workout.startedAt, workout.endedAt]).toEqual([MONDAY + 2 * DAY, MONDAY + 2 * DAY + HOUR]);
    expect(volumeKg(workout)).toBe(87.5 * 5);
  });

  it('takes an exercise off the to-try list when the edit adds it to the workout', () => {
    const { state, workouts } = threeSessions();
    const pullUp = state.exercises.find((exercise) => exercise.name === 'Pull Up')!;
    pullUp.wantToTry = true;
    addExercise(state, workouts[2].id, pullUp.id);
    const added = workouts[2].entries[1];
    updateSet(state, workouts[2].id, added.id, added.sets[0].id, { reps: 8, isDone: true });
    finishEditing(state, workouts[2].id);
    expect(pullUp.wantToTry).toBe(false);
    expect(workouts[2].entries.map((entry) => entry.exerciseName)).toEqual(['Bench Press (Barbell)', 'Pull Up']);
  });

  it('does not finish a workout that is still running', () => {
    const state = emptyState();
    seedLibrary(state);
    const id = startEmpty(state, MONDAY);
    addExercise(state, id, idOf(state, 'Bench Press (Barbell)'));
    finishEditing(state, id);
    expect(state.workouts[0].endedAt).toBeNull();
    expect(state.workouts[0].entries[0].sets).toHaveLength(3); // its open sets are still there to fill in
  });

  it('can be called off: the workout goes back to how it was', () => {
    const { state, workouts } = threeSessions();
    const snapshot = structuredClone(workouts[1]);
    workouts[1].name = 'Changed';
    workouts[1].entries = [];
    restoreWorkout(state, snapshot);
    expect(state.workouts[1]).toEqual(snapshot);
    expect(state.workouts).toHaveLength(3);
    restoreWorkout(state, { ...snapshot, id: 'deleted-meanwhile' }); // nothing to restore: nothing happens
    expect(state.workouts).toHaveLength(3);
  });
});

describe("changing a finished workout's times", () => {
  it('moves the whole workout when the start changes, keeping its length', () => {
    const { state, workouts } = threeSessions();
    setWorkoutTimes(state, workouts[0].id, { startedAt: MONDAY - 3 * DAY + 90 * 60_000 });
    expect(workouts[0].startedAt).toBe(MONDAY - 3 * DAY + 90 * 60_000);
    expect(workouts[0].endedAt! - workouts[0].startedAt).toBe(HOUR);
  });

  it('changes the length when the end changes, and refuses an end that is not after the start', () => {
    const { state, workouts } = threeSessions();
    setWorkoutTimes(state, workouts[0].id, { endedAt: MONDAY + 25 * 60_000 });
    expect(workouts[0].endedAt).toBe(MONDAY + 25 * 60_000);
    for (const endedAt of [MONDAY, MONDAY - HOUR, Number.NaN]) {
      setWorkoutTimes(state, workouts[0].id, { endedAt });
      expect(workouts[0].endedAt).toBe(MONDAY + 25 * 60_000);
    }
  });

  it('leaves a running workout and an unknown one alone', () => {
    const state = emptyState();
    const id = startEmpty(state, MONDAY);
    setWorkoutTimes(state, id, { startedAt: MONDAY - DAY, endedAt: MONDAY });
    expect(state.workouts[0]).toMatchObject({ startedAt: MONDAY, endedAt: null });
    setWorkoutTimes(state, 'no-such-workout', { startedAt: 1 });
  });
});

describe('a date-and-time field', () => {
  it('shows local time and reads it back to the minute', () => {
    const time = new Date(2026, 10, 3, 7, 5, 42).getTime();
    expect(toDateTimeInputValue(time)).toBe('2026-11-03T07:05');
    expect(fromDateTimeInputValue('2026-11-03T07:05')).toBe(new Date(2026, 10, 3, 7, 5).getTime());
    expect(fromDateTimeInputValue('2026-11-03T07:05:30')).toBe(new Date(2026, 10, 3, 7, 5).getTime()); // some browsers add seconds
    expect(fromDateTimeInputValue(toDateTimeInputValue(MONDAY))).toBe(MONDAY);
  });

  it('reads nothing from a field that is empty or half filled', () => {
    for (const value of ['', '2026-11-03', '2026-11-03T', 'T07:05', 'yesterday']) {
      expect(fromDateTimeInputValue(value)).toBeNull();
    }
  });
});
