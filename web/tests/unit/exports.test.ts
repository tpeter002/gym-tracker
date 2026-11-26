import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportBackup, parseBackup } from '../../src/lib/backup';
import { seedLibrary } from '../../src/lib/exercises';
import {
  connectGarmin, connections, exportBody, loadConnections, queueExports, sendWaiting, sendWorkout, stravaConnectAddress, waitingExports,
} from '../../src/lib/exports';
import { getState, replaceState } from '../../src/lib/store';
import { defaultSettings, emptyState, normalizeSettings } from '../../src/lib/types';
import type { AppState, Workout } from '../../src/lib/types';
import { addExercise, finishWorkout, startEmpty } from '../../src/lib/workouts';

// Sending finished workouts to Strava and Garmin Connect: which workouts are
// queued, what the analyzer is sent, and what is recorded about the outcome.

const START = new Date(2026, 10, 26, 18, 0).getTime();

/** A state with one finished workout: bench press (a warm-up, two working sets, one left unticked) and pull ups. */
function finished(): { state: AppState; workout: Workout } {
  const state = emptyState();
  seedLibrary(state);
  const id = startEmpty(state, START);
  const workout = state.workouts[0];
  workout.name = 'Push';
  workout.notes = 'Felt strong.';
  addExercise(state, id, state.exercises.find((exercise) => exercise.name === 'Bench Press (Barbell)')!.id);
  addExercise(state, id, state.exercises.find((exercise) => exercise.name === 'Pull Up')!.id);
  addExercise(state, id, state.exercises.find((exercise) => exercise.name === 'Plank')!.id);
  const [bench, pullUp] = workout.entries;
  Object.assign(bench.sets[0], { weight: 40, reps: 10, isWarmup: true, isDone: true });
  Object.assign(bench.sets[1], { weight: 87.5, reps: 8, rpe: 7.5, isDone: true });
  Object.assign(bench.sets[2], { weight: 87.5, reps: 7 }); // typed in but never ticked
  Object.assign(pullUp.sets[0], { reps: 9, isDone: true });
  finishWorkout(state, id, START + 62 * 60_000);
  return { state, workout };
}

describe('the setting', () => {
  it('is off for both services until switched on', () => {
    expect(defaultSettings().autoExport).toEqual({ strava: false, garmin: false });
    // Settings saved before the feature existed, and nonsense, read as off.
    expect(normalizeSettings({ unit: 'kg' }).autoExport).toEqual({ strava: false, garmin: false });
    expect(normalizeSettings({ autoExport: { strava: 'yes', garmin: 1 } }).autoExport).toEqual({ strava: false, garmin: false });
    expect(normalizeSettings({ autoExport: { strava: true, garmin: false, fitbit: true } }).autoExport).toEqual({ strava: true, garmin: false });
  });
});

describe('queueing a finished workout', () => {
  it('marks it for the services that are switched on', () => {
    const { state, workout } = finished();
    queueExports(state, workout.id, 5000);
    expect(workout.exports).toBeUndefined();
    expect(waitingExports(state)).toEqual([]);

    state.settings.autoExport.strava = true;
    queueExports(state, workout.id, 5000);
    expect(workout.exports).toEqual({ strava: { status: 'waiting', at: 5000 } });

    state.settings.autoExport.garmin = true;
    queueExports(state, workout.id, 6000);
    // Strava's entry is left as it was; Garmin's is added.
    expect(workout.exports).toEqual({ strava: { status: 'waiting', at: 5000 }, garmin: { status: 'waiting', at: 6000 } });
    expect(waitingExports(state)).toEqual([{ workoutId: workout.id, target: 'strava' }, { workoutId: workout.id, target: 'garmin' }]);
  });

  it('leaves alone what was already sent, and workouts still in progress', () => {
    const { state, workout } = finished();
    state.settings.autoExport = { strava: true, garmin: true };
    workout.exports = { strava: { status: 'sent', at: 1, url: 'https://www.strava.com/activities/1' } };
    queueExports(state, workout.id, 5000);
    expect(workout.exports.strava).toEqual({ status: 'sent', at: 1, url: 'https://www.strava.com/activities/1' });
    expect(workout.exports.garmin).toEqual({ status: 'waiting', at: 5000 });

    const running = startEmpty(state, START + 100_000_000);
    queueExports(state, running, 5000);
    expect(state.workouts.find((candidate) => candidate.id === running)!.exports).toBeUndefined();
    queueExports(state, 'no-such-workout', 5000); // doesn't throw
  });

  it('lists what is waiting oldest first', () => {
    const { state, workout } = finished();
    const older: Workout = { ...workout, id: 'older', startedAt: START - 86_400_000, exports: { garmin: { status: 'waiting', at: 1 } } };
    state.workouts.push(older);
    workout.exports = { strava: { status: 'waiting', at: 2 }, garmin: { status: 'failed', at: 3, error: 'no' } };
    expect(waitingExports(state)).toEqual([{ workoutId: 'older', target: 'garmin' }, { workoutId: workout.id, target: 'strava' }]);
  });
});

