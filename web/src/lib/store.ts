import { produce } from 'immer';
import { loadState, openDatabase, saveChanges } from './db';
import { seedLibrary } from './exercises';
import { signal, useSignal } from './signal';
import { emptyState } from './types';
import type { AppState } from './types';

// The whole database is held in memory as one immutable value. Changes go
// through `update`, which hands the logic in workouts.ts, videos.ts… a draft
// to modify, then writes whatever records came out different to IndexedDB.

const appState = signal<AppState>(emptyState());

/**
 * ok — changes are being saved. unavailable — the browser gave us no storage
 * (some private windows); nothing outlives the tab. unreadable — there is
 * storage but it couldn't be read; the app runs empty and saves nothing, so
 * what is there stays as it is. failed — the latest write was refused; it is
 * tried again with the next change.
 */
export const storageStatus = signal<'ok' | 'unavailable' | 'unreadable' | 'failed'>('ok');

let database: IDBDatabase | null = null;
/**
 * What the database is known to hold: what was read from it, then each state
 * written in full. Every write goes from here to the current state, so a write
 * that failed is made up for by the next one instead of being lost for good.
 */
let persisted: AppState = appState.get();
/** Writes happen one at a time, in the order they were asked for. */
let saving: Promise<void> = Promise.resolve();
let otherTabs: BroadcastChannel | null = null;
let askedToPersist = false;

export const getState = () => appState.get();
export const useAppState = () => useSignal(appState);

/**
 * Changes the state through a draft and hands back whatever the recipe
 * returns (not a part of the draft: that stops being readable once the change
 * is made).
 */
export function update<T>(recipe: (draft: AppState) => T): T {
  let result!: T;
  // The recipe's return value goes to the caller, never to immer, which would
  // take it for a whole new state: `update((draft) => startRepeat(draft, id))`
  // must not replace everything with an id.
  const after = produce(appState.get(), (draft) => {
    result = recipe(draft);
  });
  commit(after);
  return result;
}

/** Replaces everything, as when restoring a backup. */
export function replaceState(next: AppState): void {
  commit(next);
}

function commit(after: AppState): void {
  if (after === appState.get()) return;
  appState.set(after);
  save();
  // Ask the browser not to evict the data once there is something worth keeping.
  if (!askedToPersist && after.workouts.length > 0) {
    askedToPersist = true;
    void navigator.storage?.persist?.().catch(() => false);
  }
}

function save(): void {
  if (!database) return;
  saving = saving.then(async () => {
    const target = appState.get();
    if (target === persisted) return; // an earlier write in the queue already took this state along
    try {
      await write(target);
    } catch {
      // A phone may close the connection of a page it put to sleep. Opening it
      // again is worth one try before telling the person nothing was saved.
      try {
        database = await openDatabase();
        await write(target);
      } catch {
        storageStatus.set('failed');
        return;
      }
    }
    storageStatus.set('ok');
    otherTabs?.postMessage('changed');
  });
}

async function write(target: AppState): Promise<void> {
  await saveChanges(database!, persisted, target);
  persisted = target;
}

/** Resolves once every change made so far has been written, or has failed to be. */
export const whenSaved = (): Promise<void> => saving;

/** Takes over what another tab saved. */
async function reload(): Promise<void> {
  if (!database) return;
  for (let attempt = 0; attempt < 3; attempt++) {
    await saving; // what this tab changed is on disk before the disk is read
    const before = appState.get();
    const loaded = await loadState(database);
    // Changed here while reading: what was read lacks it, and putting it on
    // screen would make the change vanish until the next reload.
    if (appState.get() !== before) continue;
    persisted = loaded;
    appState.set(loaded);
    return;
  }
}

export async function initStore(): Promise<void> {
  try {
    database = await openDatabase();
  } catch {
    database = null;
    storageStatus.set('unavailable');
  }
  if (database) {
    try {
      const loaded = await loadState(database);
      persisted = loaded;
      appState.set(loaded);
    } catch {
      // Not written to either: whatever is in there is better left alone than overwritten by an empty app.
      database = null;
      storageStatus.set('unreadable');
    }
  }
  update(seedLibrary);

  if (database && 'BroadcastChannel' in window) {
    // The same site open in two tabs: pick up what the other one saved.
    otherTabs = new BroadcastChannel('gym-tracker');
    otherTabs.onmessage = () => void reload().catch(() => undefined);
  }
}
