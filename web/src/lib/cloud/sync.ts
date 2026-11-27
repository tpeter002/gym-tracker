import type { Shadow, SyncMemory, SyncProgress } from '../db';
import type { AppState } from '../types';
import { cloudView, fingerprint, GONE, kindOf, MAX_PAYLOAD, readRemote } from './records';
import type { Change, Kind, RemoteDoc } from './records';

// Keeping a device and an account in step.
//
// The device's own database stays the copy the app works from; this brings the
// two together whenever it gets the chance. It works from what is there, not
// from a log of what was done: for every record the device remembers a
// "shadow" — the fingerprint of what the cloud held when the two last agreed,
// and of what the device held then. A record whose fingerprint has moved away
// from its shadow was changed here; a document whose fingerprint has, was
// changed elsewhere.
//
//   changed elsewhere only   the device takes it over
//   changed here only        the device sends it
//   changed in both places   the device's version stays and is sent: whichever
//                            device syncs last has the last word on a record
//   never agreed on before   the cloud's version is taken
//
// Run twice, or cut off half-way, it ends in the same place: nothing is
// marked as agreed before it is both saved here and written there. And what
// the device is about to write it notes first, so that a write whose answer
// never came is still known as its own when it turns up in the cloud — and is
// not taken for another device's news, to be laid over what was done since.

/** A document to write. */
export interface OutgoingDoc {
  key: string;
  kind: Kind;
  payload: string;
  deleted: boolean;
}

/** The account's side: cloud/firebase.ts in the app, a stand-in in the tests. */
export interface Remote {
  /** Documents written after `since` (the server's clock, milliseconds), oldest first. */
  changedSince(since: number): Promise<RemoteDoc[]>;
  /** Writes these documents: all of them, or — when it throws — none. */
  write(docs: OutgoingDoc[]): Promise<void>;
}

/** The device's side: the store and its database in the app. */
export interface Local {
  /** What the database holds, once every change so far is written. null: storage is not to be trusted right now. */
  read(): Promise<AppState | null>;
  /**
   * Makes these changes — but only to records that still have the fingerprint
   * they were judged by. Returns the keys it left alone because they had moved.
   */
  apply(changes: readonly { change: Change; expected: string }[]): Set<string>;
  remember(): Promise<SyncMemory>;
  /** Notes, before a write is sent, the fingerprint each document is about to get. */
  noteSending(hashes: ReadonlyMap<string, string>): Promise<void>;
  memorize(shadows: ReadonlyMap<string, Shadow>, progress: SyncProgress): Promise<void>;
}

export interface SyncOptions {
  /** false: only take over what the cloud has. For a device's first contact, before it has anything worth sending. */
  push?: boolean;
  /** true: the person has agreed to a large removal that would otherwise be held back. */
  allowRemovals?: boolean;
  /** The device's clock; only ever compared with itself. */
  now?: number;
}

export interface SyncResult {
  /** Documents taken over from the cloud. */
  pulled: number;
  /** Documents written to it. */
  pushed: number;
  /** Removals held back until the person says they are meant. Everything else was sent. */
  held: number;
  /** Records too long to be stored in the cloud. */
  tooLarge: number;
  /** Documents this version of the app couldn't read, and left alone. */
  unreadable: number;
}

/** The device's storage couldn't be read or written, so nothing was sent and nothing marked as done. */
export class StorageTrouble extends Error {}

/**
 * A write stamped just before the newest one a device has seen may still have
 * been on its way when the device looked. So the last moments before the
 * cursor are looked over again — until one such look has been taken at least
 * this long after the cursor moved, by which time anything on its way has
 * landed. After that the device asks only for what is newer, and a batch of a
 * thousand records with one time stamp is not read again at every sync.
 */
export const OVERLAP_MS = 30_000;
/**
 * From this many removals of one kind on — workouts, say — if they are also a
 * quarter or more of what the account holds of that kind, the person is asked
 * first. Counted per kind: thirty workouts are everything to their owner, and
 * a small part of an account that also holds two hundred built-in exercises.
 */
export const HOLD_REMOVALS_FROM = 5;
/** From this many removals of one kind on, the person is asked whatever part of the account they are. */
export const HOLD_REMOVALS_ALWAYS_FROM = 25;
/** One write to the cloud carries at most this many documents and this much text. */
const CHUNK_DOCS = 300;
const CHUNK_CHARS = 3_000_000;

// Exercises and videos go out before the workouts that point at them, so a
// device catching up between two writes never sees a workout without its exercises.
const SEND_ORDER: readonly Kind[] = ['videos', 'exercises', 'bodyWeights', 'workouts', 'settings', 'meta'];

function chunks<T extends OutgoingDoc>(docs: T[]): T[][] {
  const all: T[][] = [];
  let current: T[] = [];
  let size = 0;
  for (const doc of docs) {
    if (current.length > 0 && (current.length >= CHUNK_DOCS || size + doc.payload.length > CHUNK_CHARS)) {
      all.push(current);
      current = [];
      size = 0;
    }
    current.push(doc);
    size += doc.payload.length;
  }
  if (current.length > 0) all.push(current);
  return all;
}

const hashOf = (payload: string | undefined) => (payload === undefined ? GONE : fingerprint(payload));

/**
 * For `Local.apply`: the changes that may still be made to `state`, and the
 * keys of those that may not because the record has moved since it was judged
 * — typed into in the meantime, or changed by another tab this one hasn't
 * caught up with.
 */
export function stillAsJudged(state: AppState, items: readonly { change: Change; expected: string }[]): { changes: Change[]; leftAlone: Set<string> } {
  const view = cloudView(state);
  const changes: Change[] = [];
  const leftAlone = new Set<string>();
  for (const { change, expected } of items) {
    if (hashOf(view.get(change.key)) === expected) changes.push(change);
    else leftAlone.add(change.key);
  }
  return { changes, leftAlone };
}

