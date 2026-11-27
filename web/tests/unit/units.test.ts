import { describe, expect, it } from 'vitest';
import { GENERIC_NAME } from '../../src/lib/suggestions';
import { fmtNumber, parseDecimal } from '../../src/lib/units';
import { defaultWorkoutName, estimatedOneRepMax, MAX_REPS_FOR_ESTIMATE, oneRepMax } from '../../src/lib/workouts';

// Numbers as they are shown and worked out. The tests run under the machine's
// own region, which may write a decimal comma: the patterns accept either.

describe('showing a number', () => {
  it('drops trailing zeros, keeps at most the decimals asked for, and never groups digits', () => {
    expect(fmtNumber(80)).toBe('80');
    expect(fmtNumber(82.5)).toMatch(/^82[.,]5$/);
    expect(fmtNumber(61.254)).toMatch(/^61[.,]25$/);
    expect(fmtNumber(61.254, 1)).toMatch(/^61[.,]3$/);
    expect(fmtNumber(1234.5)).toMatch(/^1234[.,]5$/);
    expect(fmtNumber(1_000_000)).toBe('1000000');
  });

  it('writes a change too small to show as 0, not -0', () => {
    expect(fmtNumber(-0.04, 1)).toBe('0');
    expect(fmtNumber(-0)).toBe('0');
    expect(fmtNumber(-0.4, 1)).toMatch(/^-0[.,]4$/);
  });

  it('comes back as the same number when typed into a field', () => {
    for (const value of [0, 7.5, 82.5, 61.25, 140]) {
      expect(parseDecimal(fmtNumber(value))).toBe(value);
    }
  });
});

describe('the estimated one-rep max', () => {
  it('is the weight itself for a single, and grows with reps', () => {
    expect(oneRepMax(100, 1)).toBe(100);
    expect(oneRepMax(100, 5)).toBeCloseTo(116.67, 2);
    expect(oneRepMax(80, 8)).toBeCloseTo(101.33, 2);
  });

  it('stops growing at twelve reps: a long set says little about one heavy rep', () => {
    expect(MAX_REPS_FOR_ESTIMATE).toBe(12);
    expect(oneRepMax(50, 12)).toBeCloseTo(70);
    expect(oneRepMax(50, 20)).toBeCloseTo(70);
    expect(oneRepMax(50, 100)).toBeCloseTo(70);
  });

  it('is not made up for a set without weight or reps', () => {
    const set = { id: 's', rpe: null, isWarmup: false, isDone: true };
    expect(estimatedOneRepMax({ ...set, weight: 50, reps: 20 })).toBeCloseTo(70);
    expect(estimatedOneRepMax({ ...set, weight: null, reps: 12 })).toBeNull();
    expect(estimatedOneRepMax({ ...set, weight: 50, reps: null })).toBeNull();
    expect(estimatedOneRepMax({ ...set, weight: 0, reps: 5 })).toBeNull();
  });
});

describe('the name a workout gets when nobody names it', () => {
  it('follows the time of day', () => {
    const at = (hour: number) => defaultWorkoutName(new Date(2026, 10, 27, hour, 30).getTime());
    expect([at(6), at(12), at(15), at(19), at(23), at(3)]).toEqual([
      'Morning Workout', 'Midday Workout', 'Afternoon Workout', 'Evening Workout', 'Night Workout', 'Night Workout',
    ]);
  });

  it('is always recognised as saying nothing about what was trained', () => {
    // "Up next" groups workouts by the name someone chose; these must never count as chosen.
    for (let hour = 0; hour < 24; hour++) {
      const name = defaultWorkoutName(new Date(2026, 10, 27, hour).getTime());
      expect(GENERIC_NAME.test(name), name).toBe(true);
    }
    expect(GENERIC_NAME.test('Push')).toBe(false);
    expect(GENERIC_NAME.test('Leg Workout')).toBe(false);
  });
});
