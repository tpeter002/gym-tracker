import { beforeEach, describe, expect, it } from 'vitest';
import { extendRest, fmtRest, rest, REST_CHOICES, restLeft, skipRest, startRest } from '../../src/lib/rest';
import { defaultSettings, normalizeSettings } from '../../src/lib/types';

// The rest between sets: when it starts, how long is left, and the settings behind it.

const NOW = 1_795_800_000_000;
const two = { restSeconds: 120, restSound: false };

beforeEach(() => skipRest());

describe('the rest timer', () => {
  it('starts for as long as the settings say, and counts down like a clock is read', () => {
    startRest(two, NOW);
    const running = rest.get()!;
    expect(running.endsAt).toBe(NOW + 120_000);
    expect(restLeft(running, NOW)).toBe(120);
    expect(restLeft(running, NOW + 400)).toBe(120); // "2:00" until a whole second has gone
    expect(restLeft(running, NOW + 1000)).toBe(119);
    expect(restLeft(running, NOW + 119_500)).toBe(1);
    expect(restLeft(running, NOW + 120_000)).toBe(0);
    expect(restLeft(running, NOW + 500_000)).toBe(0); // over is over, never minus
  });

  it('does not start when it is switched off', () => {
    startRest({ restSeconds: 0, restSound: true }, NOW);
    expect(rest.get()).toBeNull();
  });

  it('starts over when another set is ticked', () => {
    startRest(two, NOW);
    startRest({ restSeconds: 45, restSound: false }, NOW + 60_000);
    expect(rest.get()).toEqual({ endsAt: NOW + 105_000 });
  });

  it('can be made longer; one that is already over starts again from now', () => {
    startRest(two, NOW);
    extendRest(two, 30, NOW + 10_000);
    expect(restLeft(rest.get()!, NOW + 10_000)).toBe(140);

    extendRest(two, 30, NOW + 600_000); // long over
    expect(restLeft(rest.get()!, NOW + 600_000)).toBe(30);
  });

  it('can be skipped, after which there is nothing to extend', () => {
    startRest(two, NOW);
    skipRest();
    expect(rest.get()).toBeNull();
    extendRest(two, 30, NOW);
    expect(rest.get()).toBeNull();
  });

  it('is written minutes:seconds', () => {
    expect([0, 5, 45, 60, 90, 120, 300, 605].map(fmtRest)).toEqual(['0:00', '0:05', '0:45', '1:00', '1:30', '2:00', '5:00', '10:05']);
    expect(fmtRest(-3)).toBe('0:00');
  });
});

describe('its settings', () => {
  it('start at two minutes with the sound on', () => {
    expect(defaultSettings()).toMatchObject({ restSeconds: 120, restSound: true });
    expect(REST_CHOICES).toContain(120);
    expect(REST_CHOICES[0]).toBe(0); // "Off" is one of the choices
  });

  it('are on for settings saved before the timer existed', () => {
    expect(normalizeSettings({ unit: 'lb' })).toMatchObject({ restSeconds: 120, restSound: true });
  });

  it('keep what was chosen, including off and silent', () => {
    expect(normalizeSettings({ restSeconds: 0, restSound: false })).toMatchObject({ restSeconds: 0, restSound: false });
    expect(normalizeSettings({ restSeconds: 45.4 }).restSeconds).toBe(45);
  });

  it('read nonsense as the usual two minutes', () => {
    for (const stored of ['90', -5, 1e9, Number.NaN, null]) {
      expect(normalizeSettings({ restSeconds: stored }).restSeconds).toBe(120);
    }
    expect(normalizeSettings({ restSound: 'no' }).restSound).toBe(true);
  });
});
