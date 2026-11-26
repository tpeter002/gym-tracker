import { produce } from 'immer';
import { useSyncExternalStore } from 'react';
import { loadState, openDatabase, saveChanges } from './db';
import { seedLibrary } from './exercises';
import { emptyState } from './types';
import type { AppState } from './types';

// The whole database is held in memory as one immutable value. Changes go
// through `update`, which hands the logic in workouts.ts, videos.ts… a draft
// to modify, then writes whatever records came out different to IndexedDB.

/** A value components can subscribe to. */
export interface Signal<T> {
  get(): T;
  set(value: T): void;
  subscribe(listener: () => void): () => void;
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export const useSignal = <T>(source: Signal<T>): T => useSyncExternalStore(source.subscribe, source.get);

const appState = signal<AppState>(emptyState());

/**
 * ok — changes are being saved; unavailable — the browser gave us no storage
 * (some private windows), nothing outlives the tab; failed — a write was refused.
 */
export const storageStatus = signal<'ok' | 'unavailable' | 'failed'>('ok');

let database: IDBDatabase | null = null;
let otherTabs: BroadcastChannel | null = null;
let askedToPersist = false;

export const getState = () => appState.get();
export const useAppState = () => useSignal(appState);

export function update(recipe: (draft: AppState) => void): void {
  const before = appState.get();
  const after = produce(before, recipe);
  if (after === before) return;
  appState.set(after);
  if (!database) return;
  saveChanges(database, before, after).then(
    () => otherTabs?.postMessage('changed'),
    () => storageStatus.set('failed'),
  );
  // Ask the browser not to evict the data once there is something worth keeping.
  if (!askedToPersist && after.workouts.length > 0) {
    askedToPersist = true;
    void navigator.storage?.persist?.().catch(() => false);
  }
}

/** Replaces everything, as when restoring a backup. */
export function replaceState(next: AppState): void {
  update(() => next);
}

async function reload(): Promise<void> {
  if (database) appState.set(await loadState(database));
}

export async function initStore(): Promise<void> {
  try {
    database = await openDatabase();
    await reload();
  } catch {
    database = null;
    storageStatus.set('unavailable');
  }
  update(seedLibrary);

  if (database && 'BroadcastChannel' in window) {
    // The same site open in two tabs: pick up what the other one saved.
    otherTabs = new BroadcastChannel('gym-tracker');
    otherTabs.onmessage = () => void reload().catch(() => undefined);
  }
}
