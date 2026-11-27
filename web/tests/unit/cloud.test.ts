import { produce } from 'immer';
import { describe, expect, it } from 'vitest';
import { applyChanges, cloudView, fingerprint, kindOf, LIBRARY_KEY, MAX_PAYLOAD, readRemote, recordKey, SETTINGS_KEY, touchesCloud } from '../../src/lib/cloud/records';
import type { RemoteDoc } from '../../src/lib/cloud/records';
import { HOLD_REMOVALS_ALWAYS_FROM, HOLD_REMOVALS_FROM, OVERLAP_MS, stillAsJudged, StorageTrouble, syncOnce } from '../../src/lib/cloud/sync';
import type { Local, OutgoingDoc, Remote, SyncOptions } from '../../src/lib/cloud/sync';
import type { Shadow, SyncMemory, SyncProgress } from '../../src/lib/db';
import { deleteExercise, libraryId, newExercise, seedLibrary } from '../../src/lib/exercises';
import { LIBRARY } from '../../src/lib/library';
import { emptyState } from '../../src/lib/types';
import type { AppState, Workout } from '../../src/lib/types';

// An account kept in step across devices, with the cloud and the devices'
// storage replaced by stand-ins: what goes up, what comes down, who has the
// last word, and that nothing is lost when a step fails half-way.

/** The account: documents, and a clock that only the server reads. */
class Cloud implements Remote {
  docs = new Map<string, RemoteDoc>();
  clock = 1_000_000;
  /** Every write that got through, as it was sent. */
  writes: OutgoingDoc[][] = [];
  asked: number[] = [];
  /** How many documents each of those questions was answered with — what a sync costs in reads. */
  handedOut: number[] = [];
  /** Writes refused from this one on (counting from 0), as when the connection drops. */
  refuseFrom = Infinity;

  async changedSince(since: number): Promise<RemoteDoc[]> {
    this.asked.push(since);
    const found = [...this.docs.values()].filter((doc) => doc.at > since).sort((a, b) => a.at - b.at).map((doc) => ({ ...doc }));
    this.handedOut.push(found.length);
    return found;
  }

  async write(docs: OutgoingDoc[]): Promise<void> {
    if (this.writes.length >= this.refuseFrom) throw new Error('offline');
    this.clock += 60_000; // far enough apart that a device's look back over the last moments finds nothing twice
    for (const doc of docs) this.put(doc.key, doc.payload, doc.deleted);
    this.writes.push(docs);
  }

  /** A document put there by something other than these devices. */
  put(key: string, payload: string, deleted = false, extra: Partial<RemoteDoc> = {}): void {
    this.docs.set(key, { key, kind: key.slice(0, key.indexOf('_')), payload, deleted, format: 1, at: this.clock, ...extra });
  }

  get written(): string[] {
    return this.writes.flat().map((doc) => doc.key);
  }

  live(kind: string): string[] {
    return [...this.docs.values()].filter((doc) => doc.kind === kind && !doc.deleted).map((doc) => doc.key).sort();
  }
}

/** A device: the state the app shows, what its database holds, and where its syncing stands. */
class Device implements Local {
  state: AppState = emptyState();
  /** Another tab can have written to it since, so it is not always what `state` is. */
  disk: AppState = this.state;
  memory: SyncMemory = { cursor: 0, cursorAt: 0, lookedBack: false, synced: false, shadows: new Map(), sending: new Map() };
  /** The device's own clock. It stands still unless a test moves it. */
  clock = 5_000_000;
  /** true: the tab is closed right after a write went out, before the device could note that it arrived. */
  closesBeforeNoting = false;
  /** false: the database refuses writes, as a full one does. */
  saves = true;
  /** A write was refused, and nothing has been saved since. */
  failed = false;
  /** Runs once, just before the next changes from the cloud are applied — a keystroke landing mid-sync. */
  meanwhile: (() => void) | null = null;

  constructor(readonly cloud: Cloud) {}

  /** Changes the state, and writes the records that came out different — those and no others, as the store does. */
  change(recipe: (draft: AppState) => void): void {
    const before = this.state;
    const after = produce(before, recipe);
    if (after === before) return;
    this.state = after;
    if (!this.saves) {
      this.failed = true;
      return;
    }
    this.disk = produce(this.disk, (disk) => {
      for (const kind of ['exercises', 'workouts', 'bodyWeights', 'videos'] as const) {
        const previous = new Map<string, unknown>(before[kind].map((record) => [record.id, record]));
        const records = disk[kind] as { id: string }[];
        for (const record of after[kind]) {
          if (previous.get(record.id) !== record) {
            const index = records.findIndex((candidate) => candidate.id === record.id);
            if (index >= 0) records[index] = record;
            else records.push(record);
          }
          previous.delete(record.id);
        }
        for (const id of previous.keys()) {
          const index = records.findIndex((candidate) => candidate.id === id);
          if (index >= 0) records.splice(index, 1);
        }
      }
      if (before.settings !== after.settings) disk.settings = after.settings;
      disk.libraryVersion = after.libraryVersion;
    });
  }

  /** What the app has after being opened again: whatever its database held. */
  reopen(): void {
    this.saves = true;
    this.failed = false;
    this.state = this.disk;
  }

  async read(): Promise<AppState | null> {
    // Read back from a database, every record is a new object.
    return this.failed ? null : structuredClone(this.disk);
  }