describe('what the analyzer is sent', () => {
  it('is the workout as logged: completed sets, kilograms, and the display settings', () => {
    const { state, workout } = finished();
    state.settings.unit = 'lb';
    state.settings.effort = 'rir';
    expect(exportBody(state, workout)).toEqual({
      unit: 'lb',
      effort: 'rir',
      workout: {
        id: workout.id,
        name: 'Push',
        started_at: START,
        ended_at: START + 62 * 60_000,
        utc_offset_minutes: -new Date(START).getTimezoneOffset(),
        notes: 'Felt strong.',
        exercises: [
          { name: 'Bench Press (Barbell)', muscle: 'chest', sets: [
            { weight: 40, reps: 10, rpe: null, warmup: true },
            { weight: 87.5, reps: 8, rpe: 7.5, warmup: false },
          ] },
          { name: 'Pull Up', muscle: 'back', sets: [{ weight: null, reps: 9, rpe: null, warmup: false }] },
          // The plank had no completed set, so finishing the workout dropped it.
        ],
      },
    });
  });

  it('leaves out a set that was never ticked, however it got into a finished workout', () => {
    const { state, workout } = finished();
    // Finishing drops unticked sets, but a restored or hand-edited backup might still carry one.
    workout.entries[1].sets.push({ id: 'stray', weight: 20, reps: 5, rpe: null, isWarmup: false, isDone: false });
    workout.entries.push({ id: 'untouched', exerciseId: null, exerciseName: 'Never Started', notes: '', sets: [
      { id: 'stray-2', weight: null, reps: null, rpe: null, isWarmup: false, isDone: false },
    ] });
    const exercises = (exportBody(state, workout).workout as { exercises: { name: string; sets: unknown[] }[] }).exercises;
    expect(exercises.map((exercise) => [exercise.name, exercise.sets.length])).toEqual([['Bench Press (Barbell)', 2], ['Pull Up', 1]]);
  });

  it('still names an exercise that has since been deleted', () => {
    const { state, workout } = finished();
    workout.entries[0].exerciseId = null;
    const exercises = (exportBody(state, workout).workout as { exercises: { name: string; muscle: string }[] }).exercises;
    expect(exercises[0]).toMatchObject({ name: 'Bench Press (Barbell)', muscle: '' });
  });
});

