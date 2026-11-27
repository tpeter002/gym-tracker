import { signal } from './signal';
import type { Settings } from './types';

// The pause between sets. Ticking a set off starts the clock. It is kept in
// memory only: a reload forgets it, and nothing about it is saved.

export interface Rest {
  /** When it is over. */
  endsAt: number;
}

/** The rest that is running or has just ended; null when there is none to show. */
export const rest = signal<Rest | null>(null);

/** The lengths offered in Settings, in seconds; 0 switches the timer off. */
export const REST_CHOICES = [0, 30, 45, 60, 90, 120, 150, 180, 240, 300] as const;
export const DEFAULT_REST_SECONDS = 120;
/** What "Add 30 Seconds" adds. */
export const REST_EXTENSION_SECONDS = 30;
/** How long "Rest over" stays on screen before it goes away by itself. */
export const REST_OVER_SHOWN_MS = 10_000;

/** "2:00", "0:45" */
export function fmtRest(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/** Whole seconds still to go, counted the way a countdown is read: 1 until the very end, never below 0. */
export const restLeft = (value: Rest, now = Date.now()) => Math.max(0, Math.ceil((value.endsAt - now) / 1000));

/** Starts the rest the settings ask for (none, when the timer is off). A rest already running is replaced. */
export function startRest(settings: Pick<Settings, 'restSeconds' | 'restSound'>, now = Date.now()): void {
  if (settings.restSeconds <= 0) return;
  rest.set({ endsAt: now + settings.restSeconds * 1000 });
  scheduleTone(settings.restSound ? settings.restSeconds : null);
}

/** Makes the rest longer; one that is already over starts again from now. */
export function extendRest(settings: Pick<Settings, 'restSound'>, seconds = REST_EXTENSION_SECONDS, now = Date.now()): void {
  const current = rest.get();
  if (!current) return;
  const endsAt = Math.max(current.endsAt, now) + seconds * 1000;
  rest.set({ endsAt });
  scheduleTone(settings.restSound ? (endsAt - now) / 1000 : null);
}

export function skipRest(): void {
  rest.set(null);
  scheduleTone(null);
}

// --- the sound at the end ---------------------------------------------------------
//
// Scheduled when the rest starts rather than played when it ends: browsers only
// let a page make sound in answer to a tap, and the tap is the tick that
// started the rest. A phone's silent switch silences it like any other page.

let audio: AudioContext | null = null;
let tone: OscillatorNode | null = null;

/** Two short beeps `inSeconds` from now, in place of any that were scheduled; null only cancels. */
function scheduleTone(inSeconds: number | null): void {
  try {
    tone?.stop();
  } catch {
    // it had finished already
  }
  tone = null;
  if (inSeconds === null || typeof window === 'undefined') return;
  try {
    const Context = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Context) return;
    audio ??= new Context();
    void audio.resume();
    const at = audio.currentTime + inSeconds;
    const oscillator = audio.createOscillator();
    const volume = audio.createGain();
    oscillator.frequency.value = 880;
    volume.gain.setValueAtTime(0, 0);
    for (const beep of [0, 0.3]) {
      volume.gain.setValueAtTime(0.25, at + beep);
      volume.gain.setValueAtTime(0, at + beep + 0.15);
    }
    oscillator.connect(volume).connect(audio.destination);
    oscillator.start(at);
    oscillator.stop(at + 0.5);
    tone = oscillator;
  } catch {
    // A rest that ends without a sound is still a rest; nothing here is worth an error.
  }
}