  apply(items: Parameters<Local['apply']>[0]): Set<string> {
    this.meanwhile?.();
    this.meanwhile = null;
    const { changes, leftAlone } = stillAsJudged(this.state, items);
    this.change((draft) => applyChanges(draft, changes));
    return leftAlone;
  }

  async remember(): Promise<SyncMemory> {
    return { ...this.memory, shadows: new Map(this.memory.shadows), sending: new Map(this.memory.sending) };
  }

  async noteSending(hashes: ReadonlyMap<string, string>): Promise<void> {
    for (const [key, hash] of hashes) this.memory.sending.set(key, hash);
  }

  async memorize(shadows: ReadonlyMap<string, Shadow>, progress: SyncProgress): Promise<void> {
    if (this.closesBeforeNoting) throw new Error('the tab was closed');
    for (const [key, shadow] of shadows) {
      this.memory.shadows.set(key, shadow);
      this.memory.sending.delete(key);
    }
    Object.assign(this.memory, progress, { synced: true });
  }

  sync(options?: SyncOptions) {
    return syncOnce(this, this.cloud, { now: this.clock, ...options });
  }

  names(kind: 'exercises' | 'workouts'): string[] {
    return this.state[kind].map((record) => record.name).sort();
  }
}

const workout = (id: string, name: string, extra: Partial<Workout> = {}): Workout =>
  ({ id, name, startedAt: 1_000, endedAt: 2_000, notes: '', entries: [], ...extra });

const addWorkout = (id: string, name: string, extra: Partial<Workout> = {}) => (draft: AppState) => {
  draft.workouts.push(workout(id, name, extra));
};
const rename = (id: string, name: string) => (draft: AppState) => {
  draft.workouts.find((candidate) => candidate.id === id)!.name = name;
};
const remove = (id: string) => (draft: AppState) => {
  draft.workouts = draft.workouts.filter((candidate) => candidate.id !== id);
};

/** An account with one device that has logged a few things and sent them. */
async function account() {
  const cloud = new Cloud();
  const phone = new Device(cloud);
  phone.change((draft) => {
    const bench = { ...newExercise('Bench Press (Barbell)', 'chest', 'barbell', false), id: 'bench' };
    draft.exercises.push(bench);
    draft.workouts.push(workout('w1', 'Push', {
      entries: [{ id: 'e1', exerciseId: 'bench', exerciseName: bench.name, notes: '', sets: [{ id: 's1', weight: 80, reps: 8, rpe: null, isWarmup: false, isDone: true }] }],
    }));
    draft.bodyWeights.push({ id: 'b1', date: 5_000, kg: 82.5 });
    draft.videos.push({ id: 'v1', url: 'https://example.org/clip', title: 'Clip', caption: '', thumbnail: null, addedAt: 3_000, analyzedAt: null, suggestions: [] });
    draft.settings.unit = 'lb';
    draft.libraryVersion = 3;
  });
  await phone.sync();
  return { cloud, phone };
}

/** A second device of the same account, as it is right after signing in: caught up, nothing sent. */
async function join(cloud: Cloud) {
  const device = new Device(cloud);
  await device.sync({ push: false });
  return device;
}

describe('what belongs in an account', () => {
  it('is every record, the settings and the library version — one document each', () => {
    const state = emptyState();
    addWorkout('w1', 'Push')(state);
    state.exercises.push({ ...newExercise('Bench Press (Barbell)', 'chest', 'barbell', false), id: 'bench' });
    state.bodyWeights.push({ id: 'b1', date: 5_000, kg: 82.5 });
    const view = cloudView(state);
    expect([...view.keys()].sort()).toEqual(['bodyWeights_b1', 'exercises_bench', LIBRARY_KEY, SETTINGS_KEY, 'workouts_w1']);
    expect(JSON.parse(view.get('workouts_w1')!)).toEqual(state.workouts[0]);
  });

  it("leaves out what belongs to one browser: API keys, the share inbox, the analyzer's address", () => {
    const state = emptyState();
    state.settings.apiKeys.gemini = 'a-secret-key';
    state.settings.shareCode = 'inbox-code-123';
    state.settings.analyzerURL = 'https://analyzer.example.net';
    const sent = [...cloudView(state).values()].join('\n');
    expect(sent).not.toContain('a-secret-key');
    expect(sent).not.toContain('inbox-code-123');
    expect(sent).not.toContain('analyzer.example.net');
    const fields = Object.keys(JSON.parse(cloudView(state).get(SETTINGS_KEY)!));
    expect(fields).not.toContain('apiKeys');
    expect(fields).not.toContain('analyzerURL');
    expect(fields).toContain('unit');
  });

  it('leaves out a workout in progress', () => {
    const state = emptyState();
    addWorkout('w1', 'Push', { endedAt: null })(state);
    expect([...cloudView(state).keys()].some((key) => key.startsWith('workouts_'))).toBe(false);
  });

  it('names a document by its record, whatever the id looks like', () => {
    expect(recordKey('workouts', 'a1b2c3')).toBe('workouts_a1b2c3');
    expect(recordKey('exercises', 'lib_bench_press_barbell')).toBe('exercises_lib_bench_press_barbell');
    // Ids from a restored file can hold anything; the name must still be one the cloud accepts, and the same every time.
    const odd = recordKey('workouts', 'a/b c.ő');
    expect(odd).toMatch(/^workouts_=[0-9a-f]{28}$/);
    expect(recordKey('workouts', 'a/b c.ő')).toBe(odd);
    expect(recordKey('workouts', 'a/b c.ö')).not.toBe(odd);
    expect(recordKey('workouts', 'x'.repeat(65))).toMatch(/^workouts_=/);
    expect(kindOf(odd)).toBe('workouts');
    expect(kindOf('secrets_1')).toBeNull();
  });

  it('tells a change that concerns the account from one that does not', () => {
    const before = produce(emptyState(), addWorkout('w0', 'Running', { endedAt: null }));
    const typing = produce(before, (draft) => { draft.workouts[0].notes = 'felt good'; });
    expect(touchesCloud(before, typing)).toBe(false);
    expect(touchesCloud(before, produce(before, (draft) => { draft.workouts[0].endedAt = 9_000; }))).toBe(true);
    expect(touchesCloud(before, produce(before, addWorkout('w1', 'Push')))).toBe(true);
    expect(touchesCloud(before, produce(before, (draft) => { draft.settings.unit = 'lb'; }))).toBe(true);
    expect(touchesCloud(before, produce(before, (draft) => { draft.libraryVersion = 4; }))).toBe(true);
    const finished = produce(emptyState(), addWorkout('w1', 'Push'));
    expect(touchesCloud(finished, produce(finished, remove('w1')))).toBe(true);
    expect(touchesCloud(finished, produce(finished, addWorkout('w2', 'Now', { endedAt: null })))).toBe(false);
  });
});

