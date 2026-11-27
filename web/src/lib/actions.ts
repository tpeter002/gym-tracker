import { navigate } from './router';
import { signal } from './signal';
import { getState, update } from './store';
import type { Settings } from './types';
import { activeWorkout, startEmpty, startRepeat } from './workouts';

/** `name`: what the new workout is called when it repeats a routine rather than a workout. */
export type StartRequest = { kind: 'empty' } | { kind: 'repeat'; workoutId: string; name?: string };

/** Set when a workout is asked for while another is running; the app shows the question. */
export const startConflict = signal<StartRequest | null>(null);

export function requestStart(request: StartRequest): void {
  if (activeWorkout(getState())) startConflict.set(request);
  else beginWorkout(request);
}

export function beginWorkout(request: StartRequest): void {
  update((draft) => {
    if (request.kind === 'empty') startEmpty(draft);
    else startRepeat(draft, request.workoutId, Date.now(), request.name);
  });
  navigate('/workout');
}

export function changeSettings(patch: Partial<Settings>): void {
  update((draft) => {
    Object.assign(draft.settings, patch);
  });
}
