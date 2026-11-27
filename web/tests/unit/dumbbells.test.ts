import { describe, expect, it } from 'vitest';
import { exportBackup, parseBackup } from '../../src/lib/backup';
import { seedLibrary } from '../../src/lib/exercises';
import { uid } from '../../src/lib/ids';
import { liftRanks, rankTitle } from '../../src/lib/ranks';
import { emptyState } from '../../src/lib/types';
import type { AppState, WorkoutEntry } from '../../src/lib/types';
import {
  addExercise, dumbbellWeight, finishWorkout, previousEntry, previousSets, setBothDumbbells, startEmpty, startRepeat, takesDumbbells,
  updateSet, volumeKg, weightEach,
} from '../../src/lib/workouts';

// Dumbbell weights are typed in two ways — one dumbbell, or the pair together.
// Each logged exercise says which, and everything that compares weights reads
// them the same way.

const START = new Date(2026, 10, 27, 18, 0).getTime();
const DAY = 86_400_000;

function fresh(): AppState {
  const state = emptyState();
  seedLibrary(state);
  return state;
}

const idOf = (state: AppState, name: string) => state.exercises.find((exercise) => exercise.name === name)!.id;

/** Logs one finished workout with one exercise and returns the logged entry. */
function log(state: AppState, name: string, sets: [number | null, number][], { both = false, daysAgo = 1 } = {}): WorkoutEntry {
  const workoutId = startEmpty(state, START - daysAgo * DAY);
  addExercise(state, workoutId, idOf(state, name));
  const workout = state.workouts.find((candidate) => candidate.id === workoutId)!;
  const entry = workout.entries[0];
  entry.sets = sets.map(([weight, reps]) => ({ id: uid(), weight, reps, rpe: null, isWarmup: false, isDone: true }));
  setBothDumbbells(state, workoutId, entry.id, both);
  finishWorkout(state, workoutId, START - daysAgo * DAY + 3_600_000);
  return entry;
}

describe('one dumbbell or both', () => {
  it('is asked of dumbbell exercises only', () => {
    expect(takesDumbbells({ equipment: 'dumbbell' })).toBe(true);
    for (const equipment of ['barbell', 'machine', 'cable', 'bodyweight', 'kettlebell', 'band', 'other'] as const) {
      expect(takesDumbbells({ equipment })).toBe(false);
    }
    expect(takesDumbbells(undefined)).toBe(false); // the exercise was deleted
  });

  it('converts a weight between the two ways of counting', () => {
    expect(dumbbellWeight(20, false, true)).toBe(40);
    expect(dumbbellWeight(40, true, false)).toBe(20);
    expect(dumbbellWeight(20, false, false)).toBe(20);
    expect(dumbbellWeight(40, true, true)).toBe(40);
    expect(dumbbellWeight(null, false, true)).toBeNull();
  });

  it('is one dumbbell until said otherwise, and can be said of a finished workout', () => {
    const state = fresh();
    const entry = log(state, 'Bench Press (Dumbbell)', [[40, 10]]);
    const workout = state.workouts[0];
    expect('bothDumbbells' in entry).toBe(false);
    expect(weightEach(entry, entry.sets[0])).toBe(40);

    setBothDumbbells(state, workout.id, entry.id, true);
    expect(entry.bothDumbbells).toBe(true);
    expect(entry.sets[0].weight).toBe(40); // the number typed in is never rewritten
    expect(weightEach(entry, entry.sets[0])).toBe(20);

    setBothDumbbells(state, workout.id, entry.id, false);
    expect('bothDumbbells' in entry).toBe(false); // back to exactly what it was
    setBothDumbbells(state, 'no-such-workout', entry.id, true);
    setBothDumbbells(state, workout.id, 'no-such-entry', true);
    expect('bothDumbbells' in entry).toBe(false);
  });
});