describe('a document from the cloud', () => {
  const doc = (key: string, payload: unknown, extra: Partial<RemoteDoc> = {}): RemoteDoc =>
    ({ key, kind: key.slice(0, key.indexOf('_')), payload: JSON.stringify(payload), deleted: false, format: 1, at: 1, ...extra });

  it('is read with the care a backup file is', () => {
    const read = readRemote(doc('workouts_w1', { id: 'w1', name: 'Push', startedAt: 1, endedAt: 2, entries: [], surprise: true }));
    expect(read).toEqual({ key: 'workouts_w1', kind: 'workouts', record: workout('w1', 'Push', { startedAt: 1, endedAt: 2 }) });
  });

  it('is left alone when it cannot be one of ours', () => {
    expect(readRemote(doc('workouts_w1', { id: 'w1', name: 'Push' }))).toBeNull(); // no dates
    expect(readRemote(doc('workouts_w1', { ...workout('w2', 'Push') }))).toBeNull(); // another record under this name
    expect(readRemote(doc('workouts_w1', { ...workout('w1', 'Push', { endedAt: null }) }))).toBeNull(); // in progress
    expect(readRemote(doc('workouts_w1', workout('w1', 'Push'), { kind: 'exercises' }))).toBeNull();
    expect(readRemote(doc('workouts_w1', workout('w1', 'Push'), { format: 2 }))).toBeNull(); // a format from a later version
    expect(readRemote({ ...doc('workouts_w1', null), payload: 'not json' })).toBeNull();
    expect(readRemote(doc('workouts_w1', [1, 2]))).toBeNull();
    expect(readRemote(doc('playlists_p1', { id: 'p1' }))).toBeNull();
    expect(readRemote(doc('bodyWeights_b1', { id: 'b1', date: 1, kg: -4 }))).toBeNull();
    expect(readRemote(doc('meta_library', { libraryVersion: 'three' }))).toBeNull();
    expect(readRemote(doc('settings_other', {}))).toBeNull();
    expect(readRemote({ ...doc(SETTINGS_KEY, {}), deleted: true, payload: '' })).toBeNull();
  });

  it('never brings API keys or an inbox code with it, and never takes this browser\'s away', () => {
    const state = emptyState();
    state.settings.apiKeys.gemini = 'mine';
    state.settings.shareCode = 'my-inbox-code';
    const change = readRemote(doc(SETTINGS_KEY, { unit: 'lb', apiKeys: { gemini: 'planted' }, shareCode: 'planted-code' }))!;
    applyChanges(state, [change]);
    expect(state.settings.unit).toBe('lb');
    expect(state.settings.apiKeys.gemini).toBe('mine');
    expect(state.settings.shareCode).toBe('my-inbox-code');
  });

  it('cannot point the app at another analyzer: keys are sent to that address, so it is only ever set on the device', () => {
    const state = emptyState();
    state.settings.analyzerURL = 'https://my-own.example.net';
    state.settings.apiKeys.gemini = 'mine';
    // Whoever got to write into the account — a guessed password, the database's console — plants an address of theirs.
    applyChanges(state, [readRemote(doc(SETTINGS_KEY, { unit: 'kg', analyzerURL: 'https://collector.example.org', modelProvider: 'gemini' }))!]);
    expect(state.settings.analyzerURL).toBe('https://my-own.example.net');

    const untouched = emptyState();
    applyChanges(untouched, [readRemote(doc(SETTINGS_KEY, { analyzerURL: 'https://collector.example.org' }))!]);
    expect(untouched.settings.analyzerURL).toBe('');
  });

  it('adds, replaces and removes records in place', () => {
    const state = emptyState();
    addWorkout('w1', 'Push')(state);
    addWorkout('w2', 'Pull')(state);
    applyChanges(state, [
      readRemote(doc('workouts_w1', workout('w1', 'Push day')))!,
      readRemote({ ...doc('workouts_w2', null), deleted: true, payload: '' })!,
      readRemote(doc('workouts_w3', workout('w3', 'Legs')))!,
      readRemote(doc(LIBRARY_KEY, { libraryVersion: 7 }))!,
    ]);
    expect(state.workouts.map((item) => item.name)).toEqual(['Push day', 'Legs']);
    expect(state.libraryVersion).toBe(7);
  });
});

