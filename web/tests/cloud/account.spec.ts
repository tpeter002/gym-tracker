import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  accountExists, databases, emailsSent, go, invite, liveRecords, logWorkout, loseLogin, makeAccount, newAddress, openEmailLink,
  PASSWORD, recordsOf, signIn, signOut, synced, uninvite, watchPolicy,
} from './helpers';

// Getting into the version with accounts, and out of it again: signing up,
// confirming the address, the guest list, a forgotten password, signing out,
// deleting the account. Runs against the Firebase emulators (cloud/README.md).

const heading = (page: Page, name: string) => page.getByRole('heading', { name, level: 1 });

test('a new person creates an account, confirms the address, and gets in once invited', async ({ page }) => {
  const refused = watchPolicy(page);
  const email = newAddress('newcomer');
  await page.goto('/');
  await expect(heading(page, 'Sign In')).toBeVisible();

  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByText('Accounts are by invitation.')).toContainText('Sam (sam@example.com)');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();

  // The address has to be proved first: an account with someone else's address opens nothing.
  await expect(heading(page, 'Confirm Your Address')).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  await page.getByRole('button', { name: "I've Opened the Link" }).click();
  await expect(page.getByRole('alert')).toHaveText("That address isn't confirmed yet. Open the link in the email first.");
  await openEmailLink(email, 'VERIFY_EMAIL');
  await page.getByRole('button', { name: "I've Opened the Link" }).click();

  // Confirmed, but nobody has invited this address.
  await expect(heading(page, 'Not on the Guest List Yet')).toBeVisible();
  await page.getByRole('button', { name: 'Try Again' }).click();
  await expect(heading(page, 'Not on the Guest List Yet')).toBeVisible();
  await page.reload();
  await expect(heading(page, 'Not on the Guest List Yet')).toBeVisible();

  await invite(email);
  await page.getByRole('button', { name: 'Try Again' }).click();
  await expect(heading(page, 'Workout')).toBeVisible();
  // A new account starts with the built-in exercises.
  await go(page, '/exercises');
  await expect(page.getByRole('link', { name: /^Bench Press \(Barbell\)/ })).toBeVisible();
  expect(refused).toEqual([]);
});

test('the link can be sent again, and the confirmation screen can be left', async ({ page }) => {
  const email = newAddress();
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(heading(page, 'Confirm Your Address')).toBeVisible();
  expect(await emailsSent(email, 'VERIFY_EMAIL')).toBe(1);

  await page.getByRole('button', { name: 'Send It Again' }).click();
  await expect(page.getByRole('status')).toHaveText('Sent again.');
  expect(await emailsSent(email, 'VERIFY_EMAIL')).toBe(2);

  await page.getByRole('button', { name: 'Sign Out' }).click();
  await expect(heading(page, 'Sign In')).toBeVisible();
});

test('confirming the address and then simply opening the app again is enough', async ({ page }) => {
  const email = newAddress('reopens');
  await invite(email);
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(heading(page, 'Confirm Your Address')).toBeVisible();
  await openEmailLink(email, 'VERIFY_EMAIL');

  // No tap on "I've Opened the Link": the app is closed and opened, as from a Home Screen. The login it
  // still holds was made before the address was confirmed, and has to be renewed before the door opens.
  await page.reload();
  await expect(heading(page, 'Workout')).toBeVisible();
});

test('an account whose confirmation link could not be sent says so, and the link can be asked for again', async ({ page }) => {
  const email = newAddress();
  await page.route(/accounts:sendOobCode/, (route) => route.abort());
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(heading(page, 'Confirm Your Address')).toBeVisible();
  await expect(page.getByText("the link that confirms the address couldn't be sent just now")).toBeVisible();
  expect(await emailsSent(email, 'VERIFY_EMAIL')).toBe(0);

  await page.unroute(/accounts:sendOobCode/);
  await page.getByRole('button', { name: 'Send It Again' }).click();
  await expect(page.getByRole('status')).toHaveText('Sent again.');
  await expect(page.getByText('A link was sent to')).toBeVisible();
  expect(await emailsSent(email, 'VERIFY_EMAIL')).toBe(1);
});

