import { describe, expect, it } from 'vitest';
import { exportBackup, parseBackup } from '../../src/lib/backup';
import { newExercise, seedLibrary } from '../../src/lib/exercises';
import { uid } from '../../src/lib/ids';
import { LIBRARY } from '../../src/lib/library';
import {
  BODY_PARTS, bodyPartRanks, describeLift, DIVISIONS, latestBodyKg, liftRanks, overallRank, rankFor, rankSetup, rankTitle, rankUps,
  standardFor, STANDARDS, stepAfter, STEPS, stepStart, TIERS,
} from '../../src/lib/ranks';
import type { LiftRank } from '../../src/lib/ranks';
import { defaultSettings, emptyState, normalizeSettings } from '../../src/lib/types';
import type { AppState, Equipment, RankStandards, SetEntry } from '../../src/lib/types';
import { fmtNumber } from '../../src/lib/units';

// Ranks: the ladder itself, the standards behind it, and how a logged set
// turns into "Gold II".

const DAY = 86_400_000;
const NOW = new Date(2026, 10, 27, 18, 0).getTime();

type Logged = [weight: number | null, reps: number | null, options?: Partial<SetEntry>];

/** Someone of `bodyKg` with standards chosen and an empty history. */
function lifter(bodyKg: number | null = 80, standards: RankStandards | '' = 'men'): AppState {
  const state = emptyState();
  seedLibrary(state);
  state.settings.rankStandards = standards;
  if (bodyKg !== null) state.bodyWeights.push({ id: uid(), date: NOW - DAY, kg: bodyKg });
  return state;
}

/** Adds a workout with the given sets of one exercise; finished unless said otherwise. */
function log(state: AppState, name: string, sets: Logged[], { active = false, daysAgo = 1 } = {}): void {
  const exercise = state.exercises.find((candidate) => candidate.name === name)!;
  const startedAt = NOW - daysAgo * DAY;
  state.workouts.push({
    id: uid(), name: 'Workout', startedAt, endedAt: active ? null : startedAt + 3_600_000, notes: '',
    entries: [{
      id: uid(), exerciseId: exercise.id, exerciseName: name, notes: '',
      sets: sets.map(([weight, reps, options]) => ({ id: uid(), weight, reps, rpe: null, isWarmup: false, isDone: true, ...options })),
    }],
  });
}

const rankOf = (state: AppState, name: string, options?: { includeActive?: boolean }): LiftRank | undefined =>
  liftRanks(state, options).find((rank) => rank.exercise.name === name);
const titleOf = (state: AppState, name: string, options?: { includeActive?: boolean }) => {
  const rank = rankOf(state, name, options);
  return rank ? rankTitle(rank) : null;
};

describe('the ladder', () => {
  it('has seven tiers of three steps', () => {
    expect(TIERS).toEqual(['iron', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'legend']);
    expect(DIVISIONS).toBe(3);
    expect(STEPS).toBe(21);
  });

  it('starts each tier at a fixed share of what Legend takes', () => {
    const tierStarts = TIERS.map((_, index) => stepStart(index * DIVISIONS));
    expect(tierStarts).toEqual([0, 0.3, 0.42, 0.55, 0.7, 0.85, 1]);
    // Steps only ever go up.
    for (let step = 1; step < STEPS; step++) expect(stepStart(step)).toBeGreaterThan(stepStart(step - 1));
  });

  it.each([
    [0, 'Iron I'], [0.09, 'Iron I'], [0.1, 'Iron II'], [0.2999, 'Iron III'],
    [0.3, 'Bronze I'], [0.34, 'Bronze II'], [0.419, 'Bronze III'],
    [0.42, 'Silver I'], [0.55, 'Gold I'], [0.6, 'Gold II'], [0.65, 'Gold III'], [0.6999, 'Gold III'],
    [0.7, 'Platinum I'], [0.75, 'Platinum II'], [0.85, 'Diamond I'], [0.9999, 'Diamond III'],
    [1, 'Legend I'], [1.05, 'Legend II'], [1.1, 'Legend III'], [7, 'Legend III'],
  ])('ranks a score of %f as %s', (score, title) => {
    expect(rankTitle(rankFor(score))).toBe(title);
  });

  it('says how far along a step is', () => {
    expect(rankFor(0.625)).toMatchObject({ tier: 'gold', division: 2, step: 10, score: 0.625 });
    expect(rankFor(0.625).progress).toBeCloseTo(0.5);
    expect(rankFor(0.55).progress).toBeCloseTo(0);
    expect(rankFor(-1).progress).toBe(0);
    // Nothing comes after the last step.
    expect(rankFor(3)).toMatchObject({ tier: 'legend', division: 3, step: 20, progress: 1 });
  });
});