describe('a first device', () => {
  it('sends everything it has, and nothing twice', async () => {
    const { cloud, phone } = await account();
    expect(cloud.live('workouts')).toEqual(['workouts_w1']);
    expect(cloud.live('exercises')).toEqual(['exercises_bench']);
    expect(cloud.live('bodyWeights')).toEqual(['bodyWeights_b1']);
    expect(cloud.live('videos')).toEqual(['videos_v1']);
    expect(JSON.parse(cloud.docs.get(SETTINGS_KEY)!.payload).unit).toBe('lb');
    expect(JSON.parse(cloud.docs.get(LIBRARY_KEY)!.payload)).toEqual({ libraryVersion: 3 });

    const sent = cloud.writes.length;
    expect(await phone.sync()).toMatchObject({ pulled: 0, pushed: 0 });
    expect(await phone.sync()).toMatchObject({ pulled: 0, pushed: 0 });
    expect(cloud.writes).toHaveLength(sent);
  });

  it('sends exercises and videos ahead of the workouts that point at them', async () => {
    const { cloud } = await account();
    const order = cloud.written.map((key) => key.slice(0, key.indexOf('_')));
    expect(order.indexOf('exercises')).toBeLessThan(order.indexOf('workouts'));
    expect(order.indexOf('videos')).toBeLessThan(order.indexOf('workouts'));
  });

  it('keeps a workout in progress to itself until it is finished', async () => {
    const { cloud, phone } = await account();
    phone.change(addWorkout('w2', 'Pull', { endedAt: null }));
    expect(await phone.sync()).toMatchObject({ pushed: 0 });
    phone.change((draft) => { draft.workouts.find((item) => item.id === 'w2')!.endedAt = 9_000; });
    expect(await phone.sync()).toMatchObject({ pushed: 1 });
    expect(cloud.live('workouts')).toEqual(['workouts_w1', 'workouts_w2']);
    // Discarding one that never left sends nothing either.
    phone.change(addWorkout('w3', 'Legs', { endedAt: null }));
    phone.change(remove('w3'));
    expect(await phone.sync()).toMatchObject({ pushed: 0 });
  });
});

describe('a second device', () => {
  it('takes over what the account holds and sends nothing back', async () => {
    const { cloud, phone } = await account();
    const sent = cloud.writes.length;
    const laptop = await join(cloud);
    expect(laptop.state.workouts).toEqual(phone.state.workouts);
    expect(laptop.state.exercises).toEqual(phone.state.exercises);
    expect(laptop.state.bodyWeights).toEqual(phone.state.bodyWeights);
    expect(laptop.state.videos).toMatchObject(phone.state.videos);
    expect(laptop.state.settings.unit).toBe('lb');
    expect(laptop.state.libraryVersion).toBe(3);
    expect(await laptop.sync()).toMatchObject({ pulled: 0, pushed: 0 });
    expect(cloud.writes).toHaveLength(sent);
  });

  it('does not send a record back because it reads it into a slightly different shape', async () => {
    const { cloud, phone } = await account();
    const sent = cloud.writes.length;
    const laptop = await join(cloud);
    // Checked on the way in, the video gained a field the phone's copy never had.
    expect(phone.state.videos[0]).not.toHaveProperty('analyzedBy');
    expect(laptop.state.videos[0]).toHaveProperty('analyzedBy', null);
    for (let round = 0; round < 3; round++) {
      expect(await laptop.sync()).toMatchObject({ pulled: 0, pushed: 0 });
      expect(await phone.sync()).toMatchObject({ pulled: 0, pushed: 0 });
    }
    expect(cloud.writes).toHaveLength(sent);
  });

  it("does not overwrite the account's settings with a new browser's defaults", async () => {
    const { cloud } = await account();
    const laptop = new Device(cloud);
    await laptop.sync(); // even if it were allowed to send straight away
    expect(laptop.state.settings.unit).toBe('lb');
    expect(JSON.parse(cloud.docs.get(SETTINGS_KEY)!.payload).unit).toBe('lb');
  });

  it('sees what the other one adds, changes and deletes', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);

    phone.change(addWorkout('w2', 'Pull'));
    await phone.sync();
    expect(await laptop.sync()).toMatchObject({ pulled: 1, pushed: 0 });
    expect(laptop.names('workouts')).toEqual(['Pull', 'Push']);

    laptop.change(rename('w2', 'Pull day'));
    await laptop.sync();
    await phone.sync();
    expect(phone.names('workouts')).toEqual(['Pull day', 'Push']);

    phone.change(remove('w1'));
    expect(await phone.sync()).toMatchObject({ pushed: 1 });
    expect(cloud.docs.get('workouts_w1')).toMatchObject({ deleted: true, payload: '' });
    await laptop.sync();
    expect(laptop.names('workouts')).toEqual(['Pull day']);
    expect(await laptop.sync()).toMatchObject({ pulled: 0, pushed: 0 });
    expect(await phone.sync()).toMatchObject({ pulled: 0, pushed: 0 });
  });

  it('gets an exercise deleted elsewhere out of its workouts too', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    phone.change((draft) => deleteExercise(draft, 'bench'));
    await phone.sync();
    await laptop.sync();
    expect(laptop.state.exercises).toEqual([]);
    expect(laptop.state.workouts[0].entries[0]).toMatchObject({ exerciseId: null, exerciseName: 'Bench Press (Barbell)' });
  });

  it('only asks for what changed since it last looked', async () => {
    const { cloud, phone } = await account();
    expect(cloud.asked).toEqual([0]);
    await phone.sync(); // sees its own writes come back once, and from then on knows how far it has read
    await phone.sync();
    expect(cloud.asked[2]).toBeGreaterThan(0);
    expect(cloud.asked[2]).toBeLessThan(cloud.clock);
    // The moments just before are looked at again; nothing in them is news.
    cloud.clock += 1; // well inside that margin
    cloud.put('workouts_w5', JSON.stringify(workout('w5', 'Late')));
    cloud.docs.get('workouts_w5')!.at = cloud.asked[2] + 1;
    await phone.sync();
    expect(phone.names('workouts')).toEqual(['Late', 'Push']);
  });

  it('stops reading a large batch again once it has looked back late enough', async () => {
    const cloud = new Cloud();
    const phone = new Device(cloud);
    phone.change((draft) => {
      for (let index = 0; index < 250; index++) addWorkout(`w${index}`, `Workout ${index}`)(draft);
    });
    await phone.sync(); // a restored backup goes out: one write, one time stamp for all of it
    await phone.sync(); // …and is read back once, which is how the device learns how far it has read
    expect(cloud.handedOut.at(-1)).toBeGreaterThan(250);

    // For the next half minute a write stamped just earlier could still land, so those moments are looked over again.
    phone.clock += 10_000;
    await phone.sync();
    expect(cloud.handedOut.at(-1)).toBeGreaterThan(250);
    phone.clock += OVERLAP_MS;
    await phone.sync(); // the look back that is late enough
    // From here on, opening the app costs no more than what is new.
    for (let open = 0; open < 3; open++) {
      phone.clock += 3_600_000;
      expect(await phone.sync()).toMatchObject({ pulled: 0, pushed: 0 });
      expect(cloud.handedOut.at(-1)).toBe(0);
    }

    // What another device writes is still found, and starts a look back of its own.
    const laptop = await join(cloud);
    laptop.change(addWorkout('new', 'Legs'));
    await laptop.sync();
    expect(await phone.sync()).toMatchObject({ pulled: 1 });
    expect(phone.memory.lookedBack).toBe(false);
  });

  it('does not take a clock that jumped backwards for time that has passed', async () => {
    const { cloud, phone } = await account();
    await phone.sync();
    phone.clock -= 86_400_000;
    await phone.sync();
    expect(phone.memory.lookedBack).toBe(false);
    expect(cloud.asked.at(-1)).toBeLessThan(phone.memory.cursor);
  });
});

