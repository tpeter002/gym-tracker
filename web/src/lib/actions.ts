import { navigate } from './router';
import { getState, signal, update } from './store';
import type { Settings } from './types';
import { activeWorkout, startEmpty, startRepeat } from './workouts';

export type StartRequest = { kind: 'empty' } | { kind: 'repeat'; workoutId: string };

/** Set when a workout is asked for while another is running; the app shows the question. */
export const startConflict = signal<StartRequest | null>(null);

export function requestStart(request: StartRequest): void {
  if (activeWorkout(getState())) startConflict.set(request);
  else beginWorkout(request);
}

export function beginWorkout(request: StartRequest): void {
  update((draft) => {
    if (request.kind === 'empty') startEmpty(draft);
    else startRepeat(draft, request.workoutId);
  });
  navigate('/workout');
}

export function changeSettings(patch: Partial<Settings>): void {
  update((draft) => {
    Object.assign(draft.settings, patch);
  });
}