describe('the standards', () => {
  // Decided on purpose: holds, carries, drills, and a machine whose number is the help it gives.
  const UNRANKED = [
    'Pull Up (Assisted)', "Farmer's Walk", 'Dead Hang', 'Wall Sit', 'Frog Pump', 'Tibialis Raise',
    'Plank', 'Side Plank', 'Copenhagen Plank', 'Hollow Hold', 'Bicycle Crunch', 'Russian Twist', 'Mountain Climber',
    'Dead Bug', 'Bird Dog', 'Burpee', 'Box Jump', 'Sled Push', 'Battle Ropes',
  ];

  it('cover every library exercise except the ones left out on purpose', () => {
    const ranked = new Set(STANDARDS.map((standard) => standard.name));
    expect(LIBRARY.map((item) => item.name).filter((name) => !ranked.has(name)).sort()).toEqual([...UNRANKED].sort());
    expect(ranked.size).toBe(STANDARDS.length); // no exercise is listed twice
  });

  it('never measure a built-in exercise as something its name merely contains', () => {
    // "Bicycle Crunch" contains "Crunch", which has a standard; left out on purpose means left out.
    for (const name of UNRANKED) {
      const item = LIBRARY.find((candidate) => candidate.name === name)!;
      expect(standardFor(item), name).toBeNull();
    }
    const state = lifter(80);
    log(state, 'Bicycle Crunch', [[null, 30]]);
    log(state, 'Crunch', [[null, 30]]);
    expect(liftRanks(state).map((rank) => rank.exercise.name)).toEqual(['Crunch']);
  });

  it('are numbers that can be climbed', () => {
    for (const standard of STANDARDS) {
      if (standard.kind === 'weight') {
        expect(standard.top, standard.name).toBeGreaterThan(0.2);
        expect(standard.top, standard.name).toBeLessThanOrEqual(5);
      } else {
        expect(standard.low, standard.name).toBeGreaterThanOrEqual(1);
        expect(standard.top, standard.name).toBeGreaterThan(standard.low * 3);
      }
    }
  });

  it('take a bodyweight exercise by reps and a loaded one by weight', () => {
    expect(standardFor({ name: 'Pull Up', equipment: 'bodyweight' })).toMatchObject({ kind: 'bodyweight', low: 3, top: 30 });
    expect(standardFor({ name: 'Bench Press (Barbell)', equipment: 'barbell' })).toMatchObject({ kind: 'weight', top: 2 });
    // A weighted pull-up is a pull-up, whatever the equipment says.
    expect(standardFor({ name: 'Pull Up (Weighted)', equipment: 'other' })).toMatchObject({ kind: 'bodyweight', top: 30 });
  });

  it('are found for your own exercises through the library movement in their name', () => {
    const custom = (name: string, equipment: Equipment) => standardFor({ name, equipment })?.name ?? null;
    expect(custom('bench press barbell', 'barbell')).toBe('Bench Press (Barbell)'); // however it is written
    expect(custom('Paused Bench Press (Barbell)', 'barbell')).toBe('Bench Press (Barbell)');
    // The most specific movement wins.
    expect(custom('Paused Incline Bench Press (Barbell)', 'barbell')).toBe('Incline Bench Press (Barbell)');
    expect(custom('Deficit Bulgarian Split Squat (Dumbbell)', 'dumbbell')).toBe('Bulgarian Split Squat (Dumbbell)');
    expect(custom('Wide Grip Pull Up', 'bodyweight')).toBe('Pull Up');
  });

  it('are not guessed across equipment, or for movements the library does not know', () => {
    const custom = (name: string, equipment: Equipment) => standardFor({ name, equipment });
    // One plate held overhead is not logged like a pair of dumbbells.
    expect(custom('Overhead Deficit Bulgarian Split Squat (Plate)', 'other')).toBeNull();
    expect(custom('Bench Press (Kettlebell)', 'kettlebell')).toBeNull();
    expect(custom('Half-Kneeling Cable Y Raise', 'cable')).toBeNull();
    expect(custom('Elevated Pigeon Stretch (Plate)', 'other')).toBeNull();
    expect(custom('', 'barbell')).toBeNull();
  });
});

