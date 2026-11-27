import { clearSyncMemory, deleteDatabase, loadSyncMemory, noteSending, saveSyncMemory } from '../db';
import { seedLibrary } from '../exercises';
import { signal } from '../signal';
import { closeStore, currentDatabase, getState, initStore, onChange, readSaved, update } from '../store';
import { activeWorkout } from '../workouts';
import { CloudError } from './backend';
import type { Account, Backend, Trouble } from './backend';
import { applyChanges, touchesCloud } from './records';
import { stillAsJudged, StorageTrouble, syncOnce } from './sync';
import type { Local } from './sync';

// An account on this device: who is signed in, opening that person's own
// database, and keeping it in step with the cloud for as long as the app is open.

/** Where the app stands between "nobody is signed in" and "here are your workouts". */
export type Stage =
  | { name: 'starting' }
  | { name: 'signedOut' }
  /** Signed in, but the address has not been confirmed through the link sent to it. */
  | { name: 'unconfirmed'; email: string }
  /** Loading the account's data: its own database, and on a new device everything the cloud holds. */
  | { name: 'opening'; email: string }
  | { name: 'notInvited'; email: string }
  /** A new device couldn't fetch the account's data; `message` says why. */
  | { name: 'stuck'; email: string; message: string }
  | { name: 'ready'; email: string };

export const stage = signal<Stage>({ name: 'starting' });

/** false after creating an account whose confirmation link could not be sent. */
export const linkSent = signal(true);

export interface SyncState {
  busy: boolean;
  /** There are changes on this device the cloud doesn't have yet. */
  waiting: boolean;
  /** Why the last try didn't go through; null when it did. */
  problem: Trouble | 'storage' | null;
  /** Removals held back until the person says they are meant (see sync.ts). */
  held: number;
  tooLarge: number;
  unreadable: number;
  /** When this device and the cloud last agreed. */
  lastSynced: number | null;
}

export const syncState = signal<SyncState>({
  busy: false, waiting: false, problem: null, held: 0, tooLarge: 0, unreadable: 0, lastSynced: null,
});

const databaseName = (uid: string) => `gym-tracker-${uid}`;
const ACCOUNT_DATABASE = /^gym-tracker-.+/;
const lockName = (uid: string) => `gym-tracker-sync-${uid}`;
/** In localStorage: the databases of accounts that were signed out of on purpose and are still to be deleted. */
const LEFT_BEHIND = 'gym-tracker-left';

/** After a change, this long passes before it is sent — so a burst of typing goes as one. */
const SETTLE_MS = 2_500;
/** How long after a failed try the next one comes: soon at first — most failures pass by themselves — then ever later. */
const RETRY_MS = [3_000, 15_000, 60_000, 300_000];
/** How long a yes to removals holds when no sync has been able to use it. */
const YES_LASTS_MS = 10 * 60_000;

let backend: Backend | null = null;
let account: Account | null = null;
/** The account whose database is open, or being opened; one per page load. */
let opened: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;
let again = false;
let failures = 0;
/** Changes the app is making on the cloud's behalf are not news for the cloud. */
let applying = false;
/** Counts changes worth sending, to tell whether another came in while one lot was on its way. */
let generation = 0;
/** Until when (this device's clock) large removals go out without asking: the person has just said they are meant. */
let removalsAllowedUntil = 0;
let leaving = false;

const patch = (changes: Partial<SyncState>) => syncState.set({ ...syncState.get(), ...changes });

function database(): IDBDatabase {
  const db = currentDatabase();
  if (!db) throw new StorageTrouble();
  return db;
}

const local: Local = {
  read: readSaved,
  apply(items) {
    const { changes, leftAlone } = stillAsJudged(getState(), items);
    applying = true;
    try {
      update((draft) => applyChanges(draft, changes));
    } finally {
      applying = false;
    }
    return leftAlone;
  },
  remember: () => loadSyncMemory(database()),
  noteSending: (hashes) => noteSending(database(), hashes),
  memorize: (shadows, progress) => saveSyncMemory(database(), shadows, progress),
};