describe('the same record changed on two devices', () => {
  it('ends as the version of whichever synced last, on both', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    phone.change(rename('w1', 'Push (phone)'));
    laptop.change(rename('w1', 'Push (laptop)'));
    await phone.sync();
    expect(await laptop.sync()).toMatchObject({ pulled: 0, pushed: 1 });
    await phone.sync();
    expect(phone.names('workouts')).toEqual(['Push (laptop)']);
    expect(laptop.names('workouts')).toEqual(['Push (laptop)']);
    expect(await phone.sync()).toMatchObject({ pulled: 0, pushed: 0 });
    expect(await laptop.sync()).toMatchObject({ pulled: 0, pushed: 0 });
  });

  it('keeps a record that one device changed and the other deleted', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    phone.change(remove('w1'));
    laptop.change(rename('w1', 'Push, kept'));
    await phone.sync();
    await laptop.sync();
    await phone.sync();
    expect(phone.names('workouts')).toEqual(['Push, kept']);
    expect(cloud.live('workouts')).toEqual(['workouts_w1']);
  });

  it('removes a record that one device deleted after the other changed it and synced first', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    laptop.change(rename('w1', 'Push, renamed'));
    phone.change(remove('w1'));
    await laptop.sync();
    await phone.sync();
    await laptop.sync();
    expect(laptop.state.workouts).toEqual([]);
    expect(cloud.live('workouts')).toEqual([]);
  });

  it('is nothing to settle when both made the same change', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    phone.change(rename('w1', 'Chest'));
    laptop.change(rename('w1', 'Chest'));
    await phone.sync();
    const sent = cloud.writes.length;
    expect(await laptop.sync()).toMatchObject({ pulled: 0, pushed: 0 });
    expect(cloud.writes).toHaveLength(sent);
  });
});

describe('the built-in exercises', () => {
  const library = LIBRARY.slice(0, 5);

  it('are the same records on every device, however they got there', async () => {
    const cloud = new Cloud();
    const phone = new Device(cloud);
    const laptop = new Device(cloud);
    // Both added the list before hearing from the other — as after an update that brought new ones.
    phone.change((draft) => seedLibrary(draft, library, 1));
    laptop.change((draft) => seedLibrary(draft, library, 1));
    expect(phone.state.exercises[0].id).toBe(libraryId(library[0].name));
    await phone.sync();
    await laptop.sync();
    await phone.sync();
    expect(cloud.live('exercises')).toHaveLength(5);
    expect(phone.state.exercises).toHaveLength(5);
    expect(laptop.state.exercises).toHaveLength(5);
  });

  it('stay deleted on a device that joins later', async () => {
    const cloud = new Cloud();
    const phone = new Device(cloud);
    phone.change((draft) => seedLibrary(draft, library, 1));
    await phone.sync();
    phone.change((draft) => deleteExercise(draft, libraryId(library[0].name)));
    await phone.sync();

    const laptop = await join(cloud);
    laptop.change((draft) => seedLibrary(draft, library, 1)); // what the app does once it has caught up
    expect(laptop.state.exercises.map((exercise) => exercise.name)).not.toContain(library[0].name);
    expect(laptop.state.exercises).toHaveLength(4);
    expect(await laptop.sync()).toMatchObject({ pushed: 0 });
  });
});