describe('what ranks need', () => {
  it('is a body weight and a choice of standards', () => {
    const state = lifter(null, '');
    log(state, 'Bench Press (Barbell)', [[100, 5]]);
    expect(rankSetup(state)).toBeNull();
    expect(liftRanks(state)).toEqual([]);

    state.settings.rankStandards = 'men';
    expect(liftRanks(state)).toEqual([]);

    state.bodyWeights.push({ id: uid(), date: NOW, kg: 80 });
    expect(rankSetup(state)).toEqual({ bodyKg: 80, standards: 'men' });
    expect(liftRanks(state)).toHaveLength(1);

    state.settings.rankStandards = '';
    expect(liftRanks(state)).toEqual([]);
  });

  it('uses the most recent weigh-in, whenever it was entered', () => {
    const state = lifter(null);
    expect(latestBodyKg(state)).toBeNull();
    state.bodyWeights.push({ id: uid(), date: NOW - 2 * DAY, kg: 82 });
    state.bodyWeights.push({ id: uid(), date: NOW, kg: 80 });
    state.bodyWeights.push({ id: uid(), date: NOW - 30 * DAY, kg: 90 }); // an old one typed in afterwards
    expect(latestBodyKg(state)).toBe(80);
  });

  it('starts unset, survives storage and a backup, and reads nonsense as unset', () => {
    expect(defaultSettings().rankStandards).toBe('');
    expect(normalizeSettings({ rankStandards: 'women' }).rankStandards).toBe('women');
    expect(normalizeSettings({ rankStandards: 'men' }).rankStandards).toBe('men');
    for (const stored of [undefined, null, 'everyone', 1, true]) expect(normalizeSettings({ rankStandards: stored }).rankStandards).toBe('');
    expect(parseBackup(exportBackup(lifter(80, 'women'))).state.settings.rankStandards).toBe('women');
  });
});