describe('last time, in the way this workout counts', () => {
  it('reads the previous sets as they were typed when the counting agrees or nobody asks', () => {
    const state = fresh();
    const entry = log(state, 'Bench Press (Dumbbell)', [[20, 10], [22.5, 8]]);
    const id = idOf(state, 'Bench Press (Dumbbell)');
    expect(previousEntry(state.workouts, id)).toBe(entry);
    expect(previousSets(state.workouts, id).map((set) => set.weight)).toEqual([20, 22.5]);
    // The very same records, so the workout screen doesn't redraw rows for nothing.
    expect(previousSets(state.workouts, id, false)[0]).toBe(entry.sets[0]);
  });

  it('doubles or halves them when it does not', () => {
    const state = fresh();
    log(state, 'Bench Press (Dumbbell)', [[20, 10], [22.5, 8]]);
    const id = idOf(state, 'Bench Press (Dumbbell)');
    expect(previousSets(state.workouts, id, true).map((set) => [set.weight, set.reps])).toEqual([[40, 10], [45, 8]]);

    const other = fresh();
    log(other, 'Bench Press (Dumbbell)', [[40, 10], [null, 12]], { both: true });
    const otherId = idOf(other, 'Bench Press (Dumbbell)');
    expect(previousSets(other.workouts, otherId, false).map((set) => set.weight)).toEqual([20, null]);
    expect(previousSets(other.workouts, otherId, true).map((set) => set.weight)).toEqual([40, null]);
    expect(previousSets(other.workouts, otherId).map((set) => set.weight)).toEqual([40, null]);
  });

  it('has nothing to say about an exercise never done', () => {
    const state = fresh();
    expect(previousEntry(state.workouts, idOf(state, 'Bench Press (Dumbbell)'))).toBeNull();
    expect(previousSets(state.workouts, idOf(state, 'Bench Press (Dumbbell)'), true)).toEqual([]);
  });
});

describe('a new workout', () => {
  it('counts dumbbells the way the exercise was counted last time', () => {
    const state = fresh();
    log(state, 'Bench Press (Dumbbell)', [[40, 10]], { both: true, daysAgo: 7 });
    log(state, 'Bicep Curl (Dumbbell)', [[14, 12]], { daysAgo: 7 });

    const workoutId = startEmpty(state, START);
    addExercise(state, workoutId, idOf(state, 'Bench Press (Dumbbell)'));
    addExercise(state, workoutId, idOf(state, 'Bicep Curl (Dumbbell)'));
    addExercise(state, workoutId, idOf(state, 'Hammer Curl (Dumbbell)')); // never done
    const [bench, curl, hammer] = state.workouts.at(-1)!.entries;
    expect(bench.bothDumbbells).toBe(true);
    expect('bothDumbbells' in curl).toBe(false);
    expect('bothDumbbells' in hammer).toBe(false);
  });

  it('follows the most recent session, not an older habit', () => {
    const state = fresh();
    log(state, 'Bench Press (Dumbbell)', [[40, 10]], { both: true, daysAgo: 14 });
    log(state, 'Bench Press (Dumbbell)', [[20, 10]], { daysAgo: 7 });
    const workoutId = startEmpty(state, START);
    addExercise(state, workoutId, idOf(state, 'Bench Press (Dumbbell)'));
    expect('bothDumbbells' in state.workouts.at(-1)!.entries[0]).toBe(false);
  });

  it('keeps the counting of the workout it repeats', () => {
    const state = fresh();
    log(state, 'Bench Press (Dumbbell)', [[40, 10]], { both: true });
    const repeatId = startRepeat(state, state.workouts[0].id, START)!;
    const repeated = state.workouts.find((workout) => workout.id === repeatId)!;
    expect(repeated.entries[0].bothDumbbells).toBe(true);

    const plain = fresh();
    log(plain, 'Bench Press (Dumbbell)', [[20, 10]]);
    const plainId = startRepeat(plain, plain.workouts[0].id, START)!;
    expect('bothDumbbells' in plain.workouts.find((workout) => workout.id === plainId)!.entries[0]).toBe(false);
  });

  it('does not carry the marker onto an exercise that is no longer done with dumbbells', () => {
    const state = fresh();
    log(state, 'Bench Press (Dumbbell)', [[40, 10]], { both: true });
    state.exercises.find((exercise) => exercise.name === 'Bench Press (Dumbbell)')!.equipment = 'machine';
    const workoutId = startEmpty(state, START);
    addExercise(state, workoutId, idOf(state, 'Bench Press (Dumbbell)'));
    expect('bothDumbbells' in state.workouts.at(-1)!.entries[0]).toBe(false);
  });
});

