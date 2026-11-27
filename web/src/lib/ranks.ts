import { normalizeName } from './exercises';
import { LIBRARY } from './library';
import { STANDARD_LINES } from './standards';
import { REGIONS } from './suggestions';
import type { AppState, Equipment, Exercise, MuscleGroup, RankStandards, WeightUnit, Workout } from './types';
import { fmtNumber, fromKg } from './units';

// A rank for every lift: how the best set you have logged compares with what
// strong lifters of your body weight manage (standards.ts). Seven tiers of
// three steps each, so there is always a next step within reach.

export const TIERS = ['iron', 'bronze', 'silver', 'gold', 'platinum', 'diamond', 'legend'] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_TITLES: Record<Tier, string> = {
  iron: 'Iron', bronze: 'Bronze', silver: 'Silver', gold: 'Gold', platinum: 'Platinum', diamond: 'Diamond', legend: 'Legend',
};

/**
 * The score at which each tier begins. A score is the share of the top tier's
 * requirement: 1 is Legend's doorstep, 0.55 means 55% of that.
 */
const TIER_STARTS = [0, 0.3, 0.42, 0.55, 0.7, 0.85, 1];
/** Legend has no tier above it to mark its end; its three steps span this much. */
const TOP_TIER_SPAN = 0.15;
export const DIVISIONS = 3;
export const STEPS = TIERS.length * DIVISIONS;
const BRONZE = TIER_STARTS[1];

const DIVISION_MARKS = ['I', 'II', 'III'];
/** Reps past this add nothing to a weighted lift's estimate: a 30-rep set says little about a one-rep max. */
const MAX_REPS_WEIGHTED = 12;
const MAX_REPS_BODYWEIGHT = 150;
/** Women's requirements as a share of men's, by where the muscle is. */
const WOMEN_UPPER_BODY = 0.68;
const WOMEN_LOWER_BODY = 0.75;
const UPPER_BODY: ReadonlySet<MuscleGroup> = new Set(['chest', 'back', 'shoulders', 'biceps', 'triceps', 'forearms']);

export interface Rank {
  tier: Tier;
  /** 1 to 3 within the tier; 3 is the highest. */
  division: number;
  /** 0 (Iron I) to 20 (Legend III). */
  step: number;
  score: number;
  /** How far along this step is, 0 to 1; 1 at the very top. */
  progress: number;
}

/** "Gold II" */
export const rankTitle = (rank: Pick<Rank, 'tier' | 'division'>) => `${TIER_TITLES[rank.tier]} ${DIVISION_MARKS[rank.division - 1]}`;

/** The score at which a step begins. */
export function stepStart(step: number): number {
  const tier = Math.floor(step / DIVISIONS);
  const start = TIER_STARTS[tier];
  const end = TIER_STARTS[tier + 1] ?? start + TOP_TIER_SPAN;
  return start + ((end - start) * (step % DIVISIONS)) / DIVISIONS;
}

const describeStep = (step: number) => ({ tier: TIERS[Math.floor(step / DIVISIONS)], division: (step % DIVISIONS) + 1 });

/** The step above a rank; null at the top. */
export const stepAfter = (rank: Pick<Rank, 'step'>) => (rank.step < STEPS - 1 ? describeStep(rank.step + 1) : null);

export function rankFor(score: number): Rank {
  let step = 0;
  // The tiny allowance keeps a lift that is exactly on a threshold from missing it by rounding.
  while (step < STEPS - 1 && score + 1e-9 >= stepStart(step + 1)) step += 1;
  const start = stepStart(step);
  const progress = step === STEPS - 1 ? 1 : Math.min(1, Math.max(0, (score - start) / (stepStart(step + 1) - start)));
  return { ...describeStep(step), step, score, progress };
}

// --- the standard an exercise is measured against ---------------------------------

export interface Standard {
  /** The library exercise the line was written for. */
  name: string;
  /** Its name without the equipment in parentheses, as words. */
  movement: string[];
  equipment: Equipment;
  muscle: MuscleGroup;
  /** weight: ranked by estimated one-rep max. bodyweight: by reps, with any added weight on top. */
  kind: 'weight' | 'bodyweight';
  /** weight: the top tier's multiple of body weight. bodyweight: the top tier's reps. For men. */
  top: number;
  /** bodyweight only: the reps at which Bronze begins. For men. */
  low: number;
}

const movementOf = (name: string) => normalizeName(name.replace(/\([^)]*\)\s*$/, '')).split(' ').filter(Boolean);

export const STANDARDS: Standard[] = STANDARD_LINES.trim().split('\n').map((line) => {
  const [name, value] = line.split('|').map((part) => part.trim());
  const item = LIBRARY.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`standards.ts names "${name}", which is not in the exercise library`);
  const reps = /^(\d+)-(\d+)$/.exec(value);
  return {
    name, movement: movementOf(name), equipment: item.equipment, muscle: item.muscle,
    kind: reps ? 'bodyweight' : 'weight',
    top: reps ? Number(reps[2]) : Number(value),
    low: reps ? Number(reps[1]) : 0,
  };
});