describe('the rank of a lift', () => {
  it('comes from the estimated one-rep max against body weight', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[100, 1]]);
    // 100 kg is 1.25× body weight; Legend begins at 2×, so the score is 0.625.
    const rank = rankOf(state, 'Bench Press (Barbell)')!;
    expect(rankTitle(rank)).toBe('Gold II');
    expect(rank).toMatchObject({ tier: 'gold', division: 2, step: 10, kind: 'weight' });
    expect(rank.score).toBeCloseTo(0.625);
    expect(rank.progress).toBeCloseTo(0.5);
    expect(rank.best).toBeCloseTo(100);
    // Gold III begins at 0.65 × 2 × 80 kg.
    expect(rank.next).toMatchObject({ tier: 'gold', division: 3 });
    expect(rank.next!.need).toBeCloseTo(104);
  });

  it.each([
    ['Bench Press (Barbell)', 47.9, 'Iron III'], ['Bench Press (Barbell)', 48, 'Bronze I'],
    ['Bench Press (Barbell)', 88, 'Gold I'], ['Bench Press (Barbell)', 160, 'Legend I'],
    ['Squat (Barbell)', 140, 'Gold II'], ['Deadlift (Barbell)', 180, 'Platinum II'],
    ['Overhead Press (Barbell)', 60, 'Gold I'], ['Bicep Curl (Dumbbell)', 20, 'Silver I'], ['Bicep Curl (Dumbbell)', 30, 'Gold III'],
  ])('puts an 80 kg man with a %s of %f kg at %s', (name, weight, title) => {
    const state = lifter(80);
    log(state, name, [[weight, 1]]);
    expect(titleOf(state, name)).toBe(title);
  });

  it('counts reps towards the estimate, up to twelve', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[80, 8]]);
    expect(rankOf(state, 'Bench Press (Barbell)')!.best).toBeCloseTo(80 * (1 + 8 / 30));

    const endurance = lifter(80);
    log(endurance, 'Bench Press (Barbell)', [[40, 30]]);
    const capped = lifter(80);
    log(capped, 'Bench Press (Barbell)', [[40, 12]]);
    expect(rankOf(endurance, 'Bench Press (Barbell)')!.best).toBeCloseTo(rankOf(capped, 'Bench Press (Barbell)')!.best);
    expect(rankOf(endurance, 'Bench Press (Barbell)')!.best).toBeCloseTo(56);
  });

  it('takes the best working set ever logged', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[60, 10], [100, 3], [90, 5]], { daysAgo: 30 });
    log(state, 'Bench Press (Barbell)', [[80, 5]], { daysAgo: 1 });
    expect(rankOf(state, 'Bench Press (Barbell)')!.best).toBeCloseTo(110); // 100 × 3
  });

  it('ignores warm-ups, unticked sets and sets without reps', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [
      [60, 5],
      [140, 5, { isWarmup: true }],
      [150, 5, { isDone: false }],
      [160, null],
      [170, 0],
    ]);
    expect(rankOf(state, 'Bench Press (Barbell)')!.best).toBeCloseTo(70);
  });

  it('leaves the workout in progress out unless asked', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[80, 1]]);
    log(state, 'Bench Press (Barbell)', [[100, 1]], { active: true, daysAgo: 0 });
    log(state, 'Squat (Barbell)', [[100, 1]], { active: true, daysAgo: 0 });
    expect(titleOf(state, 'Bench Press (Barbell)')).toBe('Silver II'); // 1× body weight: half of what Legend takes
    expect(titleOf(state, 'Squat (Barbell)')).toBeNull();
    expect(titleOf(state, 'Bench Press (Barbell)', { includeActive: true })).toBe('Gold II');
    expect(titleOf(state, 'Squat (Barbell)', { includeActive: true })).toBe('Silver I');
  });

  it('can be asked for as it stood at an earlier moment', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[80, 1]], { daysAgo: 21 });
    log(state, 'Bench Press (Barbell)', [[100, 1]], { daysAgo: 14 });
    log(state, 'Squat (Barbell)', [[140, 1]], { daysAgo: 7 });
    const at = (daysAgo: number) => liftRanks(state, { until: NOW - daysAgo * DAY }).map((rank) => [rank.exercise.name, rankTitle(rank)]);

    expect(at(22)).toEqual([]);
    expect(at(21)).toEqual([['Bench Press (Barbell)', 'Silver II']]); // a workout started at that very moment counts
    expect(at(15)).toEqual([['Bench Press (Barbell)', 'Silver II']]);
    expect(at(14)).toEqual([['Bench Press (Barbell)', 'Gold II']]);
    expect(at(7)).toEqual([['Squat (Barbell)', 'Gold II'], ['Bench Press (Barbell)', 'Gold II']]);
    // Without a moment it is everything, as before.
    expect(liftRanks(state)).toEqual(liftRanks(state, { until: NOW }));
  });

  it("measures women against women's standards", () => {
    const man = lifter(60, 'men');
    const woman = lifter(60, 'women');
    for (const state of [man, woman]) {
      log(state, 'Bench Press (Barbell)', [[60, 1]]);
      log(state, 'Squat (Barbell)', [[90, 1]]);
    }
    expect(titleOf(man, 'Bench Press (Barbell)')).toBe('Silver II');
    expect(titleOf(woman, 'Bench Press (Barbell)')).toBe('Platinum I'); // 68% of the men's requirement
    expect(rankOf(woman, 'Bench Press (Barbell)')!.score).toBeCloseTo(1 / (2 * 0.68));
    expect(titleOf(man, 'Squat (Barbell)')).toBe('Gold I');
    expect(rankOf(woman, 'Squat (Barbell)')!.score).toBeCloseTo(1.5 / (2.7 * 0.75)); // legs: 75%
  });

  it('falls when the same lift is done at a higher body weight', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[100, 1]]);
    expect(titleOf(state, 'Bench Press (Barbell)')).toBe('Gold II');
    state.bodyWeights.push({ id: uid(), date: NOW, kg: 100 });
    expect(titleOf(state, 'Bench Press (Barbell)')).toBe('Silver II');
  });

  it('ranks bodyweight exercises by reps', () => {
    const state = lifter(80);
    log(state, 'Pull Up', [[null, 12], [null, 9]]);
    const rank = rankOf(state, 'Pull Up')!;
    // Bronze begins at 3 reps and Legend at 30; 12 reps are a third of the way between.
    expect(rank.kind).toBe('bodyweight');
    expect(rank.score).toBeCloseTo(0.3 + 0.7 * (9 / 27));
    expect(rankTitle(rank)).toBe('Silver III');
    expect(rank.best).toBeCloseTo(12);
    expect(rank.next).toMatchObject({ tier: 'gold', division: 1 });
    expect(rank.next!.need).toBeCloseTo(3 + ((0.55 - 0.3) / 0.7) * 27); // a little under 13 reps
  });

  it.each([[1, 'Iron II'], [2, 'Iron III'], [3, 'Bronze I'], [30, 'Legend I'], [200, 'Legend III']])(
    'puts %i pull-ups at %s', (reps, title) => {
      const state = lifter(80);
      log(state, 'Pull Up', [[null, reps]]);
      expect(titleOf(state, 'Pull Up')).toBe(title);
    },
  );

  it('counts weight added to a bodyweight exercise', () => {
    const plain = lifter(80);
    log(plain, 'Pull Up', [[null, 5]]);
    const weighted = lifter(80);
    log(weighted, 'Pull Up', [[20, 5]]);
    expect(rankOf(weighted, 'Pull Up')!.score).toBeGreaterThan(rankOf(plain, 'Pull Up')!.score);
    // 100 kg moved five times is worth as much as 80 kg moved 13.75 times.
    expect(rankOf(weighted, 'Pull Up')!.best).toBeCloseTo(((100 / 80) * (1 + 5 / 30) - 1) * 30);
  });

  it('does not rank a loaded lift that was logged without weight', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[null, 10], [0, 10]]);
    expect(rankOf(state, 'Bench Press (Barbell)')).toBeUndefined();
  });

  it('does not rank what has no standard, was never done, or was deleted', () => {
    const state = lifter(80);
    log(state, 'Plank', [[null, 1]]);
    log(state, 'Pull Up (Assisted)', [[30, 8]]);
    log(state, 'Bench Press (Barbell)', [[100, 1]]);
    state.workouts.at(-1)!.entries[0].exerciseId = null; // the exercise was deleted afterwards
    expect(liftRanks(state)).toEqual([]);
  });

  it('ranks your own exercise by the library movement it is a version of', () => {
    const state = lifter(80);
    state.exercises.push(newExercise('Paused Bench Press (Barbell)', 'chest', 'barbell', true));
    state.exercises.push(newExercise('Half-Kneeling Cable Y Raise', 'shoulders', 'cable', true));
    log(state, 'Paused Bench Press (Barbell)', [[100, 1]]);
    log(state, 'Half-Kneeling Cable Y Raise', [[7.5, 12]]);
    expect(liftRanks(state).map((rank) => [rank.exercise.name, rankTitle(rank)])).toEqual([['Paused Bench Press (Barbell)', 'Gold II']]);
  });

  it('lists the strongest lift first, then by name', () => {
    const state = lifter(80);
    log(state, 'Squat (Barbell)', [[100, 1]]);
    log(state, 'Deadlift (Barbell)', [[180, 1]]);
    log(state, 'Bench Press (Smith Machine)', [[95, 1]]);
    log(state, 'Bench Press (Barbell)', [[100, 1]]);
    expect(liftRanks(state).map((rank) => rank.exercise.name)).toEqual([
      'Deadlift (Barbell)', 'Bench Press (Barbell)', 'Bench Press (Smith Machine)', 'Squat (Barbell)',
    ]);
    expect(rankOf(state, 'Bench Press (Barbell)')!.score).toBeCloseTo(rankOf(state, 'Bench Press (Smith Machine)')!.score);
  });

  it('has nothing left to reach at the top', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[200, 1]]);
    expect(rankOf(state, 'Bench Press (Barbell)')).toMatchObject({ tier: 'legend', division: 3, progress: 1, next: null });
  });
});