describe('what is worked out from the weights', () => {
  it('gives the same volume whichever way the session was typed in', () => {
    const each = fresh();
    log(each, 'Bench Press (Dumbbell)', [[20, 10], [22.5, 8]]);
    const both = fresh();
    log(both, 'Bench Press (Dumbbell)', [[40, 10], [45, 8]], { both: true });
    expect(volumeKg(each.workouts[0])).toBe(20 * 10 + 22.5 * 8);
    expect(volumeKg(both.workouts[0])).toBe(volumeKg(each.workouts[0]));
  });

  it('still leaves warm-ups, unticked sets and other equipment as they were', () => {
    const state = fresh();
    const workoutId = startEmpty(state, START);
    addExercise(state, workoutId, idOf(state, 'Bench Press (Barbell)'));
    addExercise(state, workoutId, idOf(state, 'Bench Press (Dumbbell)'));
    const workout = state.workouts[0];
    const [barbell, dumbbell] = workout.entries;
    updateSet(state, workoutId, barbell.id, barbell.sets[0].id, { weight: 40, reps: 10, isWarmup: true, isDone: true });
    updateSet(state, workoutId, barbell.id, barbell.sets[1].id, { weight: 100, reps: 5, isDone: true });
    updateSet(state, workoutId, barbell.id, barbell.sets[2].id, { weight: 100, reps: 5 }); // not ticked
    updateSet(state, workoutId, dumbbell.id, dumbbell.sets[0].id, { weight: 60, reps: 10, isDone: true });
    setBothDumbbells(state, workoutId, dumbbell.id, true);
    expect(volumeKg(workout)).toBe(100 * 5 + 30 * 10);
  });

  it('ranks a lift the same whichever way it was typed in', () => {
    const rankOfBench = (weight: number, both: boolean) => {
      const state = fresh();
      state.settings.rankStandards = 'men';
      state.bodyWeights.push({ id: uid(), date: START, kg: 80 });
      log(state, 'Bench Press (Dumbbell)', [[weight, 1]], { both });
      const [rank] = liftRanks(state);
      return { title: rankTitle(rank), best: rank.best };
    };
    expect(rankOfBench(40, false)).toEqual({ title: 'Silver III', best: 40 }); // one 40 kg dumbbell: 0.5× body weight, of the 0.92× Legend takes
    expect(rankOfBench(80, true)).toEqual(rankOfBench(40, false));
    expect(rankOfBench(40, true).title).toBe('Iron III'); // the same number meaning 20 kg a side
  });
});

describe('a backup', () => {
  it('keeps which way each exercise was counted, and adds nothing where it was not said', () => {
    const state = fresh();
    log(state, 'Bench Press (Dumbbell)', [[40, 10]], { both: true, daysAgo: 2 });
    log(state, 'Bench Press (Dumbbell)', [[20, 10]], { daysAgo: 1 });
    const oldestFirst = (workouts: AppState['workouts']) => [...workouts].sort((a, b) => a.startedAt - b.startedAt);
    const restored = oldestFirst(parseBackup(exportBackup(state)).state.workouts);
    expect(restored).toEqual(oldestFirst(state.workouts));
    expect(restored[0].entries[0].bothDumbbells).toBe(true);
    expect('bothDumbbells' in restored[1].entries[0]).toBe(false);
  });

  it('reads anything but a plain yes as one dumbbell', () => {
    const state = fresh();
    log(state, 'Bench Press (Dumbbell)', [[40, 10]]);
    for (const planted of ['yes', 1, 'true', null, false]) {
      const file = JSON.parse(exportBackup(state)) as { data: { workouts: { entries: Record<string, unknown>[] }[] } };
      file.data.workouts[0].entries[0].bothDumbbells = planted;
      expect('bothDumbbells' in parseBackup(JSON.stringify(file)).state.workouts[0].entries[0]).toBe(false);
    }
  });
});
