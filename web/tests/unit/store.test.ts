import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppState } from '../../src/lib/types';

// The store's dealings with the database, with the database itself replaced:
// what gets written, in what order, and what happens when a write is refused.

const db = vi.hoisted(() => ({
  openDatabase: vi.fn(),
  loadState: vi.fn(),
  saveChanges: vi.fn(),
}));
vi.mock('../../src/lib/db', () => db);

/** A fresh copy of the store for each test: it keeps its state in module variables. */
async function freshStore() {
  vi.resetModules();
  const store = await import('../../src/lib/store');
  const { emptyState } = await import('../../src/lib/types');
  return { ...store, emptyState };
}

const startWorkout = (name: string) => (draft: AppState) => {
  draft.workouts.push({ id: name, name, startedAt: 1, endedAt: 2, notes: '', entries: [] });
};
const names = (state: AppState) => state.workouts.map((workout) => workout.name);

beforeEach(() => {
  vi.stubGlobal('window', {}); // no BroadcastChannel: one tab
  db.openDatabase.mockReset().mockResolvedValue({ name: 'the database' });
  db.loadState.mockReset();
  db.saveChanges.mockReset().mockResolvedValue(undefined);
});

describe('saving', () => {
  it('writes each change against what the database holds, in order', async () => {
    const { initStore, update, whenSaved, getState, emptyState } = await freshStore();
    const stored = { ...emptyState(), exercises: [{ id: 'e1' }] as AppState['exercises'], libraryVersion: 99 };
    db.loadState.mockResolvedValue(stored);
    await initStore();
    expect(getState()).toBe(stored); // nothing to seed, so nothing to write yet
    expect(db.saveChanges).not.toHaveBeenCalled();

    update(startWorkout('Push'));
    await whenSaved();
    update(startWorkout('Pull'));
    await whenSaved();

    expect(db.saveChanges).toHaveBeenCalledTimes(2);
    const [first, second] = db.saveChanges.mock.calls;
    expect(first[1]).toBe(stored);
    expect(names(first[2])).toEqual(['Push']);
    expect(second[1]).toBe(first[2]); // the second write starts from what the first one left
    expect(names(second[2])).toEqual(['Push', 'Pull']);
  });

  it('takes changes made in a burst along in one write', async () => {
    const { initStore, update, whenSaved, emptyState } = await freshStore();
    db.loadState.mockResolvedValue({ ...emptyState(), exercises: [{ id: 'e1' }] as AppState['exercises'], libraryVersion: 99 });
    await initStore();

    update(startWorkout('Push'));
    update(startWorkout('Pull'));
    update(startWorkout('Legs'));
    await whenSaved();

    expect(db.saveChanges).toHaveBeenCalledTimes(1);
    expect(names(db.saveChanges.mock.calls[0][2])).toEqual(['Push', 'Pull', 'Legs']);
  });

  it('makes up for a refused write with the next one, and says so only while it is true', async () => {
    const { initStore, update, whenSaved, storageStatus, emptyState } = await freshStore();
    const stored = { ...emptyState(), exercises: [{ id: 'e1' }] as AppState['exercises'], libraryVersion: 99 };
    db.loadState.mockResolvedValue(stored);
    await initStore();

    db.saveChanges.mockRejectedValue(new Error('QuotaExceededError'));
    update(startWorkout('Push'));
    await whenSaved();
    expect(storageStatus.get()).toBe('failed');
    expect(db.openDatabase).toHaveBeenCalledTimes(2); // the connection was opened again for one more try

    db.saveChanges.mockClear().mockResolvedValue(undefined);
    update(startWorkout('Pull'));
    await whenSaved();
    // Written from what the database really holds, so the workout that failed to save goes along now.
    expect(db.saveChanges).toHaveBeenCalledTimes(1);
    expect(db.saveChanges.mock.calls[0][1]).toBe(stored);
    expect(names(db.saveChanges.mock.calls[0][2])).toEqual(['Push', 'Pull']);
    expect(storageStatus.get()).toBe('ok');
  });

  it('gets through when only the connection had gone stale', async () => {
    const { initStore, update, whenSaved, storageStatus, emptyState } = await freshStore();
    db.loadState.mockResolvedValue({ ...emptyState(), exercises: [{ id: 'e1' }] as AppState['exercises'], libraryVersion: 99 });
    await initStore();
    const reopened = { name: 'a new connection' };
    db.openDatabase.mockResolvedValue(reopened);
    db.saveChanges.mockRejectedValueOnce(new Error('InvalidStateError: the connection is closing'));

    update(startWorkout('Push'));
    await whenSaved();

    expect(db.saveChanges).toHaveBeenCalledTimes(2);
    expect(db.saveChanges.mock.calls[1][0]).toBe(reopened);
    expect(storageStatus.get()).toBe('ok');
  });
});

describe('starting up', () => {
  it('runs in memory when the browser gives no storage', async () => {
    const { initStore, update, whenSaved, storageStatus, getState } = await freshStore();
    db.openDatabase.mockRejectedValue(new Error('SecurityError'));
    await initStore();
    expect(storageStatus.get()).toBe('unavailable');
    expect(getState().exercises.length).toBeGreaterThan(190); // the built-in list is there all the same

    update(startWorkout('Push'));
    await whenSaved();
    expect(db.saveChanges).not.toHaveBeenCalled();
  });

  it('leaves storage it cannot read alone rather than writing an empty app over it', async () => {
    const { initStore, update, whenSaved, storageStatus } = await freshStore();
    db.loadState.mockRejectedValue(new Error('UnknownError'));
    await initStore();
    expect(storageStatus.get()).toBe('unreadable');

    update(startWorkout('Push'));
    await whenSaved();
    expect(db.saveChanges).not.toHaveBeenCalled();
  });
});

describe('a change', () => {
  it('hands back what its recipe returns, and never mistakes that for a new state', async () => {
    const { initStore, update, getState, emptyState } = await freshStore();
    db.loadState.mockResolvedValue({ ...emptyState(), exercises: [{ id: 'e1' }] as AppState['exercises'], libraryVersion: 99 });
    await initStore();

    expect(update((draft) => { draft.workouts.push({ id: 'w', name: 'Push', startedAt: 1, endedAt: 2, notes: '', entries: [] }); return 'w'; })).toBe('w');
    expect(names(getState())).toEqual(['Push']);
    // A recipe that only reports something changes nothing.
    const before = getState();
    expect(update((draft) => draft.workouts.length)).toBe(1);
    expect(update(() => null)).toBeNull();
    expect(getState()).toBe(before);
  });
});