describe('a rank in words', () => {
  /** Numbers are shown the way the browser's region writes them: 140.5 or 140,5. */
  const local = (value: number) => fmtNumber(value, 1);

  it('names the estimate and the weight that reaches the next step, rounded up to what can be loaded', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[100, 1]]);
    log(state, 'Squat (Barbell)', [[140, 1]]);
    expect(describeLift(rankOf(state, 'Bench Press (Barbell)')!, 'kg')).toEqual({ best: 'Est. 1RM 100 kg', next: '104 kg for Gold III' });
    // Gold III in the squat begins at 0.65 × 2.7 × 80 = 140.4 kg: 140.5 is the least that does it.
    expect(describeLift(rankOf(state, 'Squat (Barbell)')!, 'kg').next).toBe(`${local(140.5)} kg for Gold III`);
    // In pounds: 104 kg is 229.3 lb, so 230.
    expect(describeLift(rankOf(state, 'Bench Press (Barbell)')!, 'lb')).toEqual({ best: `Est. 1RM ${local(220.5)} lb`, next: '230 lb for Gold III' });
  });

  it('says that a dumbbell lift is counted per dumbbell', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Dumbbell)', [[40, 1]]);
    expect(describeLift(rankOf(state, 'Bench Press (Dumbbell)')!, 'kg').best).toBe('Est. 1RM 40 kg per dumbbell');
  });

  it('counts reps for bodyweight exercises', () => {
    const state = lifter(80);
    log(state, 'Pull Up', [[null, 12]]);
    expect(describeLift(rankOf(state, 'Pull Up')!, 'kg')).toEqual({ best: 'Best set 12 reps', next: '13 reps for Gold I' });

    const single = lifter(80);
    log(single, 'Pull Up', [[null, 1]]);
    expect(describeLift(rankOf(single, 'Pull Up')!, 'kg')).toEqual({ best: 'Best set 1 rep', next: '2 reps for Iron III' });

    const weighted = lifter(80);
    log(weighted, 'Pull Up', [[20, 5]]);
    expect(describeLift(rankOf(weighted, 'Pull Up')!, 'kg').best).toBe('Best set worth 13 reps');
  });

  it('has no next step at the top', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[200, 1]]);
    expect(describeLift(rankOf(state, 'Bench Press (Barbell)')!, 'kg').next).toBeNull();
    expect(stepAfter(rankFor(2))).toBeNull();
    expect(stepAfter(rankFor(0.69))).toEqual({ tier: 'platinum', division: 1 });
  });
});