describe('backups', () => {
  it('carry where each workout was sent', () => {
    const { state, workout } = finished();
    workout.exports = {
      strava: { status: 'sent', at: 10, url: 'https://www.strava.com/activities/1' },
      garmin: { status: 'failed', at: 20, error: 'Garmin Connect couldn’t be reached.' },
    };
    state.settings.autoExport.strava = true;
    const restored = parseBackup(exportBackup(state)).state;
    expect(restored.workouts[0].exports).toEqual(workout.exports);
    expect(restored.settings.autoExport).toEqual({ strava: true, garmin: false });
  });

  it('take nothing odd from a file', () => {
    const { state, workout } = finished();
    const file = JSON.parse(exportBackup(state));
    file.data.workouts[0].exports = {
      strava: { status: 'sent', at: 'yesterday', url: 'javascript:alert(1)' },
      garmin: { status: 'celebrated' },
      fitbit: { status: 'sent', at: 1 },
    };
    expect(parseBackup(JSON.stringify(file)).state.workouts[0].exports).toEqual({
      strava: { status: 'sent', at: 0 },
      garmin: { status: 'failed', at: 0 },
    });
    // And a workout that was never sent anywhere has no such field at all.
    expect('exports' in parseBackup(exportBackup(state)).state.workouts[0]).toBe(false);
    expect(workout.exports).toBeUndefined();
  });
});