const BY_NAME = new Map(STANDARDS.map((standard) => [normalizeName(standard.name), standard]));

/**
 * The standard for an exercise: its own line when it is a library exercise,
 * otherwise the most specific library movement its name contains — "Paused
 * Bench Press (Barbell)" is measured as a barbell bench press. The equipment
 * has to agree, because one dumbbell and a loaded bar are logged differently.
 */
export function standardFor(exercise: Pick<Exercise, 'name' | 'equipment'>): Standard | null {
  const exact = BY_NAME.get(normalizeName(exercise.name));
  if (exact) return exact;
  const words = new Set(normalizeName(exercise.name).split(' '));
  let found: Standard | null = null;
  for (const standard of STANDARDS) {
    if (standard.equipment !== exercise.equipment || !standard.movement.every((word) => words.has(word))) continue;
    if (!found || standard.movement.length > found.movement.length) found = standard;
  }
  return found;
}

/** A standard as numbers to compare a performance with: what scores nothing, where Bronze begins, where Legend does. */
interface Anchors { base: number; low: number; top: number }

const repsToLoad = (reps: number) => 1 + reps / 30; // Epley

function anchors(standard: Standard, who: RankStandards): Anchors {
  const share = who === 'men' ? 1 : UPPER_BODY.has(standard.muscle) ? WOMEN_UPPER_BODY : WOMEN_LOWER_BODY;
  if (standard.kind === 'weight') return { base: 0, low: BRONZE * standard.top * share, top: standard.top * share };
  // Hanging from the bar scores nothing; the reps are what count.
  return { base: 1, low: repsToLoad(standard.low * share), top: repsToLoad(standard.top * share) };
}

const scoreOf = (value: number, { base, low, top }: Anchors) =>
  value >= low
    ? BRONZE + ((1 - BRONZE) * (value - low)) / (top - low)
    : (BRONZE * Math.max(0, value - base)) / (low - base);

const valueAt = (score: number, { base, low, top }: Anchors) =>
  score >= BRONZE
    ? low + ((score - BRONZE) * (top - low)) / (1 - BRONZE)
    : base + (score * (low - base)) / BRONZE;

// --- your best on each exercise ---------------------------------------------------

interface Best {
  /** Highest estimated one-rep max among weighted sets, in kilograms; 0 with none. */
  oneRepMaxKg: number;
  /** Highest load among all sets when the body counts as part of the weight, in body weights; 0 with none. */
  bodyLoad: number;
}

/** The best working set of every exercise, by exercise id. Warm-ups and unticked sets don't count. */
function bestSets(workouts: readonly Workout[], bodyKg: number, includeActive: boolean): Map<string, Best> {
  const found = new Map<string, Best>();
  for (const workout of workouts) {
    if (workout.endedAt === null && !includeActive) continue;
    for (const entry of workout.entries) {
      if (!entry.exerciseId) continue;
      for (const set of entry.sets) {
        if (!set.isDone || set.isWarmup || !set.reps || set.reps <= 0) continue;
        const weight = Math.max(0, set.weight ?? 0);
        const best = found.get(entry.exerciseId) ?? { oneRepMaxKg: 0, bodyLoad: 0 };
        const oneRepMax = set.reps === 1 ? weight : weight * repsToLoad(Math.min(set.reps, MAX_REPS_WEIGHTED));
        best.oneRepMaxKg = Math.max(best.oneRepMaxKg, oneRepMax);
        best.bodyLoad = Math.max(best.bodyLoad, (1 + weight / bodyKg) * repsToLoad(Math.min(set.reps, MAX_REPS_BODYWEIGHT)));
        found.set(entry.exerciseId, best);
      }
    }
  }
  return found;
}

// --- ranks ------------------------------------------------------------------------

/** What ranks are worked out from: nothing is ranked until both are known. */
export interface RankSetup {
  bodyKg: number;
  standards: RankStandards;
}

export function latestBodyKg(state: AppState): number | null {
  let latest: AppState['bodyWeights'][number] | null = null;
  for (const entry of state.bodyWeights) {
    if (!latest || entry.date > latest.date) latest = entry;
  }
  return latest && latest.kg > 0 ? latest.kg : null;
}

export function rankSetup(state: AppState): RankSetup | null {
  const bodyKg = latestBodyKg(state);
  const standards = state.settings.rankStandards;
  return bodyKg !== null && standards ? { bodyKg, standards } : null;
}