/** One tab syncs at a time: two at once would each send what the other is sending. null when another tab is at it. */
async function alone<T>(uid: string, work: () => Promise<T>): Promise<T | null> {
  if (!navigator.locks) return work();
  return navigator.locks.request(lockName(uid), { ifAvailable: true }, (lock) => (lock ? work() : null));
}

/** Resolves once no sync is under way. */
async function settled(): Promise<void> {
  while (running) await new Promise((resolve) => setTimeout(resolve, 50));
}

function schedule(delay: number): void {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(() => void sync(), delay);
}

/**
 * Brings this device and the cloud together now. Safe to call at any time;
 * calls while one is running fold into one more. Resolves to whether this
 * call ran a sync to its end.
 */
export async function sync(): Promise<boolean> {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (!backend || !account || opened !== account.uid || stage.get().name !== 'ready' || leaving) return false;
  if (running) {
    again = true;
    return false;
  }
  running = true;
  patch({ busy: true });
  const { uid } = account;
  const sending = generation;
  // As it stands now: a yes given while this run is under way is for the next one, and must not be used up by this one.
  const allowing = Date.now() < removalsAllowedUntil;
  const remote = backend.remote(uid);
  let completed = false;
  try {
    const result = await alone(uid, () => syncOnce(local, remote, { allowRemovals: allowing }));
    if (result === null) {
      schedule(5_000);
    } else {
      completed = true;
      failures = 0;
      if (allowing) removalsAllowedUntil = 0;
      patch({
        problem: null, held: result.held, tooLarge: result.tooLarge, unreadable: result.unreadable,
        lastSynced: Date.now(), waiting: generation !== sending || result.held > 0,
      });
    }
  } catch (error) {
    const problem = error instanceof StorageTrouble ? 'storage' : error instanceof CloudError ? error.trouble : 'other';
    patch({ problem });
    // Told no, there is nothing to try again until something changes: an invitation, or tomorrow's allowance.
    if (problem !== 'denied' && problem !== 'quota') {
      schedule(RETRY_MS[Math.min(failures, RETRY_MS.length - 1)]);
      failures++;
    }
  } finally {
    running = false;
    patch({ busy: false });
    if (again) {
      again = false;
      schedule(0);
    }
  }
  return completed;
}

function watchForChanges(): void {
  onChange((before, after) => {
    if (applying || !touchesCloud(before, after)) return;
    generation++;
    patch({ waiting: true });
    schedule(SETTLE_MS);
  });
  document.addEventListener('visibilitychange', () => {
    // Coming to the front: what did the other devices do? Going to the back: send what is waiting while there is time.
    if (document.visibilityState === 'visible' || syncState.get().waiting) void sync();
  });
  window.addEventListener('online', () => void sync());
}

/**
 * Whether the signed-in address is on the guest list. Asked a second time
 * after renewing the login when refused: a login made before the address was
 * confirmed goes on saying "unconfirmed" until it is renewed.
 */
async function isInvited(service: Backend): Promise<boolean> {
  try {
    return await service.invited();
  } catch (error) {
    if (!(error instanceof CloudError) || error.trouble !== 'denied') throw error;
    await service.refresh();
    return service.invited();
  }
}

/** Opens the signed-in account's database and, on a device that has never seen the account, fetches what it holds. */
async function open(): Promise<void> {
  if (!backend || !account) return;
  const service = backend;
  const { uid, email } = account;
  // Asked after every wait: someone else may have signed in, or this person out, in another tab meanwhile.
  const stillThem = () => account?.uid === uid && !leaving;
  stage.set({ name: 'opening', email });
  if (opened === null) {
    opened = uid; // from here on a change of account reloads the page (see follow)
    await initStore({ name: databaseName(uid), syncs: true, seed: false });
  }
  if (!stillThem()) return;
  if (!currentDatabase()) {
    stage.set({ name: 'stuck', email, message: "This browser window gives the app no storage, and an account needs some. (Is it a private window?)" });
    return;
  }
  try {
    const memory = await loadSyncMemory(database());
    if (!memory.synced) {
      if (!(await isInvited(service))) {
        if (stillThem()) stage.set({ name: 'notInvited', email });
        return;
      }
      // Nothing is sent yet: a new browser's defaults have no business in the account.
      await syncOnce(local, service.remote(uid), { push: false });
    }
  } catch (error) {
    if (!stillThem()) return;
    if (error instanceof CloudError && error.trouble === 'denied') {
      stage.set({ name: 'notInvited', email });
    } else {
      const message = error instanceof CloudError
        ? error.message
        : "Couldn't open this browser's storage. Reload and try again.";
      stage.set({ name: 'stuck', email, message: `${message} The first time on a device, your data has to be fetched before the app can open.` });
    }
    return;
  }
  if (!stillThem()) return;
  // Only now: the account's own exercises are there, so the built-in list adds just what is missing.
  update(seedLibrary);
  stage.set({ name: 'ready', email });
  void sync();
}

