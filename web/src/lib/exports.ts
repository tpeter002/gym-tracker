import { analyzerEndpoint } from './analyzer';
import { checkAnalyzer } from './inbox';
import { getState, signal, update } from './store';
import { EXPORT_TARGETS } from './types';
import type { AppState, ExportState, ExportTarget, Workout } from './types';

// Sending finished workouts to Strava and Garmin Connect. The analyzer service
// holds the connections and does the sending; this is the app's half: which
// workouts are due, what goes into the request, and what came of it.

/** What the analyzer says about one service. */
export interface Connection {
  /** False when the analyzer lacks what it needs to offer the service at all. */
  configured: boolean;
  connected: boolean;
  /** Whose account, as the service names them. */
  account: string | null;
}
export type Connections = Record<ExportTarget, Connection>;

/** The connections as last heard from the analyzer; null when it couldn't be asked. */
export const connections = signal<Connections | null>(null);
/** "workout id:target" of the requests on their way. */
export const sending = signal<ReadonlySet<string>>(new Set());

const endpoint = (path: string) => analyzerEndpoint(getState().settings.analyzerURL, path, document.baseURI);
const isJSON = (response: Response) => (response.headers.get('content-type') ?? '').includes('json');

function readConnections(raw: unknown): Connections | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const body = raw as Record<string, unknown>;
  const read = (value: unknown): Connection | null => {
    if (typeof value !== 'object' || value === null) return null;
    const item = value as Record<string, unknown>;
    return {
      configured: item.configured !== false,
      connected: item.connected === true,
      account: typeof item.account === 'string' && item.account ? item.account : null,
    };
  };
  const strava = read(body.strava);
  const garmin = read(body.garmin);
  return strava && garmin ? { strava, garmin } : null;
}

async function askAnalyzer(path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> | null; needsCode: boolean } | null> {
  try {
    const response = await fetch(endpoint(path), { cache: 'no-store', signal: AbortSignal.timeout(60_000), ...init });
    if (!isJSON(response)) return null; // a static host answering with its own page: no analyzer here
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return { status: response.status, body, needsCode: response.headers.get('x-needs-code') === '1' };
  } catch {
    return null;
  }
}

const post = (path: string, body?: unknown) =>
  askAnalyzer(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}) });

const detail = (body: Record<string, unknown> | null, fallback: string) =>
  (typeof body?.detail === 'string' && body.detail ? body.detail : fallback);

/** Asks the analyzer which services are connected. */
export async function loadConnections(): Promise<Connections | null> {
  const answer = await askAnalyzer('connections');
  const found = answer && answer.status === 200 ? readConnections(answer.body) : null;
  connections.set(found);
  return found;
}

/** Where the browser goes to approve the Strava connection; it comes back to `back`. */
export function stravaConnectAddress(address: string, pageURL: string, back: string): string {
  return `${analyzerEndpoint(address, 'strava/connect', pageURL)}?back=${encodeURIComponent(back)}`;
}

export async function disconnect(target: ExportTarget): Promise<void> {
  const answer = await post(`${target}/disconnect`);
  connections.set(answer && answer.status === 200 ? readConnections(answer.body) : connections.get());
}

export interface GarminAnswer {
  connected: boolean;
  /** Garmin sent a verification code; ask for it and call again with it. */
  needsCode: boolean;
  message: string | null;
}

/** Signs in to Garmin through the analyzer. The password goes there once and is kept nowhere. */
export async function connectGarmin(email: string, password: string, code = ''): Promise<GarminAnswer> {
  const answer = await post('garmin/connect', code ? { mfa_code: code } : { email, password });
  if (!answer) return { connected: false, needsCode: false, message: "Couldn't reach the analyzer." };
  if (answer.status === 200) {
    connections.set(readConnections(answer.body) ?? connections.get());
    return { connected: true, needsCode: false, message: null };
  }
  return { connected: false, needsCode: answer.needsCode, message: detail(answer.body, `Garmin sign-in failed (${answer.status}).`) };
}

// --- which workouts are due, and what is sent -----------------------------------

/**
 * Marks a workout that was just finished for every service set to receive
 * workouts automatically. Only called at that moment: workouts imported from
 * Strong or restored from a backup are never queued by themselves.
 */
