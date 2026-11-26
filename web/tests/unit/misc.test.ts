import { describe, expect, it } from 'vitest';
import { analyzerEndpoint, isBlockedAsMixedContent } from '../../src/lib/analyzer';
import { BackupError, exportBackup, parseBackup } from '../../src/lib/backup';
import { seedLibrary } from '../../src/lib/exercises';
import { emptyState } from '../../src/lib/types';
import {
  effortLabel, effortValue, fmtClock, fmtCount, fmtDuration, fmtNumber, fromDateInputValue, fromKg, parseDecimal, rpeFrom,
  toDateInputValue, toKg,
} from '../../src/lib/units';
import { saveVideoLink } from '../../src/lib/videos';
import { addExercise, startEmpty } from '../../src/lib/workouts';
import { niceTicks } from '../../src/ui/Chart';

describe('units and formats', () => {
  it('converts weights both ways', () => {
    expect(fromKg('kg', 80)).toBe(80);
    expect(fromKg('lb', 100)).toBeCloseTo(220.46, 2);
    expect(toKg('lb', fromKg('lb', 61.25))).toBeCloseTo(61.25, 6);
  });

  it('treats RIR as the other end of RPE', () => {
    expect(effortValue('rir', 8)).toBe(2);
    expect(rpeFrom('rir', 2)).toBe(8);
    // Decimals follow the browser's language: "8.5" or "8,5".
    expect(effortLabel('rpe', 8.5)).toBe(`RPE ${fmtNumber(8.5)}`);
    expect(effortLabel('rir', 8)).toBe('2 RIR');
  });

  it('reads decimals typed with a point or a comma', () => {
    expect(parseDecimal('82.5')).toBe(82.5);
    expect(parseDecimal(' 82,5 ')).toBe(82.5);
    expect(parseDecimal('8.')).toBe(8);
    expect(parseDecimal('')).toBeNull();
    expect(parseDecimal('1.2.3')).toBeNull();
    expect(parseDecimal('-5')).toBeNull();
  });

  it('formats counts, durations and the clock', () => {
    expect(fmtCount(1, 'workout')).toBe('1 workout');
    expect(fmtCount(3, 'workout')).toBe('3 workouts');
    expect(fmtDuration(45 * 60)).toBe('45m');
    expect(fmtDuration(65 * 60)).toBe('1h 05m');
    expect(fmtClock(332)).toBe('05:32');
    expect(fmtClock(3932)).toBe('1:05:32');
  });

  it('maps a date field to a time and back', () => {
    const now = new Date(2026, 10, 26, 9, 30).getTime();
    expect(toDateInputValue(now)).toBe('2026-11-26');
    expect(fromDateInputValue('2026-11-26', now)).toBe(now); // today keeps the time of day
    expect(fromDateInputValue('2026-11-20', now)).toBe(new Date(2026, 10, 20, 12).getTime());
    expect(fromDateInputValue('soon', now)).toBeNull();
  });

  it('picks round axis values that cover the data', () => {
    expect(niceTicks(82.7, 84.6)).toEqual([82.5, 83, 83.5, 84, 84.5, 85]);
    expect(niceTicks(80, 100)).toEqual([80, 85, 90, 95, 100]);
    expect(niceTicks(70, 70)).toEqual([69, 69.5, 70, 70.5, 71]);
  });
});

describe('analyzer address', () => {
  const page = 'https://example.org/gym/#/settings';

  it('defaults to the server the page came from', () => {
    expect(analyzerEndpoint('', 'health', 'http://my-mac.local:8787/#/videos')).toBe('http://my-mac.local:8787/health');
    expect(analyzerEndpoint('  ', 'analyze', page)).toBe('https://example.org/gym/analyze');
  });

  it('accepts an address with or without scheme and trailing slash', () => {
    expect(analyzerEndpoint('my-mac.local:8787', 'analyze', page)).toBe('http://my-mac.local:8787/analyze');
    expect(analyzerEndpoint('https://analyzer.example/', 'health', page)).toBe('https://analyzer.example/health');
  });

  it('knows when the browser would block the call', () => {
    expect(isBlockedAsMixedContent('http://my-mac.local:8787', page)).toBe(true);
    expect(isBlockedAsMixedContent('http://localhost:8787', page)).toBe(false);
    expect(isBlockedAsMixedContent('https://analyzer.example', page)).toBe(false);
    expect(isBlockedAsMixedContent('http://my-mac.local:8787', 'http://my-mac.local:5173/')).toBe(false);
    expect(isBlockedAsMixedContent('', page)).toBe(false);
  });
});

describe('backup', () => {
  function sample() {
    const state = emptyState();
    seedLibrary(state);
    const workoutId = startEmpty(state, 1_700_000_000_000);
    addExercise(state, workoutId, state.exercises[0].id);
    state.bodyWeights.push({ id: 'w1', date: 1_700_000_000_000, kg: 84.2 });
    saveVideoLink(state, 'https://www.youtube.com/shorts/abcdefghijk');
    state.settings = { unit: 'lb', effort: 'rir', analyzerURL: 'my-mac.local:8787' };
    return state;
  }

  it('restores exactly what was exported', () => {
    const state = sample();
    const backup = parseBackup(exportBackup(state, 1234));
    expect(backup.exportedAt).toBe(1234);
    expect(backup.state).toEqual(state);
  });

  it('refuses files that are something else', () => {
    expect(() => parseBackup('Date,Workout Name')).toThrow(BackupError);
    expect(() => parseBackup('{"app":"other","data":{}}')).toThrow("That file isn't a Gym Tracker backup.");
    expect(() => parseBackup('{"app":"gym-tracker-web","version":99,"data":{}}')).toThrow(/newer version/);
  });

  it('reports damaged records instead of loading them', () => {
    const raw = JSON.parse(exportBackup(sample()));
    delete raw.data.workouts[0].startedAt;
    expect(() => parseBackup(JSON.stringify(raw))).toThrow('The backup file is damaged (workout date).');
  });

  it('never restores two workouts in progress', () => {
    const state = sample();
    startEmpty(state, 1_600_000_000_000);
    const restored = parseBackup(exportBackup(state)).state;
    expect(restored.workouts.filter((workout) => workout.endedAt === null)).toHaveLength(1);
  });
});
