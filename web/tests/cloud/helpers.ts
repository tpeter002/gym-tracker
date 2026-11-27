import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addExercise } from '../e2e/helpers';

// The Firebase emulators as the tests steer them: accounts made and confirmed
// behind the app's back, the guest list, and a look at what the database holds.
// Requests marked "owner" go past the rules, as the project's owner does in the console.

const PROJECT = 'demo-gym-tracker';
const AUTH = 'http://localhost:9099';
const FIRESTORE = `http://localhost:8089/v1/projects/${PROJECT}/databases/(default)/documents`;
const OWNER = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };

export const PASSWORD = 'correct-horse-battery';

let made = 0;
/** An address nobody has used yet: the tests run side by side against one set of emulators. */
export const newAddress = (name = 'lifter') =>
  `${name}-${Date.now().toString(36)}-${process.pid}-${made++}@example.com`;

async function post(url: string, body: unknown, headers: Record<string, string> = { 'Content-Type': 'application/json' }) {
  const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!response.ok) throw new Error(`${url} answered ${response.status}: ${await response.text()}`);
  return (await response.json()) as Record<string, unknown>;
}

/** Puts an address on the guest list, as the owner does in the console. */
export async function invite(email: string): Promise<void> {
  const response = await fetch(`${FIRESTORE}/allowed/${encodeURIComponent(email)}`, {
    method: 'PATCH', headers: OWNER, body: JSON.stringify({ fields: {} }),
  });
  if (!response.ok) throw new Error(`inviting ${email} answered ${response.status}`);
}

export async function uninvite(email: string): Promise<void> {
  await fetch(`${FIRESTORE}/allowed/${encodeURIComponent(email)}`, { method: 'DELETE', headers: OWNER });
}

/** Opens the newest link the service "sent" to an address — to confirm it, or to set a new password. */
export async function openEmailLink(email: string, kind: 'VERIFY_EMAIL' | 'PASSWORD_RESET', newPassword?: string): Promise<void> {
  let link: string | undefined;
  await expect.poll(async () => {
    const sent = (await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json()) as { oobCodes: { email: string; requestType: string; oobLink: string }[] };
    link = sent.oobCodes.filter((code) => code.email === email && code.requestType === kind).at(-1)?.oobLink;
    return link;
  }).toBeTruthy();
  const response = await fetch(newPassword ? `${link}&newPassword=${encodeURIComponent(newPassword)}` : link!);
  if (!response.ok) throw new Error(`the link answered ${response.status}`);
}

/** How many links of a kind were sent to an address. */
export async function emailsSent(email: string, kind: 'VERIFY_EMAIL' | 'PASSWORD_RESET'): Promise<number> {
  const sent = (await (await fetch(`${AUTH}/emulator/v1/projects/${PROJECT}/oobCodes`)).json()) as { oobCodes: { email: string; requestType: string }[] };
  return sent.oobCodes.filter((code) => code.email === email && code.requestType === kind).length;
}

/** An account that can use the app: made, its address confirmed, and invited. Returns its id. */
export async function makeAccount(email: string, { invited = true, confirmed = true } = {}): Promise<string> {
  const created = await post(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key`, { email, password: PASSWORD, returnSecureToken: true });
  const uid = created.localId as string;
  if (confirmed) await post(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`, { localId: uid, emailVerified: true }, OWNER);
  if (invited) await invite(email);
  return uid;
}

/** Whether the login still exists. */
export async function accountExists(email: string): Promise<boolean> {
  const found = await post(`${AUTH}/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:lookup`, { email: [email] }, OWNER);
  return Array.isArray(found.users) && found.users.length > 0;
}

export interface StoredRecord {
  key: string;
  kind: string;
  deleted: boolean;
  /** The record itself; null for a deleted one. */
  record: Record<string, unknown> | null;
}