export function queueExports(state: AppState, workoutId: string, now = Date.now()): void {
  const workout = state.workouts.find((candidate) => candidate.id === workoutId);
  if (!workout || workout.endedAt === null) return;
  for (const target of EXPORT_TARGETS) {
    if (!state.settings.autoExport[target] || workout.exports?.[target]) continue;
    workout.exports = { ...workout.exports, [target]: { status: 'waiting', at: now } };
  }
}

export function setExport(state: AppState, workoutId: string, target: ExportTarget, next: ExportState): void {
  const workout = state.workouts.find((candidate) => candidate.id === workoutId);
  if (workout) workout.exports = { ...workout.exports, [target]: next };
}

/** Every workout still waiting for a service, oldest first. */
export function waitingExports(state: AppState): { workoutId: string; target: ExportTarget }[] {
  return [...state.workouts]
    .sort((a, b) => a.startedAt - b.startedAt)
    .flatMap((workout) => EXPORT_TARGETS
      .filter((target) => workout.exports?.[target]?.status === 'waiting')
      .map((target) => ({ workoutId: workout.id, target })));
}

/** The request body for the analyzer: the workout as logged, weights in kilograms, plus how the app displays them. */
export function exportBody(state: AppState, workout: Workout): Record<string, unknown> {
  const muscles = new Map(state.exercises.map((exercise) => [exercise.id, exercise.muscle]));
  return {
    unit: state.settings.unit,
    effort: state.settings.effort,
    workout: {
      id: workout.id,
      name: workout.name,
      started_at: workout.startedAt,
      ended_at: workout.endedAt ?? workout.startedAt,
      // What the clock on this device showed, which is what the services ask for.
      utc_offset_minutes: -new Date(workout.startedAt).getTimezoneOffset(),
      notes: workout.notes,
      exercises: workout.entries.map((entry) => ({
        name: entry.exerciseName,
        muscle: (entry.exerciseId && muscles.get(entry.exerciseId)) || '',
        sets: entry.sets.filter((set) => set.isDone).map((set) => ({
          weight: set.weight, reps: set.reps, rpe: set.rpe, warmup: set.isWarmup,
        })),
      })).filter((exercise) => exercise.sets.length > 0),
    },
  };
}

/** Answers that mean "not now" rather than "no": the analyzer or the service is busy or out of reach. */
const TEMPORARY = new Set([429, 500, 502, 503, 504]);

function setSending(key: string, on: boolean): void {
  const next = new Set(sending.get());
  if (on) next.add(key);
  else next.delete(key);
  sending.set(next);
}

/** Sends one workout to one service and records what came of it. */
export async function sendWorkout(workoutId: string, target: ExportTarget): Promise<void> {
  const key = `${workoutId}:${target}`;
  const state = getState();
  const workout = state.workouts.find((candidate) => candidate.id === workoutId);
  if (!workout || workout.endedAt === null || sending.get().has(key)) return;
  setSending(key, true);
  try {
    const answer = await post(`exports/${target}`, exportBody(state, workout));
    const now = Date.now();
    let next: ExportState;
    if (answer && answer.status === 200) {
      next = { status: 'sent', at: now, url: typeof answer.body?.url === 'string' ? answer.body.url : undefined };
    } else if (!answer || TEMPORARY.has(answer.status)) {
      // Stays in the queue; the next sweep tries again.
      next = { status: 'waiting', at: workout.exports?.[target]?.at ?? now, error: answer ? detail(answer.body, '') || undefined : undefined };
    } else {
      next = { status: 'failed', at: now, error: detail(answer.body, `The analyzer returned an error (${answer.status}).`) };
      // A refused connection changes what Settings should show.
      if (answer.status === 401 || answer.status === 409) void loadConnections();
    }
    update((draft) => setExport(draft, workoutId, target, next)); // does nothing if the workout was deleted meanwhile
  } finally {
    setSending(key, false);
  }
}

let isSweeping = false;

/** Sends what is waiting — after a workout is finished, and whenever the app comes to the front. */
export async function sendWaiting(): Promise<void> {
  if (isSweeping || waitingExports(getState()).length === 0) return;
  isSweeping = true;
  try {
    if (!(await checkAnalyzer())) return;
    for (const { workoutId, target } of waitingExports(getState())) await sendWorkout(workoutId, target);
  } finally {
    isSweeping = false;
  }
}