describe('the overall rank', () => {
  it('averages the best push, pull and leg lift', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[100, 1]]); // 0.625
    log(state, 'Overhead Press (Barbell)', [[40, 1]]); // push too, but weaker
    log(state, 'Deadlift (Barbell)', [[180, 1]]); // 0.75
    log(state, 'Squat (Barbell)', [[108, 1]]); // 0.5
    log(state, 'Cable Crunch', [[128, 1]]); // strong, but core is none of the three
    const overall = overallRank(liftRanks(state));
    expect(overall.best.push?.exercise.name).toBe('Bench Press (Barbell)');
    expect(overall.best.pull?.exercise.name).toBe('Deadlift (Barbell)');
    expect(overall.best.legs?.exercise.name).toBe('Squat (Barbell)');
    expect(overall.rank!.score).toBeCloseTo((0.625 + 0.75 + 0.5) / 3);
    expect(rankTitle(overall.rank!)).toBe('Gold II');
  });

  it('counts a part of the body with nothing ranked as zero', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[100, 1]]);
    const overall = overallRank(liftRanks(state));
    expect(overall.best).toMatchObject({ pull: null, legs: null });
    expect(overall.rank!.score).toBeCloseTo(0.625 / 3);
    expect(rankTitle(overall.rank!)).toBe('Iron III');
  });

  it('does not exist before any lift is ranked', () => {
    expect(overallRank([])).toEqual({ rank: null, best: { push: null, pull: null, legs: null } });
  });
});