test('a password that is too short, or an address already taken, creates nothing', async ({ page }) => {
  const taken = newAddress('taken');
  await makeAccount(taken);
  const email = newAddress();
  await page.goto('/');
  await page.getByRole('button', { name: 'Create Account' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('too-short');
  // The browser itself stops a form with too short a password, so the check behind it is asked directly.
  await page.getByLabel('Password').evaluate((field: HTMLInputElement) => field.removeAttribute('minlength'));
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('alert')).toHaveText('Use at least 10 characters for the password.');
  expect(await accountExists(email)).toBe(false);

  await page.getByLabel('Email').fill(taken);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Create Account' }).click();
  await expect(page.getByRole('alert')).toHaveText('There is already an account with that address. Sign in instead.');
  await expect(heading(page, 'Create Account')).toBeVisible();
});

test('a wrong password gets nowhere, and a forgotten one can be replaced', async ({ page }) => {
  const email = newAddress();
  await makeAccount(email);
  await page.goto('/');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('not-the-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText("That email and password don't match an account.");
  await expect(heading(page, 'Sign In')).toBeVisible();

  await page.getByRole('button', { name: 'Forgot Password?' }).click();
  await expect(page.getByLabel('Password')).toHaveCount(0);
  await page.getByRole('button', { name: 'Send Link' }).click();
  const answer = 'If there is an account with that address, a link for setting a new password is on its way to it.';
  await expect(page.getByRole('status')).toHaveText(answer);
  await openEmailLink(email, 'PASSWORD_RESET', 'a-brand-new-password');

  await page.getByRole('button', { name: 'Sign In Instead' }).click();
  await page.getByLabel('Password').fill('a-brand-new-password');
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(heading(page, 'Workout')).toBeVisible();
});

test('signing out takes the data off the device; signing in brings it back', async ({ page }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await logWorkout(page);
  await synced(page);
  expect(await databases(page)).toContain(`gym-tracker-${uid}`);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(1);

  // Still signed in after a reload, without asking.
  await page.reload();
  await expect(page.getByText(email)).toBeVisible();

  await signOut(page);
  await expect.poll(() => databases(page)).not.toContain(`gym-tracker-${uid}`);
  // And stays signed out.
  await page.reload();
  await expect(heading(page, 'Sign In')).toBeVisible();

  await signIn(page, email);
  await go(page, '/history');
  await expect(page.getByRole('main').getByRole('link')).toHaveCount(1);
  await expect(page.getByRole('main').getByRole('link').first()).toContainText('Bench Press (Barbell)');
});

test('signing out with changes that could not be sent asks first', async ({ page }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await synced(page);

  // The database stops answering, as with no connection.
  await page.route(/localhost:8089/, (route) => route.abort());
  await logWorkout(page);
  await go(page, '/settings');
  await page.getByRole('button', { name: 'Sign Out' }).click();
  const question = page.getByRole('alertdialog', { name: 'Sign out before everything is sent?' });
  await expect(question).toBeVisible();
  await question.getByRole('button', { name: 'Stay Signed In' }).click();

  // Nothing was lost by asking: once the connection is back, the workout goes out.
  await page.unroute(/localhost:8089/);
  await synced(page);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(1);
});

test('signing out with a workout in progress asks first, because that workout is nowhere else', async ({ page }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await page.getByRole('button', { name: 'Start Empty Workout' }).click();
  await page.getByLabel('Workout name').fill('Half done');

  await go(page, '/settings');
  await page.getByRole('button', { name: 'Sign Out' }).click();
  const question = page.getByRole('alertdialog', { name: 'Sign out with a workout in progress?' });
  await expect(question).toContainText('kept on this device only');
  await question.getByRole('button', { name: 'Stay Signed In' }).click();
  await go(page, '/workout');
  await expect(page.getByLabel('Workout name')).toHaveValue('Half done');

  await go(page, '/settings');
  await page.getByRole('button', { name: 'Sign Out' }).click();
  await question.getByRole('button', { name: 'Sign Out Anyway' }).click();
  await expect(heading(page, 'Sign In')).toBeVisible();
  await expect.poll(() => databases(page)).not.toContain(`gym-tracker-${uid}`);
});

test('a sign-out nobody asked for keeps what the device holds, and it is sent after signing in again', async ({ page }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await synced(page);

  // A workout logged with no connection — and then the login is gone, as when it
  // has run out or the password was changed on another device.
  await page.route(/localhost:8089/, (route) => route.abort());
  await logWorkout(page);
  await loseLogin(page);
  expect(await databases(page)).toContain(`gym-tracker-${uid}`);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(0);

  await page.unroute(/localhost:8089/);
  await signIn(page, email);
  await go(page, '/history');
  await expect(page.getByRole('main').getByRole('link', { name: /Bench Press/ })).toHaveCount(1);
  await synced(page);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(1);
});

test('the next person to sign in on that browser finds nothing of the one before', async ({ page }) => {
  const first = newAddress('first');
  const second = newAddress('second');
  const firstId = await makeAccount(first);
  const secondId = await makeAccount(second);
  await signIn(page, first);
  await logWorkout(page);
  await synced(page);
  await loseLogin(page); // the first one never signed out: their data is still in the browser
  expect(await databases(page)).toContain(`gym-tracker-${firstId}`);

  await signIn(page, second);
  await expect.poll(() => databases(page)).not.toContain(`gym-tracker-${firstId}`);
  expect(await databases(page)).toContain(`gym-tracker-${secondId}`);
  await go(page, '/history');
  await expect(page.getByRole('heading', { name: 'No Workouts Yet' })).toBeVisible();
});

test('an account taken off the guest list keeps what is on the device but syncs nothing more', async ({ page }) => {
  const email = newAddress();
  const uid = await makeAccount(email);
  await signIn(page, email);
  await logWorkout(page);
  await synced(page);

  await uninvite(email);
  await logWorkout(page, 'squat', 'Squat (Barbell)');
  await expect(page.getByRole('alert').filter({ hasText: 'no longer on the guest list' })).toBeVisible();
  await go(page, '/settings');
  await expect(page.getByText('This account is no longer on the guest list, so nothing is being synced.')).toBeVisible();
  await go(page, '/history');
  await expect(page.getByRole('main').getByRole('link', { name: /Bench Press|Squat/ })).toHaveCount(2);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(1);

  // Invited again, everything catches up.
  await invite(email);
  await synced(page);
  expect(await liveRecords(uid, 'workouts')).toHaveLength(2);
});

test('deleting the account removes every record, the login, and the copy on the device', async ({ page }) => {
  const email = newAddress('leaving');
  const uid = await makeAccount(email);
  await signIn(page, email);
  await logWorkout(page);
  await synced(page);
  expect((await recordsOf(uid)).length).toBeGreaterThan(190); // the exercises, the workout, the settings

  await page.getByRole('button', { name: 'Delete Account…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Delete Account' });
  await expect(sheet).toContainText('It cannot be undone');
  await expect(sheet.getByRole('button', { name: 'Delete Everything' })).toBeDisabled();

  // A wrong password deletes nothing.
  await sheet.getByLabel('Password').fill('not-the-password');
  await sheet.getByRole('button', { name: 'Delete Everything' }).click();
  await expect(sheet.getByRole('alert')).toHaveText("That email and password don't match an account.");
  expect(await liveRecords(uid, 'workouts')).toHaveLength(1);
  expect(await accountExists(email)).toBe(true);

  await sheet.getByLabel('Password').fill(PASSWORD);
  await sheet.getByRole('button', { name: 'Delete Everything' }).click();
  await expect(heading(page, 'Sign In')).toBeVisible();
  expect(await recordsOf(uid)).toEqual([]);
  expect(await accountExists(email)).toBe(false);
  await expect.poll(() => databases(page)).not.toContain(`gym-tracker-${uid}`);

  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(PASSWORD);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText("That email and password don't match an account.");
});

test('a person taken off the guest list can still delete their account', async ({ page }) => {
  const email = newAddress('removed');
  const uid = await makeAccount(email);
  await signIn(page, email);
  await logWorkout(page);
  await synced(page);
  await uninvite(email);

  await page.getByRole('button', { name: 'Delete Account…' }).click();
  const sheet = page.getByRole('dialog', { name: 'Delete Account' });
  await sheet.getByLabel('Password').fill(PASSWORD);
  await sheet.getByRole('button', { name: 'Delete Everything' }).click();
  await expect(heading(page, 'Sign In')).toBeVisible();
  expect(await recordsOf(uid)).toEqual([]);
  expect(await accountExists(email)).toBe(false);
});

test('the sign-in page says where the data is kept, before anything is handed over', async ({ page }) => {
  await page.goto('/');
  await page.getByText('Where your data is kept').click();
  const note = page.locator('.data-note');
  await expect(note).toContainText('Google Firebase database in Frankfurt, Germany');
  await expect(note).toContainText('Sam (sam@example.com) could look at them');
  await expect(note).toContainText('processes them in the United States');
  await expect(note).toContainText('are never stored in the account');
  await expect(note).toContainText('Delete Account');
});

test('the host sends the headers that confine the page', async ({ page, request }) => {
  // The page itself, under either of its two addresses, carries the policy.
  for (const address of ['/', '/index.html']) {
    const headers = (await request.get(address)).headers();
    const policy = headers['content-security-policy'];
    expect(policy, address).toContain("default-src 'self'");
    expect(policy, address).toContain("script-src 'self'");
    expect(policy, address).toContain("style-src 'self'");
    expect(policy, address).toContain("object-src 'none'");
    expect(policy, address).toContain("frame-ancestors 'none'");
    expect(policy, address).not.toContain('unsafe');
    expect(headers['x-content-type-options'], address).toBe('nosniff');
    expect(headers['x-frame-options'], address).toBe('DENY');
    expect(headers['referrer-policy'], address).toBe('no-referrer');
    expect(headers['strict-transport-security'], address).toContain('max-age=');
    expect(headers['x-robots-tag'], address).toContain('noindex');
    expect(headers['cache-control'], address).toBe('no-cache');
  }

  // And the browser acts on them: a script that isn't one of the app's own files doesn't run.
  const refused = watchPolicy(page);
  await page.goto('/');
  await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.planted = true';
    document.body.append(script);
  });
  expect(await page.evaluate(() => 'planted' in window)).toBe(false);
  expect(refused.length).toBeGreaterThan(0);

  const script = await page.locator('script[src*="/assets/"]').first().getAttribute('src');
  const asset = await request.get(script!);
  expect(asset.headers()['cache-control']).toContain('immutable');
});