/** Everything the database holds for an account, read as the owner. */
export async function recordsOf(uid: string): Promise<StoredRecord[]> {
  const all: StoredRecord[] = [];
  let pageToken = '';
  do {
    const response = await fetch(`${FIRESTORE}/users/${uid}/records?pageSize=300${pageToken ? `&pageToken=${pageToken}` : ''}`, { headers: OWNER });
    const page = (await response.json()) as { documents?: { name: string; fields: Record<string, { stringValue?: string; booleanValue?: boolean }> }[]; nextPageToken?: string };
    for (const item of page.documents ?? []) {
      const deleted = item.fields.d?.booleanValue === true;
      all.push({
        key: item.name.split('/').pop()!,
        kind: item.fields.k?.stringValue ?? '',
        deleted,
        record: deleted ? null : JSON.parse(item.fields.p?.stringValue ?? 'null'),
      });
    }
    pageToken = page.nextPageToken ?? '';
  } while (pageToken);
  return all;
}

export const liveRecords = async (uid: string, kind: string) =>
  (await recordsOf(uid)).filter((item) => item.kind === kind && !item.deleted).map((item) => item.record!);

/** Signs in through the form and waits for the app itself. */
export async function signIn(page: Page, email: string, password = PASSWORD): Promise<void> {
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Workout', level: 1 })).toBeVisible();
}

/**
 * Goes to a page of the app the way a tap on a link does. Not page.goto: the
 * WebKit the tests drive loads the whole page again for that, which cuts off
 * whatever the app was sending at that moment.
 */
export async function go(page: Page, path: string): Promise<void> {
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, `#${path}`);
}

/** Restores a backup file's text through Settings, saying yes to the question. */
export async function restore(page: Page, backup: string, said: string): Promise<void> {
  await go(page, '/settings');
  await page.getByLabel('Backup file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect(page.getByRole('alertdialog')).toContainText('What is in your account now will be overwritten.');
  await page.getByRole('button', { name: 'Replace' }).click();
  await expect(page.getByText(said)).toBeVisible();
}

/** Logs one set of an exercise in a new workout and finishes it; ends on the History page. */
export async function logWorkout(page: Page, search = 'bench press', name = 'Bench Press (Barbell)'): Promise<void> {
  await go(page, '/');
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await addExercise(page, search, name);
  const entry = page.getByRole('region', { name });
  await entry.getByLabel('Weight').first().fill('60');
  await entry.getByLabel('Reps').first().fill('5');
  await entry.getByRole('button', { name: 'Mark set as done' }).first().click();
  await page.getByRole('button', { name: 'Finish' }).click();
  // Asked only when sets are left unticked — which depends on how many rows last time left behind.
  const question = page.getByRole('alertdialog', { name: 'Finish workout?' }).getByRole('button', { name: 'Finish' });
  await expect(question.or(page.getByRole('heading', { name: 'History', level: 1 }))).toBeVisible();
  if (await question.isVisible()) await question.click();
  await expect(page).toHaveURL(/#\/history$/);
}

/** Signs out through Settings and waits for the sign-in page. */
export async function signOut(page: Page): Promise<void> {
  await go(page, '/settings');
  await page.getByRole('button', { name: 'Sign Out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign In', level: 1 })).toBeVisible();
}

/** Opens Settings and waits until this device and the account agree. */
export async function synced(page: Page): Promise<void> {
  await go(page, '/settings');
  const button = page.getByRole('button', { name: /Sync Now/ });
  // Asked for only when no sync is under way: one that is may have started before the latest change.
  await expect(button).toBeEnabled();
  await button.click();
  await expect(button).toContainText('Up to date');
}

/**
 * Makes the browser lose the login behind the app's back — as when a login
 * runs out, or the password was changed on another device. Ends on the sign-in page.
 */
export async function loseLogin(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('firebaseLocalStorageDb');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const tx = database.transaction('firebaseLocalStorage', 'readwrite');
      tx.objectStore('firebaseLocalStorage').clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    database.close();
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Sign In', level: 1 })).toBeVisible();
}

/** The names of the databases this site keeps in the browser. */
export const databases = (page: Page) => page.evaluate(async () => (await indexedDB.databases()).map((info) => info.name));

/** What happens when the app is brought back to the front. */
export const comeBack = (page: Page) => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

/** Collects what the browser refused because of the page's security policy; the list should stay empty. */
export function watchPolicy(page: Page): string[] {
  const refused: string[] = [];
  page.on('console', (message) => {
    if (/Content Security Policy|Refused to/i.test(message.text())) refused.push(message.text());
  });
  return refused;
}
