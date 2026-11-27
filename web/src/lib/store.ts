import { produce } from 'immer';
import { DB_NAME, loadState, openDatabase, saveChanges } from './db';
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
/** Which database that is: the one name without an account, one per account with. */
let databaseName = DB_NAME;
let databaseSyncs = false;
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
/** The database was let go of on purpose (signing out); it is not to be opened again. */
let closed = false;
const changeListeners = new Set<(before: AppState, after: AppState) => void>();

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

/** Calls `listener` after every change, with the state before and after it. Returns how to stop. */
export function onChange(listener: (before: AppState, after: AppState) => void): () => void {
  changeListeners.add(listener);
  return () => changeListeners.delete(listener);
}

function commit(after: AppState): void {
  const before = appState.get();
  if (after === before) return;
  appState.set(after);
  save();
  changeListeners.forEach((listener) => listener(before, after));
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
    if (!database) return; // let go of since this write was queued
    try {
      await write(target);
    } catch {
      // Let go of on purpose: opening it again would bring back a database that signing out is deleting.
      if (closed) return;
      // A phone may close the connection of a page it put to sleep. Opening it
      // again is worth one try before telling the person nothing was saved.
      try {
        const reopened = await openDatabase(databaseName, databaseSyncs);
        if (closed) {
          reopened.close();
          return;
        }
        database = reopened;
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

/** The database in use, for what is kept beside the state (an account's sync memory); null when there is none. */
export const currentDatabase = (): IDBDatabase | null => database;

/**
 * What the database holds once every change made so far is written; null when
 * that failed or there is no database. Read from the disk rather than taken
 * from memory, so it includes what other tabs wrote.
 */
export async function readSaved(): Promise<AppState | null> {
  let waitedFor: Promise<void> | null = null;
  while (waitedFor !== saving) {
    waitedFor = saving;
    await waitedFor; // a change made while waiting queues another write
  }
  if (!database || storageStatus.get() !== 'ok') return null;
  try {
    return await loadState(database);
  } catch {
    return null;
  }
}

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

export interface StoreOptions {
  /** The database to use; an account's own (see cloud/session.ts). */
  name?: string;
  /** Whether that database also keeps an account's sync memory. */
  syncs?: boolean;
  /** false: the built-in exercises are not added yet — an account's own come from the cloud first. */
  seed?: boolean;
}

export async function initStore({ name = DB_NAME, syncs = false, seed = true }: StoreOptions = {}): Promise<void> {
  databaseName = name;
  databaseSyncs = syncs;
  try {
    database = await openDatabase(databaseName, databaseSyncs);
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
  if (seed) update(seedLibrary);

  if (database && 'BroadcastChannel' in window) {
    // The same site open in two tabs: pick up what the other one saved.
    otherTabs = new BroadcastChannel(databaseName);
    otherTabs.onmessage = () => void reload().catch(() => undefined);
  }
}

/** Lets go of the database, so it can be deleted (signing out). Nothing is saved after this. */
export function closeStore(): void {
  closed = true;
  otherTabs?.close();
  otherTabs = null;
  database?.close();
  database = null;
}