describe('talking to the analyzer', () => {
  const fetched = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
  const posted = (path: string) => fetched.mock.calls.filter(([url, init]) => url.endsWith(path) && init?.method === 'POST');
  const CONNECTED = {
    strava: { configured: true, connected: true, account: 'Sam Lifter' },
    garmin: { configured: true, connected: false, account: null },
  };
  let workout: Workout;

  /** The analyzer as a function from path to answer. */
  function analyzer(answers: Record<string, () => Response | Promise<Response>>): void {
    fetched.mockImplementation(async (url) => {
      const path = new URL(url).pathname;
      const answer = answers[path] ?? (path === '/health' ? () => json({ ok: true }) : undefined);
      if (!answer) throw new TypeError('Failed to fetch');
      return answer();
    });
  }

  beforeEach(() => {
    fetched.mockReset();
    vi.stubGlobal('fetch', fetched);
    vi.stubGlobal('document', { baseURI: 'http://localhost:8787/' });
    const made = finished();
    workout = made.workout;
    made.state.settings.autoExport.strava = true;
    queueExports(made.state, workout.id, 5000);
    replaceState(made.state);
    connections.set(null);
  });
  afterEach(() => vi.unstubAllGlobals());

  const exported = () => getState().workouts.find((candidate) => candidate.id === workout.id)!.exports;

  it('sends what is waiting and records the link', async () => {
    analyzer({ '/exports/strava': () => json({ id: '77', url: 'https://www.strava.com/activities/77', already: false }) });
    await sendWaiting();
    expect(posted('/exports/strava')).toHaveLength(1);
    expect(JSON.parse(posted('/exports/strava')[0][1]!.body as string)).toEqual(exportBody(getState(), workout));
    expect(exported()).toEqual({ strava: { status: 'sent', at: expect.any(Number), url: 'https://www.strava.com/activities/77' } });

    await sendWaiting(); // nothing is waiting any more
    expect(posted('/exports/strava')).toHaveLength(1);
  });

  it('keeps a workout waiting while the analyzer or the service is out of reach', async () => {
    analyzer({ '/health': () => { throw new TypeError('Failed to fetch'); } });
    await sendWaiting();
    expect(posted('/exports/strava')).toHaveLength(0); // didn't even try
    expect(exported()).toEqual({ strava: { status: 'waiting', at: 5000 } });

    for (const status of [429, 502, 503]) {
      analyzer({ '/exports/strava': () => json({ detail: 'The analyzer couldn’t reach Strava.' }, status) });
      await sendWaiting();
      expect(exported()).toEqual({ strava: { status: 'waiting', at: 5000, error: 'The analyzer couldn’t reach Strava.' } });
    }

    analyzer({ '/exports/strava': () => json({ id: '1', url: 'https://www.strava.com/activities/1' }) });
    await sendWaiting();
    expect(exported()!.strava).toMatchObject({ status: 'sent', url: 'https://www.strava.com/activities/1' });
    expect(exported()!.strava!.error).toBeUndefined();
  });

  it('stops trying once the answer is a refusal, and says why', async () => {
    analyzer({
      '/exports/strava': () => json({ detail: 'Strava isn’t connected; connect again in the app under Settings → Connections.' }, 409),
      '/connections': () => json({ ...CONNECTED, strava: { configured: true, connected: false, account: null } }),
    });
    await sendWaiting();
    expect(exported()).toEqual({
      strava: { status: 'failed', at: expect.any(Number), error: 'Strava isn’t connected; connect again in the app under Settings → Connections.' },
    });
    await sendWaiting();
    expect(posted('/exports/strava')).toHaveLength(1); // a failed workout is not retried by itself

    // Asking for it by hand tries again.
    analyzer({ '/exports/strava': () => json({ id: '9', url: 'https://www.strava.com/activities/9' }) });
    await sendWorkout(workout.id, 'strava');
    expect(exported()!.strava!.status).toBe('sent');
  });

  it('does not send the same workout twice at once', async () => {
    let release = () => {};
    analyzer({ '/exports/garmin': () => new Promise<Response>((resolve) => { release = () => resolve(json({ id: '5', url: 'https://connect.garmin.com/modern/activity/5' })); }) });
    const first = sendWorkout(workout.id, 'garmin');
    const second = sendWorkout(workout.id, 'garmin');
    await second; // returns at once: the first is still on its way
    release();
    await first;
    expect(posted('/exports/garmin')).toHaveLength(1);
    expect(exported()!.garmin!.status).toBe('sent');
  });

  it('reads the connections, and none from something that is not the analyzer', async () => {
    analyzer({ '/connections': () => json(CONNECTED) });
    expect(await loadConnections()).toEqual(CONNECTED);
    expect(connections.get()).toEqual(CONNECTED);

    analyzer({ '/connections': () => new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } }) });
    expect(await loadConnections()).toBeNull();
    analyzer({ '/connections': () => json({ detail: 'Not Found' }, 404) }); // an analyzer from before connections existed
    expect(await loadConnections()).toBeNull();
    expect(connections.get()).toBeNull();
  });

  it('signs in to Garmin, with a verification code when one is asked for', async () => {
    analyzer({ '/garmin/connect': () => json({ detail: 'Garmin sent a verification code to your email or phone; enter it to finish.' }, 409, { 'x-needs-code': '1' }) });
    expect(await connectGarmin('sam@example.org', 'correct-horse')).toEqual({
      connected: false, needsCode: true, message: 'Garmin sent a verification code to your email or phone; enter it to finish.',
    });
    expect(JSON.parse(posted('/garmin/connect')[0][1]!.body as string)).toEqual({ email: 'sam@example.org', password: 'correct-horse' });

    const both = { ...CONNECTED, garmin: { configured: true, connected: true, account: 'Sam Lifter' } };
    analyzer({ '/garmin/connect': () => json(both) });
    expect(await connectGarmin('sam@example.org', 'correct-horse', '123456')).toEqual({ connected: true, needsCode: false, message: null });
    // With a code, the code is all that is sent: the password went with the first request.
    expect(JSON.parse(posted('/garmin/connect').at(-1)![1]!.body as string)).toEqual({ mfa_code: '123456' });
    expect(connections.get()).toEqual(both);

    analyzer({ '/garmin/connect': () => json({ detail: 'Garmin didn’t accept the login (Invalid credentials).' }, 401) });
    expect(await connectGarmin('sam@example.org', 'nope')).toEqual({ connected: false, needsCode: false, message: 'Garmin didn’t accept the login (Invalid credentials).' });
    analyzer({});
    expect((await connectGarmin('a', 'b')).message).toBe("Couldn't reach the analyzer.");
  });

  it('builds the address that starts the Strava approval', () => {
    expect(stravaConnectAddress('', 'http://localhost:8787/#/settings', '/#/settings'))
      .toBe('http://localhost:8787/strava/connect?back=%2F%23%2Fsettings');
    expect(stravaConnectAddress('my-mac.local:8787', 'https://example.org/gym/', '/gym/#/settings'))
      .toBe('http://my-mac.local:8787/strava/connect?back=%2Fgym%2F%23%2Fsettings');
  });
});
