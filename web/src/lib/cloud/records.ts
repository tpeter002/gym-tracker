import { ownToThisBrowser, RECORD_READERS } from '../backup';
import { normalizeSettings } from '../types';
import type { AppState, Settings } from '../types';

// What of the app's state belongs in an account, and in what form.
//
// The cloud holds one document per record — a workout, an exercise, a
// weigh-in, a saved video — plus one for the settings and one for the version
// of the built-in exercise list. Each document's content is the record as
// JSON text: the cloud never looks inside it.

export const COLLECTIONS = ['exercises', 'workouts', 'bodyWeights', 'videos'] as const;
export type Collection = (typeof COLLECTIONS)[number];
export const KINDS = [...COLLECTIONS, 'settings', 'meta'] as const;
export type Kind = (typeof KINDS)[number];

export const SETTINGS_KEY = 'settings_app';
export const LIBRARY_KEY = 'meta_library';

/**
 * How long a record's text may be. cloud/firestore.rules refuses anything
 * longer. A long workout is a few thousand characters and a saved video with
 * its thumbnail a few tens of thousands; in the worst case of three bytes a
 * character this still fits Firestore's limit of a megabyte a document.
 */
export const MAX_PAYLOAD = 200_000;

/** The fingerprint of a record that isn't there. */
export const GONE = '';

function cyrb53(text: string, seed: number): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    h1 = Math.imul(h1 ^ code, 2654435761);
    h2 = Math.imul(h2 ^ code, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
}

/**
 * A short stand-in for a text, to tell whether two are the same without
 * keeping either. Not a secret-keeping hash: it only ever compares a person's
 * own records with each other.
 */
export const fingerprint = (text: string): string => cyrb53(text, 1) + cyrb53(text, 2);

const PLAIN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * The name of a record's document. Ids made by this app go in as they are; one
 * from a restored file can be anything, so anything else goes in as its
 * fingerprint ("=" can't occur in a plain id, so the two never collide).
 */
export const recordKey = (kind: Kind, id: string): string =>
  `${kind}_${PLAIN_ID.test(id) ? id : `=${fingerprint(id)}`}`;

export function kindOf(key: string): Kind | null {
  const kind = key.slice(0, key.indexOf('_'));
  return (KINDS as readonly string[]).includes(kind) ? (kind as Kind) : null;
}

/**
 * The settings that never go to an account, nor are taken from one: what
 * belongs to one browser (API keys, the share inbox) and the analyzer's
 * address. An API key is sent to whatever address is set — so the address has
 * to be one typed on this device, never one that arrived from elsewhere.
 */
const keptHere = (settings: Settings) => ({ ...ownToThisBrowser(settings), analyzerURL: settings.analyzerURL });

/** The settings as an account holds them. */
function sharedSettings(settings: Settings): Partial<Settings> {
  const shared: Partial<Settings> = { ...settings };
  for (const name of Object.keys(keptHere(settings)) as (keyof Settings)[]) delete shared[name];
  return shared;
}

/**
 * Everything in `state` that belongs in the account, as document name → text.
 * A workout in progress is not among them: it stays on the device it was
 * started on until it is finished.
 */
export function cloudView(state: AppState): Map<string, string> {
  const view = new Map<string, string>();
  for (const kind of COLLECTIONS) {
    for (const record of state[kind]) {
      if ('endedAt' in record && record.endedAt === null) continue;
      view.set(recordKey(kind, record.id), JSON.stringify(record));
    }
  }
  view.set(SETTINGS_KEY, JSON.stringify(sharedSettings(state.settings)));
  view.set(LIBRARY_KEY, JSON.stringify({ libraryVersion: state.libraryVersion }));
  return view;
}

/** Whether a change to the state touched anything `cloudView` shows — a workout in progress being typed into doesn't. */
export function touchesCloud(before: AppState, after: AppState): boolean {
  if (before.settings !== after.settings || before.libraryVersion !== after.libraryVersion) return true;
  for (const kind of COLLECTIONS) {
    if (before[kind] === after[kind]) continue;
    const inCloud = (record: { id: string }) => !('endedAt' in record && record.endedAt === null);
    const previous = new Map<string, unknown>(before[kind].filter(inCloud).map((record) => [record.id, record]));
    let kept = 0;
    for (const record of after[kind]) {
      if (!inCloud(record)) continue;
      if (previous.get(record.id) !== record) return true;
      kept++;
    }
    if (kept !== previous.size) return true; // one was deleted
  }
  return false;
}

/** A document as it comes from the cloud. */
export interface RemoteDoc {
  key: string;
  kind: string;
  payload: string;
  deleted: boolean;
  /** The format of `payload`; 1 is JSON text. */
  format: number;
  /** The server's time of the write, in milliseconds. */
  at: number;
}

/** What a document from the cloud asks of this device. */
export type Change =
  | { key: string; kind: Collection; record: AppState[Collection][number] | null }
  | { key: string; kind: 'settings'; settings: Settings }
  | { key: string; kind: 'meta'; libraryVersion: number };

/**
 * Reads a document from the cloud, checking it as a backup file is checked.
 * null when this version of the app can't make sense of it: a kind or a format
 * from a newer version, or damage. Such a document is left as it is.
 */
export function readRemote(doc: RemoteDoc): Change | null {
  const kind = kindOf(doc.key);
  if (!kind || kind !== doc.kind) return null;
  if (doc.deleted) {
    // The settings and the library version are never deleted, only changed.
    return kind === 'settings' || kind === 'meta' ? null : { key: doc.key, kind, record: null };
  }
  if (doc.format !== 1) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(doc.payload);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const raw = parsed as Record<string, unknown>;

  if (kind === 'settings') {
    return doc.key === SETTINGS_KEY ? { key: doc.key, kind, settings: normalizeSettings(raw) } : null;
  }
  if (kind === 'meta') {
    const version = raw.libraryVersion;
    return doc.key === LIBRARY_KEY && typeof version === 'number' && Number.isInteger(version) && version >= 0
      ? { key: doc.key, kind, libraryVersion: version }
      : null;
  }
  try {
    const record = RECORD_READERS[kind](raw);
    if (recordKey(kind, record.id) !== doc.key) return null;
    if ('endedAt' in record && record.endedAt === null) return null; // a workout in progress is never sent
    return { key: doc.key, kind, record };
  } catch {
    return null;
  }
}

/** Carries out what the cloud's documents ask, on a draft of the state. */
export function applyChanges(state: AppState, changes: readonly Change[]): void {
  for (const kind of COLLECTIONS) {
    const mine = changes.filter((change) => change.kind === kind) as Extract<Change, { kind: Collection }>[];
    if (mine.length === 0) continue;
    const records = state[kind] as { id: string }[];
    const incoming = new Map(mine.map((change) => [change.key, change.record]));
    for (let index = records.length - 1; index >= 0; index--) {
      const key = recordKey(kind, records[index].id);
      if (!incoming.has(key)) continue;
      const record = incoming.get(key);
      if (record) records[index] = record;
      else records.splice(index, 1);
      incoming.delete(key);
    }
    for (const record of incoming.values()) {
      if (record) records.push(record);
    }
  }
  for (const change of changes) {
    // What is kept here stays, whatever the account says.
    if (change.kind === 'settings') state.settings = { ...change.settings, ...keptHere(state.settings) };
    if (change.kind === 'meta') state.libraryVersion = change.libraryVersion;
  }
}
