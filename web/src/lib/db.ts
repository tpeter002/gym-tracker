import { normalizeSettings } from './types';
import type { AppState } from './types';

// IndexedDB: one object store per kind of record, each record under its id,
// so a change writes only the records it touched. A workout is one record
// holding its exercises and sets.

const DB_NAME = 'gym-tracker';
const COLLECTIONS = ['exercises', 'workouts', 'bodyWeights', 'videos'] as const;
const META = 'meta';

export function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      for (const name of COLLECTIONS) request.result.createObjectStore(name, { keyPath: 'id' });
      request.result.createObjectStore(META);
    };
    request.onsuccess = () => resolve(request.result);
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