export interface LiftRank extends Rank {
  exercise: Exercise;
  kind: Standard['kind'];
  /** weight: the best estimated one-rep max, in kilograms. bodyweight: the best set, as reps without added weight. */
  best: number;
  /** The next step and what reaches it, in the same terms as `best`; null at the top. */
  next: { tier: Tier; division: number; need: number } | null;
}

/**
 * The rank of every exercise that has a standard and a logged working set,
 * strongest first. Empty until a body weight is logged and standards are
 * chosen. `includeActive` counts the workout in progress as well.
 */
export function liftRanks(state: AppState, { includeActive = false } = {}): LiftRank[] {
  const setup = rankSetup(state);
  if (!setup) return [];
  const bests = bestSets(state.workouts, setup.bodyKg, includeActive);
  const ranks: LiftRank[] = [];
  for (const exercise of state.exercises) {
    const best = bests.get(exercise.id);
    const standard = best && standardFor(exercise);
    if (!best || !standard) continue;
    const marks = anchors(standard, setup.standards);
    const byWeight = standard.kind === 'weight';
    const value = byWeight ? best.oneRepMaxKg / setup.bodyKg : best.bodyLoad;
    if (value <= 0) continue; // a lift that takes weight, logged without any
    const rank = rankFor(scoreOf(value, marks));
    const nextStep = stepAfter(rank);
    const inOwnTerms = (load: number) => (byWeight ? load * setup.bodyKg : (load - 1) * 30);
    ranks.push({
      ...rank,
      exercise,
      kind: standard.kind,
      best: inOwnTerms(value),
      next: nextStep && { ...nextStep, need: inOwnTerms(valueAt(stepStart(rank.step + 1), marks)) },
    });
  }
  return ranks.sort((a, b) => b.score - a.score || a.exercise.name.localeCompare(b.exercise.name, 'en'));
}

/** A lift's standing in words: what it rests on, and what reaches the next step. */
export function describeLift(rank: LiftRank, unit: WeightUnit): { best: string; next: string | null } {
  if (rank.kind === 'weight') {
    // Rounded up to what can be loaded, so the number shown is always enough.
    const plate = unit === 'kg' ? 0.5 : 1;
    const need = rank.next ? Math.ceil(fromKg(unit, rank.next.need) / plate - 1e-6) * plate : 0;
    return {
      best: `Est. 1RM ${fmtNumber(fromKg(unit, rank.best), 1)} ${unit}`,
      next: rank.next && `${fmtNumber(need, 1)} ${unit} for ${rankTitle(rank.next)}`,
    };
  }
  const reps = Math.floor(rank.best + 1e-6);
  const isPlain = Math.abs(rank.best - reps) < 0.01; // with weight added, the set is worth more reps than it had
  return {
    best: `Best set ${isPlain ? '' : 'worth '}${reps} ${reps === 1 ? 'rep' : 'reps'}`,
    next: rank.next && `${Math.ceil(rank.next.need - 1e-6)} reps for ${rankTitle(rank.next)}`,
  };
}

export const BODY_REGIONS = ['push', 'pull', 'legs'] as const;
export type BodyRegion = (typeof BODY_REGIONS)[number];
export const BODY_REGION_TITLES: Record<BodyRegion, string> = { push: 'Push', pull: 'Pull', legs: 'Legs' };

export interface OverallRank {
  /** null until at least one lift is ranked. */
  rank: Rank | null;
  /** The strongest ranked lift of each part of the body. */
  best: Record<BodyRegion, LiftRank | null>;
}

/**
 * One rank for the whole lifter: the average of the best push, pull and leg
 * lift. A part of the body with nothing ranked counts as zero — skipping leg
 * day shows.
 */
export function overallRank(ranks: readonly LiftRank[]): OverallRank {
  const best: OverallRank['best'] = { push: null, pull: null, legs: null };
  for (const rank of ranks) {
    const region = REGIONS[rank.exercise.muscle];
    if (region && (!best[region] || rank.score > best[region].score)) best[region] = rank;
  }
  const total = BODY_REGIONS.reduce((sum, region) => sum + (best[region]?.score ?? 0), 0);
  return { rank: ranks.length > 0 ? rankFor(total / BODY_REGIONS.length) : null, best };
}

export interface RankUp {
  exercise: Exercise;
  /** null when the exercise had no rank before. */
  from: Rank | null;
  to: LiftRank;
}

/** The lifts that stand higher in `after` than in `before`, biggest climb first. */
export function rankUps(before: readonly LiftRank[], after: readonly LiftRank[]): RankUp[] {
  const earlier = new Map(before.map((rank) => [rank.exercise.id, rank]));
  return after
    .map((to) => ({ exercise: to.exercise, from: earlier.get(to.exercise.id) ?? null, to }))
    .filter((change) => change.from === null || change.to.step > change.from.step)
    .sort((a, b) => (b.to.step - (b.from?.step ?? -1)) - (a.to.step - (a.from?.step ?? -1)));
}