export async function syncOnce(local: Local, remote: Remote, { push = true, allowRemovals = false, now = Date.now() }: SyncOptions = {}): Promise<SyncResult> {
  const memory = await local.remember();
  // Before anything is asked of the cloud: a device that can't read its own storage would only spend the request.
  if (!(await local.read())) throw new StorageTrouble();
  const shadows = new Map(memory.shadows);
  const moved = new Map<string, Shadow>();
  const agree = (key: string, shadow: Shadow) => {
    shadows.set(key, shadow);
    moved.set(key, shadow);
  };

  const docs = await remote.changedSince(memory.lookedBack ? memory.cursor : Math.max(0, memory.cursor - OVERLAP_MS));
  let disk = await local.read();
  if (!disk) throw new StorageTrouble();
  let view = cloudView(disk);
  const result: SyncResult = { pulled: 0, pushed: 0, held: 0, tooLarge: 0, unreadable: 0 };

  // What the cloud has that this device hasn't seen.
  const incoming: { change: Change; expected: string; remoteHash: string }[] = [];
  for (const doc of docs) {
    const remoteHash = doc.deleted ? GONE : fingerprint(doc.payload);
    let known = shadows.get(doc.key);
    if (known?.remote === remoteHash) continue; // seen before — often this device's own write coming back
    // This device's own write, whose arrival it never got to note: agreed on as it was sent, however things stand here now.
    if (memory.sending.get(doc.key) === remoteHash) known = { remote: remoteHash, local: remoteHash };
    const mine = hashOf(view.get(doc.key));
    if (mine === remoteHash) {
      agree(doc.key, { remote: remoteHash, local: mine });
    } else if (known && mine !== known.local) {
      // Changed here as well. Ours stays; noting what the cloud has now leaves ours marked as still to send.
      agree(doc.key, { remote: remoteHash, local: known.local });
    } else {
      const change = readRemote(doc);
      if (change) {
        incoming.push({ change, expected: mine, remoteHash });
      } else {
        // Not overwritten either: to a newer version of the app it may be perfectly good.
        result.unreadable++;
        agree(doc.key, { remote: remoteHash, local: mine });
      }
    }
  }

  let caughtUp = true;
  if (incoming.length > 0) {
    const leftAlone = local.apply(incoming);
    disk = await local.read();
    if (!disk) throw new StorageTrouble(); // not saved: marking these as taken over would later read as "deleted here"
    view = cloudView(disk);
    for (const { change, remoteHash } of incoming) {
      if (leftAlone.has(change.key)) {
        caughtUp = false; // asked for again next time
        continue;
      }
      agree(change.key, { remote: remoteHash, local: hashOf(view.get(change.key)) });
      result.pulled++;
    }
  }
  const cursor = caughtUp ? docs.reduce((newest, doc) => Math.max(newest, doc.at), memory.cursor) : memory.cursor;
  const progress: SyncProgress = cursor !== memory.cursor
    ? { cursor, cursorAt: now, lookedBack: false }
    // This look was a look back, and came late enough: from here on only what is newer is asked for.
    : { cursor, cursorAt: memory.cursorAt, lookedBack: memory.lookedBack || (caughtUp && now - memory.cursorAt >= OVERLAP_MS) };

  // What this device has that the cloud hasn't.
  let failure: unknown = null;
  if (push) {
    const changed: (OutgoingDoc & { hash: string })[] = [];
    for (const [key, payload] of view) {
      const hash = fingerprint(payload);
      if (shadows.get(key)?.local === hash) continue;
      const kind = kindOf(key);
      if (!kind) continue;
      if (payload.length > MAX_PAYLOAD) result.tooLarge++;
      else changed.push({ key, kind, payload, deleted: false, hash });
    }
    changed.sort((a, b) => SEND_ORDER.indexOf(a.kind) - SEND_ORDER.indexOf(b.kind));

    const removed: (OutgoingDoc & { hash: string })[] = [];
    // Per kind: how many records the account holds as far as this device knows, and how many of them are gone here.
    const counts = new Map<Kind, { live: number; gone: number }>();
    for (const [key, known] of shadows) {
      const kind = kindOf(key);
      if (known.local === GONE || !kind) continue;
      const count = counts.get(kind) ?? { live: 0, gone: 0 };
      counts.set(kind, count);
      count.live++;
      if (view.has(key)) continue;
      count.gone++;
      removed.push({ key, kind, payload: '', deleted: true, hash: GONE });
    }

    // People delete records one at a time. A device that suddenly wants a
    // large part of the account gone is more often mistaken — its storage
    // damaged, an old backup restored — than right, and what it removes is
    // removed from every other device too. So it asks; what it has to add or
    // change goes out meanwhile.
    const large = [...counts.values()].some(({ live, gone }) =>
      gone >= HOLD_REMOVALS_FROM && (gone * 4 >= live || gone >= HOLD_REMOVALS_ALWAYS_FROM));
    const holding = large && !allowRemovals;
    if (holding) result.held = removed.length;
    try {
      for (const chunk of chunks(holding ? changed : [...changed, ...removed])) {
        await local.noteSending(new Map(chunk.map((doc) => [doc.key, doc.hash])));
        await remote.write(chunk.map(({ key, kind, payload, deleted }) => ({ key, kind, payload, deleted })));
        for (const doc of chunk) agree(doc.key, { remote: doc.hash, local: doc.hash });
        result.pushed += chunk.length;
      }
    } catch (error) {
      failure = error; // what did get through is still remembered below
    }
  }

  await local.memorize(moved, progress);
  if (failure) throw failure;
  return result;
}