function leftBehind(): string[] {
  try {
    const names: unknown = JSON.parse(localStorage.getItem(LEFT_BEHIND) ?? '[]');
    return Array.isArray(names) ? names.filter((name): name is string => typeof name === 'string' && ACCOUNT_DATABASE.test(name)) : [];
  } catch {
    return [];
  }
}

function setLeftBehind(names: string[]): void {
  try {
    if (names.length > 0) localStorage.setItem(LEFT_BEHIND, JSON.stringify([...new Set(names)]));
    else localStorage.removeItem(LEFT_BEHIND);
  } catch {
    // Without the note, a deletion that was cut short waits for the next person to sign in here.
  }
}

/** Deletes a database and, once it is gone, the note that it was to go. */
async function forget(name: string): Promise<void> {
  await deleteDatabase(name);
  setLeftBehind(leftBehind().filter((other) => other !== name));
}

/**
 * Finishes deletions that signing out started and couldn't complete, and —
 * once someone is signed in — deletes any other account's database: the
 * browser is theirs now. What it never deletes is the database of an account
 * that was signed out without the person asking (an expired login, a changed
 * password): that may hold workouts the cloud doesn't have, and they are
 * sent when the person signs in again.
 */
async function sweep(keep: string | null): Promise<void> {
  const doomed = new Set(leftBehind());
  if (keep !== null) {
    try {
      for (const info of await indexedDB.databases()) {
        if (info.name && ACCOUNT_DATABASE.test(info.name)) doomed.add(info.name);
      }
    } catch {
      // Not every browser can list its databases; the ones noted as left behind are deleted all the same.
    }
    doomed.delete(keep);
    // Back again: the database is in use, not left behind.
    setLeftBehind(leftBehind().filter((name) => name !== keep));
  }
  await Promise.all([...doomed].map((name) => forget(name).catch(() => undefined)));
}

async function follow(next: Account | null): Promise<void> {
  if (leaving) return;
  // Signed out, or signed in as someone else, in another tab: this page's database is no longer the right one.
  if (opened !== null && next?.uid !== opened) {
    window.location.reload();
    return;
  }
  account = next;
  if (!next) {
    stage.set({ name: 'signedOut' });
    void sweep(null);
  } else if (!next.verified) {
    stage.set({ name: 'unconfirmed', email: next.email });
  } else if (stage.get().name !== 'ready' && stage.get().name !== 'opening') {
    void sweep(databaseName(next.uid));
    await open();
  }
}

/** Starts watching who is signed in. Called once, by a build that has accounts. */
export function startSession(service: Backend): void {
  backend = service;
  watchForChanges();
  backend.watch((next) => void follow(next));
}

const service = (): Backend => {
  if (!backend) throw new CloudError('other', 'This copy of the app has no accounts.');
  return backend;
};

export const signIn = (email: string, password: string) => service().signIn(email.trim(), password);
export const resetPassword = (email: string) => service().resetPassword(email.trim());

export async function signUp(email: string, password: string): Promise<void> {
  linkSent.set(await service().signUp(email.trim(), password));
}

export async function sendVerification(): Promise<void> {
  await service().sendVerification();
  linkSent.set(true);
}