describe('when something goes wrong', () => {
  it('sends nothing and marks nothing while the device cannot save', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    phone.change(addWorkout('w2', 'Pull'));
    await phone.sync();

    laptop.saves = false;
    laptop.change(addWorkout('w3', 'Legs'));
    const asked = cloud.asked.length;
    await expect(laptop.sync()).rejects.toBeInstanceOf(StorageTrouble);
    expect(cloud.live('workouts')).toEqual(['workouts_w1', 'workouts_w2']);
    expect(laptop.memory.shadows.has('workouts_w2')).toBe(false);
    expect(cloud.asked).toHaveLength(asked); // and it didn't spend a request finding that out
  });

  it('knows its own write again when it never got to note that it arrived, and keeps what was done since', async () => {
    const { cloud, phone } = await account();
    phone.change(addWorkout('w2', 'Pull'));
    phone.closesBeforeNoting = true; // the phone goes into a pocket as the write leaves
    await expect(phone.sync()).rejects.toThrow('the tab was closed');
    expect(cloud.live('workouts')).toEqual(['workouts_w1', 'workouts_w2']);
    expect(phone.memory.shadows.has('workouts_w2')).toBe(false);

    phone.closesBeforeNoting = false;
    phone.change(rename('w2', 'Pull, with a note added later'));
    await phone.sync();
    // Its own older write coming back is not news from elsewhere: the newer text stays, and goes out.
    expect(phone.names('workouts')).toEqual(['Pull, with a note added later', 'Push']);
    expect(JSON.parse(cloud.docs.get('workouts_w2')!.payload).name).toBe('Pull, with a note added later');
  });

  it('does not bring back a record deleted after a write that was never noted as arrived', async () => {
    const { cloud, phone } = await account();
    phone.change(addWorkout('w2', 'Pull'));
    phone.closesBeforeNoting = true;
    await expect(phone.sync()).rejects.toThrow('the tab was closed');
    phone.closesBeforeNoting = false;

    phone.change(remove('w2'));
    await phone.sync();
    expect(phone.names('workouts')).toEqual(['Push']);
    expect(cloud.live('workouts')).toEqual(['workouts_w1']);
  });

  it('still takes a record over from another device when its own write of it never left', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    phone.change(rename('w1', 'Push (phone)'));
    cloud.refuseFrom = cloud.writes.length; // noted as about to be sent, and then the connection was gone
    await expect(phone.sync()).rejects.toThrow('offline');
    cloud.refuseFrom = Infinity;
    phone.change(rename('w1', 'Push')); // changed back: nothing to send after all

    laptop.change(rename('w1', 'Push (laptop)'));
    await laptop.sync();
    await phone.sync();
    expect(phone.names('workouts')).toEqual(['Push (laptop)']);
  });

  it('does not mistake changes it failed to save for records deleted here', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    phone.change(addWorkout('w2', 'Pull'));
    await phone.sync();

    // The laptop hears of w2, but its database refuses the write.
    laptop.saves = false;
    await expect(laptop.sync()).rejects.toBeInstanceOf(StorageTrouble);
    expect(laptop.names('workouts')).toEqual(['Pull', 'Push']); // on screen, not on disk
    // Reopened later, it has what its database had — and must not tell the cloud w2 is gone.
    laptop.reopen();
    expect(laptop.names('workouts')).toEqual(['Push']);
    await laptop.sync();
    expect(cloud.live('workouts')).toEqual(['workouts_w1', 'workouts_w2']);
    expect(laptop.names('workouts')).toEqual(['Pull', 'Push']);
  });

  it('picks up where a write to the cloud was cut off', async () => {
    const cloud = new Cloud();
    const phone = new Device(cloud);
    phone.change((draft) => {
      for (let index = 0; index < 700; index++) addWorkout(`w${index}`, `Workout ${index}`)(draft);
    });
    cloud.refuseFrom = 1; // the first batch gets through, the rest doesn't
    await expect(phone.sync()).rejects.toThrow('offline');
    const first = cloud.written.length;
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(300);

    cloud.refuseFrom = Infinity;
    await phone.sync();
    expect(cloud.live('workouts')).toHaveLength(700);
    expect(new Set(cloud.written).size).toBe(cloud.written.length); // nothing was sent twice
  });

  it('ends in the same place when it forgot that a write got through', async () => {
    const { cloud, phone } = await account();
    phone.change(addWorkout('w2', 'Pull'));
    const before = await phone.remember();
    await phone.sync();
    phone.memory = before; // the tab was closed before it could note what it had sent
    const sent = cloud.writes.length;
    expect(await phone.sync()).toMatchObject({ pushed: 0 });
    expect(cloud.writes).toHaveLength(sent);
    expect(phone.names('workouts')).toEqual(['Pull', 'Push']);
  });

  it('leaves a record alone that was typed into while its newer version was on the way, and comes back for it', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    phone.change(rename('w1', 'Push (phone)'));
    await phone.sync();

    laptop.meanwhile = () => laptop.change(rename('w1', 'Push (typed just now)'));
    await laptop.sync();
    expect(laptop.names('workouts')).toEqual(['Push (typed just now)']);
    // Next time it is a record changed in both places: the laptop's stays and goes out.
    await laptop.sync();
    await phone.sync();
    expect(phone.names('workouts')).toEqual(['Push (typed just now)']);
  });

  it('comes back for a record it could not touch because this tab had fallen behind', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    const behind = laptop.state;
    phone.change(rename('w1', 'Push, second name'));
    await phone.sync();
    await laptop.sync(); // another tab on the laptop took that over…
    laptop.state = behind; // …and this one hasn't caught up with it
    phone.change(rename('w1', 'Push, third name'));
    await phone.sync();
    phone.change(addWorkout('w2', 'Pull')); // a later write, which the laptop can take over
    await phone.sync();

    await laptop.sync();
    expect(laptop.disk.workouts.map((item) => item.name).sort()).toEqual(['Pull', 'Push, second name']); // w1 not written from a tab that didn't know its second name
    laptop.reopen();
    // Having taken the later write over must not make it think it has read past the one it skipped.
    await laptop.sync();
    expect(laptop.names('workouts')).toEqual(['Pull', 'Push, third name']);
  });

  it('remembers what it took over even when its own sending then fails', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    phone.change((draft) => { draft.videos[0].title = 'Clip, renamed'; });
    await phone.sync();

    laptop.change(addWorkout('w9', 'Legs'));
    cloud.refuseFrom = cloud.writes.length;
    await expect(laptop.sync()).rejects.toThrow('offline');
    expect(laptop.state.videos[0].title).toBe('Clip, renamed');

    cloud.refuseFrom = Infinity;
    // Only its own workout goes out; the video it had just taken over is not sent back.
    expect(await laptop.sync()).toMatchObject({ pushed: 1 });
    expect(cloud.written.at(-1)).toBe('workouts_w9');
  });

  it('judges by what the database holds, not by a tab that has fallen behind', async () => {
    const { cloud, phone } = await account();
    const laptop = await join(cloud);
    // Another tab on the laptop renamed the workout; this tab's memory hasn't caught up.
    const stale = laptop.state;
    laptop.change(rename('w1', 'Push (other tab)'));
    laptop.state = stale;
    phone.change(rename('w1', 'Push (phone)'));
    await phone.sync();

    await laptop.sync();
    // The other tab's change is still to send, so it is not overwritten by the phone's.
    expect(laptop.disk.workouts[0].name).toBe('Push (other tab)');
    expect(JSON.parse(cloud.docs.get('workouts_w1')!.payload).name).toBe('Push (other tab)');
  });

  it('leaves a document it cannot read as it is — it may be from a newer version of the app', async () => {
    const { cloud, phone } = await account();
    cloud.clock += 60_000;
    cloud.put('workouts_w1', '{"id":"w1","encrypted":"…"}', false, { format: 2 });
    cloud.put('playlists_p1', '{"id":"p1"}');
    expect(await phone.sync()).toMatchObject({ pulled: 0, pushed: 0, unreadable: 2 });
    expect(phone.names('workouts')).toEqual(['Push']);
    expect(cloud.docs.get('workouts_w1')).toMatchObject({ format: 2 });
    // And it doesn't stumble over them again and again.
    expect(await phone.sync()).toMatchObject({ unreadable: 0 });
  });

  it('says so when a record is too long for the cloud, and sends the rest', async () => {
    const { cloud, phone } = await account();
    phone.change((draft) => {
      draft.videos.push({ id: 'v2', url: 'https://example.org/2', title: 'Big', caption: '', thumbnail: `data:image/png;base64,${'A'.repeat(MAX_PAYLOAD)}`, addedAt: 1, analyzedAt: null, suggestions: [] });
    });
    phone.change(addWorkout('w2', 'Pull'));
    expect(await phone.sync()).toMatchObject({ pushed: 1, tooLarge: 1 });
    expect(cloud.live('videos')).toEqual(['videos_v1']);
    expect(cloud.live('workouts')).toEqual(['workouts_w1', 'workouts_w2']);
  });
});

