import { normalizeSettings } from './types';
import type { AppState } from './types';

// IndexedDB: one object store per kind of record, each record under its id,
// so a change writes only the records it touched. A workout is one record
// holding its exercises and sets.

/** The database of the app used without an account. With one, each account has its own (see cloud/session.ts). */
export const DB_NAME = 'gym-tracker';
const COLLECTIONS = ['exercises', 'workouts', 'bodyWeights', 'videos'] as const;
const META = 'meta';
/** Only in an account's database: what the cloud is known to hold (see cloud/sync.ts). */
const SYNC = 'sync';
const CURSOR = '#cursor';
const CURSOR_AT = '#cursorAt';
const LOOKED_BACK = '#lookedBack';
const SYNCED = '#synced';
/** Before a document's name: what this device was about to write there (see SyncMemory.sending). */
const SENDING = '>';

/** `withSync`: the database of an account, which also remembers where its syncing stands. */
export function openDatabase(name = DB_NAME, withSync = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => {
      for (const collection of COLLECTIONS) request.result.createObjectStore(collection, { keyPath: 'id' });
      request.result.createObjectStore(META);
      if (withSync) request.result.createObjectStore(SYNC);
    };
    request.onsuccess = () => {
      // Signing out in another tab deletes the database; holding on to it would keep that waiting for good.
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

/** Resolves once the database is gone; other tabs let go of it when asked (see openDatabase). */
export function deleteDatabase(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
  });
}

const done = <T>(request: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });

export async function loadState(db: IDBDatabase): Promise<AppState> {
  const tx = db.transaction([...COLLECTIONS, META], 'readonly');
  const all = <T>(name: string) => done(tx.objectStore(name).getAll() as IDBRequest<T[]>);
  const meta = tx.objectStore(META);
  const [exercises, workouts, bodyWeights, videos, settings, libraryVersion] = await Promise.all([
    all<AppState['exercises'][number]>('exercises'),
    all<AppState['workouts'][number]>('workouts'),
    all<AppState['bodyWeights'][number]>('bodyWeights'),
    all<AppState['videos'][number]>('videos'),
    done(meta.get('settings') as IDBRequest<unknown>),
    done(meta.get('libraryVersion') as IDBRequest<number | undefined>),
  ]);
  return {
    exercises, workouts, bodyWeights, videos,
    // What was saved by an earlier version of the app may lack newer settings.
    settings: normalizeSettings(settings),
    libraryVersion: libraryVersion ?? 0,
  };
}

/**
 * Writes what differs between two states. Records the store left untouched
 * are the very same objects in both, so comparing by identity finds the rest.
 */
export function saveChanges(db: IDBDatabase, before: AppState, after: AppState): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...COLLECTIONS, META], 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);

    for (const name of COLLECTIONS) {
      if (before[name] === after[name]) continue;
      const store = tx.objectStore(name);
      const previous = new Map<string, unknown>(before[name].map((record) => [record.id, record]));
      for (const record of after[name]) {
        if (previous.get(record.id) !== record) store.put(record);
        previous.delete(record.id);
      }
      for (const id of previous.keys()) store.delete(id);
    }
    if (before.settings !== after.settings) tx.objectStore(META).put(after.settings, 'settings');
    if (before.libraryVersion !== after.libraryVersion) tx.objectStore(META).put(after.libraryVersion, 'libraryVersion');
  });
}

/** What a device last knew the cloud to hold under one key, and what it held itself then — as fingerprints. */
export interface Shadow {
  remote: string;
  local: string;
}

/** How far a device has read what the cloud holds. */
export interface SyncProgress {
  /** The server's time on the newest change taken over so far. */
  cursor: number;
  /** This device's clock when the cursor last moved. */
  cursorAt: number;
  /**
   * Whether, since the cursor last moved, the moments just before it have been
   * looked over once more, late enough to have caught a write that was still
   * on its way. Until then every sync looks them over again.
   */
  lookedBack: boolean;
}

/** Where an account's syncing stands on this device. */
export interface SyncMemory extends SyncProgress {
  /** Whether this device has ever caught up with the cloud. */
  synced: boolean;
  shadows: Map<string, Shadow>;
  /**
   * The fingerprint each document was about to get when this device last sent
   * it, kept until the write is known to have arrived. A device that is closed
   * between the two knows its own write by this when it comes back.
   */
  sending: Map<string, string>;
}

export async function loadSyncMemory(db: IDBDatabase): Promise<SyncMemory> {
  const store = db.transaction(SYNC, 'readonly').objectStore(SYNC);
  const [keys, values] = await Promise.all([
    done(store.getAllKeys() as IDBRequest<string[]>),
    done(store.getAll() as IDBRequest<unknown[]>),
  ]);
  const memory: SyncMemory = { cursor: 0, cursorAt: 0, lookedBack: false, synced: false, shadows: new Map(), sending: new Map() };
  keys.forEach((key, index) => {
    const value = values[index];
    if (key === CURSOR) memory.cursor = typeof value === 'number' ? value : 0;
    else if (key === CURSOR_AT) memory.cursorAt = typeof value === 'number' ? value : 0;
    else if (key === LOOKED_BACK) memory.lookedBack = value === true;
    else if (key === SYNCED) memory.synced = value === true;
    else if (key.startsWith(SENDING)) memory.sending.set(key.slice(SENDING.length), String(value));
    else memory.shadows.set(key, value as Shadow);
  });
  return memory;
}

/** One change to the sync memory, all of it or none. */
function inSyncStore(db: IDBDatabase, work: (store: IDBObjectStore) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(SYNC, 'readwrite');
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
    work(tx.objectStore(SYNC));
  });
}

/** Writes the shadows that changed, with how far the device has read. What was noted as being sent to those documents is settled by it. */
export function saveSyncMemory(db: IDBDatabase, shadows: ReadonlyMap<string, Shadow>, progress: SyncProgress): Promise<void> {
  return inSyncStore(db, (store) => {
    for (const [key, shadow] of shadows) {
      store.put(shadow, key);
      store.delete(SENDING + key);
    }
    store.put(progress.cursor, CURSOR);
    store.put(progress.cursorAt, CURSOR_AT);
    store.put(progress.lookedBack, LOOKED_BACK);
    store.put(true, SYNCED);
  });
}

/** Notes what is about to be written to the cloud, before it is. */
export function noteSending(db: IDBDatabase, hashes: ReadonlyMap<string, string>): Promise<void> {
  return inSyncStore(db, (store) => {
    for (const [key, hash] of hashes) store.put(hash, SENDING + key);
  });
}

/** Forgets what the cloud was known to hold, so the next sync takes everything from it afresh. */
export function clearSyncMemory(db: IDBDatabase): Promise<void> {
  return inSyncStore(db, (store) => {
    store.clear();
    store.put(true, SYNCED);
  });
}