/** After the link in the email was opened: asks whether the address counts as confirmed now. */
export async function checkConfirmed(): Promise<boolean> {
  const fresh = await service().refresh();
  await follow(fresh);
  return fresh?.verified === true;
}

/** From "not invited" or "couldn't fetch": tries to open the account again. */
export const tryAgain = (): Promise<void> => open();

/**
 * The person has just replaced everything on purpose (restoring a backup, and
 * was told what that does): what the next sync removes from the account is meant.
 */
export function expectRemovals(): void {
  removalsAllowedUntil = Date.now() + YES_LASTS_MS;
}

/** The person has agreed to the removals that were held back. */
export async function confirmRemovals(): Promise<void> {
  removalsAllowedUntil = Date.now() + YES_LASTS_MS;
  await settled(); // a run already under way started without the yes
  await sync();
}

/** The person wants the held-back records back: the device forgets where it stood and takes the account as it is. */
export async function keepRemoved(): Promise<void> {
  if (!account) return;
  // Not under a running sync's feet — this tab's or another's: it would write
  // back the place it had read up to, and the fresh start would be lost.
  await settled();
  running = true;
  try {
    const clear = () => clearSyncMemory(database());
    if (navigator.locks) await navigator.locks.request(lockName(account.uid), clear);
    else await clear();
  } finally {
    running = false;
  }
  patch({ held: 0 });
  await sync();
}

/** Deletes this account's data from the device and reloads the page, which then shows the sign-in. */
async function leave(uid: string, signOutToo: boolean): Promise<void> {
  leaving = true;
  if (timer !== null) clearTimeout(timer);
  const name = databaseName(uid);
  // Noted first: if the deletion is cut short — the tab closed, another tab holding on — the next start finishes it.
  setLeftBehind([...leftBehind(), name]);
  closeStore();
  await Promise.race([forget(name).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 3_000))]);
  if (signOutToo) await service().signOut().catch(() => undefined);
  window.location.reload();
}

/** What signing out would lose, when it would lose something. */
export type AtStake =
  /** A workout in progress, which is kept on this device only. */
  | 'workout'
  /** Records too large for the cloud, kept on this device only. */
  | 'tooLarge'
  /** Changes that could not be sent, or could not be checked to have been. */
  | 'unsent';

/**
 * Signs out and removes the account's data from this device. Sends what is
 * waiting first. When something would be lost, it does nothing and says what
 * — unless `whateverIsLost`.
 */
export async function signOut(whateverIsLost = false): Promise<AtStake | null> {
  if (!account) return null;
  const { uid } = account;
  if (opened === uid && stage.get().name === 'ready' && !whateverIsLost) {
    if (activeWorkout(getState())) return 'workout';
    await settled();
    const completed = await sync();
    const now = syncState.get();
    // Not completed: another tab is syncing, or it failed — either way nobody has checked that the account has everything.
    if (!completed || now.waiting || now.problem !== null) return 'unsent';
    if (now.tooLarge > 0) return 'tooLarge';
  }
  leaving = true;
  await settled();
  await leave(uid, true);
  return null;
}

/**
 * Signs out and nothing else, from the screens that come before the app. What
 * the device holds for the account, if anything, is left as it is: nobody was
 * asked about losing it, and it is there again when the same person signs in.
 */
export async function signOutOnly(): Promise<void> {
  leaving = true;
  await service().signOut().catch(() => undefined);
  window.location.reload();
}

/** Deletes the account: every record in the cloud, the login, and the copy on this device. */
export async function deleteAccount(password: string): Promise<void> {
  if (!account) return;
  const { uid } = account;
  await service().confirmPassword(password); // a wrong password stops it here, with nothing touched
  leaving = true; // no more syncing: it would write records back while they are being deleted
  await settled();
  try {
    await service().deleteEverything();
  } catch (error) {
    // Part of the account may be gone from the cloud. Forgetting where syncing
    // stood makes this device send everything it has again, so the account is
    // whole if the person leaves it at that — and can be deleted in one piece
    // when they try again.
    await Promise.resolve().then(() => clearSyncMemory(database())).catch(() => undefined);
    leaving = false;
    void sync();
    throw error;
  }
  await leave(uid, false);
}