describe('a large removal', () => {
  async function accountWith(count: number) {
    const cloud = new Cloud();
    const phone = new Device(cloud);
    phone.change((draft) => {
      for (let index = 0; index < count; index++) addWorkout(`w${index}`, `Workout ${index}`)(draft);
    });
    await phone.sync();
    return { cloud, phone };
  }

  it('is held until the person says it is meant; what was added goes out meanwhile', async () => {
    const { cloud, phone } = await accountWith(40);
    const laptop = await join(cloud);
    // The 40 are gone from the phone, and one other is there instead.
    phone.change((draft) => { draft.workouts = [workout('new', 'Logged since')]; });
    expect(await phone.sync()).toMatchObject({ held: 40, pushed: 1 });
    expect(cloud.live('workouts')).toHaveLength(41);
    await laptop.sync();
    expect(laptop.state.workouts).toHaveLength(41);
    // Asked again at every sync until answered, and nothing more is sent for it.
    const sent = cloud.writes.length;
    expect(await phone.sync()).toMatchObject({ held: 40, pushed: 0 });
    expect(cloud.writes).toHaveLength(sent);

    expect(await phone.sync({ allowRemovals: true })).toMatchObject({ held: 0, pushed: 40 });
    expect(cloud.live('workouts')).toEqual(['workouts_new']);
    await laptop.sync();
    expect(laptop.names('workouts')).toEqual(['Logged since']);
  });

  it('can be taken back: forgetting where it stood, the device takes the account as it is', async () => {
    const { cloud, phone } = await accountWith(40);
    phone.change((draft) => { draft.workouts = [workout('new', 'Logged since')]; });
    expect(await phone.sync()).toMatchObject({ held: 40 });

    phone.memory = { cursor: 0, cursorAt: 0, lookedBack: false, synced: true, shadows: new Map(), sending: new Map() }; // "Bring Them Back"
    expect(await phone.sync()).toMatchObject({ held: 0, pulled: 40 });
    expect(phone.state.workouts).toHaveLength(41);
    expect(cloud.live('workouts')).toHaveLength(41);
  });

  it('is not asked about when it is a few records, or a small part of many', async () => {
    const { cloud, phone } = await accountWith(100);
    phone.change((draft) => { draft.workouts = draft.workouts.slice(24); }); // just under a quarter
    expect(await phone.sync()).toMatchObject({ held: 0, pushed: 24 });
    expect(cloud.live('workouts')).toHaveLength(76);

    const small = await accountWith(HOLD_REMOVALS_FROM - 1);
    small.phone.change((draft) => { draft.workouts = []; });
    expect(await small.phone.sync()).toMatchObject({ held: 0, pushed: HOLD_REMOVALS_FROM - 1 });
  });

  it('is asked about from a certain number on, however small a part of the account it is', async () => {
    const { cloud, phone } = await accountWith(400);
    phone.change((draft) => { draft.workouts = draft.workouts.slice(HOLD_REMOVALS_ALWAYS_FROM); });
    expect(await phone.sync()).toMatchObject({ held: HOLD_REMOVALS_ALWAYS_FROM, pushed: 0 });
    expect(cloud.live('workouts')).toHaveLength(400);
  });

  it('is counted kind by kind: every workout gone is asked about, however many exercises there are', async () => {
    const cloud = new Cloud();
    const phone = new Device(cloud);
    phone.change((draft) => {
      seedLibrary(draft); // some two hundred exercises
      for (let index = 0; index < 8; index++) addWorkout(`w${index}`, `Workout ${index}`)(draft);
    });
    await phone.sync();
    expect(cloud.live('exercises').length).toBeGreaterThan(190);

    const workouts = phone.state.workouts;
    phone.change((draft) => { draft.workouts = []; });
    expect(await phone.sync()).toMatchObject({ held: 8, pushed: 0 });
    expect(cloud.live('workouts')).toHaveLength(8);

    // Deleting a handful of the many exercises, on the other hand, is an ordinary thing to do.
    phone.change((draft) => { draft.workouts = [...workouts]; });
    phone.change((draft) => { draft.exercises = draft.exercises.slice(6); });
    expect(await phone.sync()).toMatchObject({ held: 0, pushed: 6 });
  });

  it('lets ordinary deletions through, one or a few at a time', async () => {
    const { cloud, phone } = await accountWith(12);
    for (let index = 0; index < 6; index++) {
      phone.change(remove(`w${index}`));
      expect(await phone.sync()).toMatchObject({ held: 0, pushed: 1 });
    }
    expect(cloud.live('workouts')).toHaveLength(6);
  });
});