describe('a rank for each part of the body', () => {
  const partOf = (state: AppState, part: string) => bodyPartRanks(liftRanks(state)).find((entry) => entry.part === part)!;

  it("is that of the part's best lift", () => {
    const state = lifter(80);
    log(state, 'Incline Bench Press (Barbell)', [[60, 1]]); // the weaker of the two chest lifts
    log(state, 'Bench Press (Barbell)', [[100, 1]]); // 0.625
    log(state, 'Squat (Barbell)', [[108, 1]]); // 0.5
    expect(partOf(state, 'chest').best?.exercise.name).toBe('Bench Press (Barbell)');
    expect(rankTitle(partOf(state, 'chest').best!)).toBe('Gold II');
    expect(partOf(state, 'chest').lifts).toBe(2);
    // Whatever order the lifts come in.
    const weakestFirst = [...liftRanks(state)].reverse();
    expect(bodyPartRanks(weakestFirst).find((entry) => entry.part === 'chest')!.best?.exercise.name).toBe('Bench Press (Barbell)');
    expect(partOf(state, 'quads')).toMatchObject({ lifts: 1, best: { exercise: { name: 'Squat (Barbell)' } } });
  });

  it('lists every part, ranked or not, from the top of the body down', () => {
    const state = lifter(80);
    log(state, 'Squat (Barbell)', [[108, 1]]);
    const parts = bodyPartRanks(liftRanks(state));
    expect(parts.map((entry) => entry.part)).toEqual([...BODY_PARTS]);
    expect(parts.filter((entry) => entry.best).map((entry) => entry.part)).toEqual(['quads']);
    expect(partOf(state, 'calves')).toEqual({ part: 'calves', best: null, lifts: 0 });
  });

  it('counts a lift for the one muscle it is listed under', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[100, 1]]);
    // A bench press works the triceps and the shoulders too, but it is listed under the chest.
    expect(partOf(state, 'chest').best).not.toBeNull();
    expect(partOf(state, 'triceps').best).toBeNull();
    expect(partOf(state, 'shoulders').best).toBeNull();
  });

  it('leaves out a lift that belongs to no one part', () => {
    const state = lifter(80);
    log(state, 'Power Clean (Barbell)', [[100, 1]]); // listed as full body
    expect(liftRanks(state)).toHaveLength(1);
    expect(bodyPartRanks(liftRanks(state)).every((entry) => entry.best === null && entry.lifts === 0)).toBe(true);
  });
});

describe('rank-ups', () => {
  it('are the lifts that stand higher than before, biggest climb first', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[100, 1]]);
    log(state, 'Squat (Barbell)', [[100, 1]]);
    log(state, 'Deadlift (Barbell)', [[180, 1]]);
    const before = liftRanks(state);

    log(state, 'Bench Press (Barbell)', [[104, 1]], { active: true, daysAgo: 0 }); // Gold II → Gold III
    log(state, 'Squat (Barbell)', [[150, 1]], { active: true, daysAgo: 0 }); // Silver I → Gold III
    log(state, 'Deadlift (Barbell)', [[185, 1]], { active: true, daysAgo: 0 }); // better, but the same step
    log(state, 'Pull Up', [[null, 12]], { active: true, daysAgo: 0 }); // first rank
    const ups = rankUps(before, liftRanks(state, { includeActive: true }));

    expect(ups.map((up) => [up.exercise.name, up.from && rankTitle(up.from), rankTitle(up.to)])).toEqual([
      ['Pull Up', null, 'Silver III'],
      ['Squat (Barbell)', 'Silver I', 'Gold III'],
      ['Bench Press (Barbell)', 'Gold II', 'Gold III'],
    ]);
  });

  it('are none when nothing changed, or a lift went down', () => {
    const state = lifter(80);
    log(state, 'Bench Press (Barbell)', [[100, 1]]);
    const ranks = liftRanks(state);
    expect(rankUps(ranks, ranks)).toEqual([]);
    state.bodyWeights.push({ id: uid(), date: NOW, kg: 100 });
    expect(rankUps(ranks, liftRanks(state))).toEqual([]);
  });
});