describe('devices taking turns at random', () => {
  // A seeded generator, so a failure can be run again.
  function random(seed: number) {
    let value = seed;
    return () => {
      value = (value * 1_664_525 + 1_013_904_223) % 4_294_967_296;
      return value / 4_294_967_296;
    };
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])('all end up with what the account holds (run %i)', async (seed) => {
    const next = random(seed);
    const pick = (count: number) => Math.floor(next() * count);
    const cloud = new Cloud();
    const devices = [new Device(cloud), new Device(cloud), new Device(cloud)];
    let made = 0;

    for (let step = 0; step < 200; step++) {
      const device = devices[pick(devices.length)];
      const action = pick(10);
      const existing = device.state.workouts;
      if (action < 3) device.change(addWorkout(`w${made++}`, `Workout ${made}`));
      else if (action < 5 && existing.length > 0) device.change(rename(existing[pick(existing.length)].id, `Renamed at step ${step}`));
      else if (action < 6 && existing.length > 0) device.change(remove(existing[pick(existing.length)].id));
      else if (action < 7) device.change((draft) => { draft.settings.restSeconds = pick(600); });
      else await device.sync();
    }
    // Everyone syncs until nothing moves any more.
    for (let round = 0; round < 3; round++) for (const device of devices) await device.sync();

    const held = [...cloud.docs.values()].filter((doc) => !doc.deleted && doc.kind === 'workouts')
      .map((doc) => JSON.parse(doc.payload).name).sort();
    for (const device of devices) {
      expect(device.names('workouts')).toEqual(held);
      expect(device.state.settings.restSeconds).toBe(JSON.parse(cloud.docs.get(SETTINGS_KEY)!.payload).restSeconds);
      expect(await device.sync()).toMatchObject({ pulled: 0, pushed: 0 });
    }
    expect(fingerprint(JSON.stringify(devices[0].names('workouts')))).toBe(fingerprint(JSON.stringify(devices[2].names('workouts'))));
  });
});
