# Gym Tracker — the version with accounts

The [web version](../web/README.md) for a handful of people: each signs in, and their workouts follow
them to every device they use. It runs on Firebase's free plan — Hosting for the site, Authentication
for the logins, Firestore for the data — which asks for no payment method, so it cannot start costing
money by itself.

Without the settings described here the web app is what it has always been: no login, everything in one
browser. Nothing in this folder changes that.

- `firebase.json` — what is served and with which headers, where the rules are, the emulators' ports.
- `firestore.rules` — who may read and write what. The whole of the protection; read it.
- `firestore.indexes.json` — tells Firestore not to index the records' content.
- `tests/rules.test.js` — the rules, tried against the emulator.
- `scripts/e2e.mjs` — runs the browser tests in `../web/tests/cloud` against the emulators.

**It has never been deployed.** Everything below was built and tested against Firebase's emulators on
one computer. The steps under [Setting it up](#setting-it-up) are from Firebase's documentation, not
from having done them; [the first deployment](#the-first-deployment) lists what to look at.

## How it works

- **The device stays the working copy.** The app reads and writes its own database in the browser, as
  before, so it opens and logs without a connection. Whenever it can, it brings that database and the
  account together (`web/src/lib/cloud/sync.ts` explains how, and what happens when two devices changed
  the same thing: whichever syncs last has the last word on that record).
- **One document per record.** `users/<account id>/records/<kind>_<id>` holds a workout, an exercise, a
  weigh-in, a saved video, the settings, or the version of the built-in exercise list. The record itself
  is one text field, `p`, which Firestore never looks into.
- **A workout in progress stays on its device** until it is finished.
- **Three settings never go to the account, and are never taken from it:** the API keys for the video
  models, the share inbox's code, and the analyzer's address. A key is sent to the analyzer at that
  address, so the address is only ever one that was typed on the device itself.
- **Signing out under Settings removes the account's data from the device;** signing in again fetches
  it. It asks first when something would be lost: a workout in progress, or changes it could not send.
  A login that ends without being asked to — it ran out, the password was changed elsewhere — leaves
  the data where it is, and it is sent when the same person signs in again. If someone else signs in
  on that browser instead, it is deleted.
- **By invitation.** Anyone can create a login, but a login can store nothing until its address is
  confirmed through the emailed link *and* is on the guest list (`allowed/<address>`), which only the
  owner can edit, in the Firebase console.

## What protects the data

| | |
| :- | :- |
| On the way | https only; the host adds HSTS. |
| In the database | Firestore encrypts what it stores. `firestore.rules` lets a signed-in, confirmed, invited person write their own records, and a signed-in, confirmed person read and delete their own; there is no rule for anything else, so everything else is refused. |
| In the page | A content security policy (in `firebase.json`) allows scripts and styles from the site itself only — no inline script, no frames — so a planted script has nowhere to run from. |
| On the device | The browser's own storage, unencrypted like any site's; deleted on sign-out (if that is cut short, at the next start). |
| Against a stuck request | Every request to Firebase is given up on after a minute or two, so a dead connection cannot keep syncing — or signing out — waiting for good. |
| Secrets | There are none in the code or the site. The values in `.env.cloud.local` identify the project and reach every visitor's browser by design. No server of ours holds a key. |

What that leaves:

- **The owner's Google account is the master key.** Whoever can sign in to the Firebase console can
  read, change and delete everything. Give that account a strong password and two-step verification.
- **The owner can read everyone's records** — in the console, under Firestore → `users`. The app itself
  shows nobody anyone else's data and has no "admin" mode. Records are stored as readable text for now;
  the format field `v` and the opaque `p` are there so that encrypting them on the device can be added
  without changing the rules, after which the console would show only ciphertext.
- **Anyone can create a login.** They can store nothing with it, but with a confirmed address each
  request they make counts against the day's free reads, and sign-up can be used to send confirmation
  emails to people who didn't ask. Once everyone is in, switch sign-up off in the console:
  Authentication → Settings → User actions.
- **An invited address that has no account yet can be taken by someone else** who knows it, if its
  owner then opens the confirmation link they didn't ask for. Add an address to the guest list when its
  owner is about to register, not weeks before. If an invited person is told "there is already an
  account with that address", delete that user under Authentication rather than have them reset the
  password.
- **One invited person can use up what everyone shares:** the day's reads and writes, or — with records
  of up to 200,000 characters each — the gigabyte of storage. Nothing stops that but knowing the people.
- **Whoever can write into a person's account** (the owner, or someone who got that person's password)
  can change their records and settings. What they cannot do through it is point the app at another
  analyzer, which is why that address stays on each device.
- **The analyzer still has no login.** It keeps running on a computer of your own and is reached at an
  https address you enter in Settings; anyone who knows that address can use it
  ([server/README.md](../server/README.md)). Everything except identifying videos, the share inbox, and
  sending to Strava and Garmin works without it.
- **A deleted account and the person's other devices.** Delete Account removes every record and the
  login, and the copy on the device it was done from. Another device that happens to be open keeps its
  login for up to an hour and could still write in that time; such records would stay until removed in
  the console. And every other device keeps its own copy in the browser until someone signs in there.

## Data protection

Not legal advice — what the setup is, so that you can decide.

- **You are the one responsible** for the other people's data; Google stores it on your behalf under
  Firebase's Data Processing and Security Terms.
- **Where it is:** the records are in the Firestore location you pick when creating the database — it
  cannot be changed afterwards, so pick one in the EU if that matters. Firebase Authentication processes
  logins (email address, password hash, IP address) in the United States whatever you pick.
- **What people are told:** the sign-in page and Settings carry a note, "Where your data is kept". Fill in
  `VITE_OPERATOR` (who you are and how to reach you) and `VITE_DATA_REGION` so that it is complete.
- **Getting it out, getting it deleted:** Settings → Download Backup is everything in one file. Settings →
  Delete Account removes every record and the login — also for someone you have already taken off the
  guest list. Their address stays in `allowed` until you remove it. For someone who can no longer sign
  in, you delete `users/<their id>` in Firestore and the user under Authentication.
- **Workouts and body weight are about a person's body.** Treat them as you would want yours treated:
  don't look without a reason, and tell people if something went wrong.
- Whether a few friends sharing a tracker falls under the GDPR at all (it exempts purely personal
  activity) is a legal question this file can't answer.

## Setting it up

Once, by the owner. Needs a Google account, Node 22.12 or newer and — for the tests only — Java.

1. **Create the project** at <https://console.firebase.google.com> on the free Spark plan. Google
   Analytics is not needed; leave it off.
2. **Firestore:** Build → Firestore Database → Create database. Choose the **location** with care (see
   above) and start in **production mode**.
3. **Authentication:** Build → Authentication → Sign-in method → enable **Email/Password** (not the
   passwordless "email link").
4. **The web app's settings:** Project settings → Your apps → add a Web app. Copy `../web/.env.cloud.example`
   to `../web/.env.cloud.local` and fill in the four values it shows, plus who you are and where the
   database is. Git ignores that file.
5. **Sign in and choose the project:**

   ```sh
   cd cloud
   npm install
   npx firebase login
   npx firebase use --add      # pick the project; writes .firebaserc, which git ignores
   ```

6. **Deploy:** `npm run deploy` builds the app with accounts into `../web/dist-cloud` and uploads the
   rules, the index settings and the site. It prints the address: `https://<project id>.web.app`.
7. **Invite yourself:** in the console, Firestore → Start collection `allowed` → a document whose ID is
   your email address **in lower case**. Its fields don't matter.
8. Open the site, create your account, open the link in the email, sign in. Settings → Restore Backup
   brings in a backup made by the version you have been using.

Worth doing afterwards:

- Give people one address. The site answers at both `<project id>.web.app` and
  `<project id>.firebaseapp.com`, and a browser keeps what it stores for the two apart.
- Once everyone has an account, switch sign-up off (Authentication → Settings → User actions).
- In the Google Cloud console, restrict the project's browser API key to your site's addresses and to
  the Identity Toolkit, Token Service and Cloud Firestore APIs. Try signing in afterwards: a
  restriction that shuts out one of those ends everyone's login at their next start. (Their data stays
  on their devices and is sent once they can sign in again.)

### The first deployment

None of this could be tried against the emulators:

- Does the confirmation email arrive, and does its link open a page that works? (Firebase sends it from
  its own address and serves that page itself, under the site's address; the wording is under
  Authentication → Templates. The content security policy is set on the app's own page only, so that
  it cannot get in that page's way — the other headers apply to everything.)
- Does a new account's first sync go through? It writes some two hundred records in one request, each
  checked against the guest list. The emulator accepts that; if Firestore counts those checks per
  record rather than once per request, it refuses, and the app says "not on the guest list". The
  remedy then is a smaller `CHUNK_DOCS` in `web/src/lib/cloud/sync.ts`.
- Does the page load with nothing refused by the content security policy? The browser's console says.
- On an iPhone: add the site to the Home Screen, sign in, close and reopen it — still signed in? Log a
  workout with the phone in flight mode, then go online — does it arrive on another device?
- `npm run deploy` itself, and whether Firestore accepts `firestore.indexes.json` as written.

## Day to day

- **Invite someone:** add `allowed/<their address, lower case>`. They create an account on the site and
  confirm the address.
- **Take someone out:** delete their document from `allowed`. Their next request is refused; their app
  keeps what is on their device and says it is no longer syncing. Their records stay until you delete them.
- **After changing the app or the rules:** `npm test`, then `npm run deploy`. People get the new app
  the next time they open it with a connection. A change to the headers alone reaches a browser that
  already has the app only together with a change to the app's files.

## The free plan's limits

As read from Firebase's pricing page in November 2026; they are Google's to change.

| | Allowance | What uses it |
| :- | :- | :- |
| Firestore writes | 20,000 a day | About 200 once for a new account (the built-in exercises), then one or two per finished workout or change. |
| Firestore reads | 50,000 a day | Opening the app reads what changed since last time — a document or two on a quiet day. What a device has just written it reads back once, and once more half a minute later, so a restored backup of a thousand records costs two or three thousand reads that day. A new device reads everything once. |
| Firestore storage | 1 GiB | A workout is one or two kilobytes; a saved video with its thumbnail, tens. |
| Hosting transfer | 360 MB a day | The app is about 200 kB compressed and is kept by the browser after the first visit. |
| Authentication | 50,000 people a month | — |

When an allowance runs out, Firestore refuses requests until the next day (Pacific time); the app says
so and keeps working from the device — except on a device signing in for the first time, which has
nothing to work from yet. Cloud Functions are not part of the free plan, which is why nothing here
runs on a server.

## Tests

```sh
cd cloud
npm install
npm test             # the rules, against the Firestore emulator
npm run test:e2e     # the app in two browsers, against the Auth, Firestore and Hosting emulators
```

Both need Java for the emulators (17 works today; the next major version of the Firebase tools will
want 21). `npm run test:e2e` also needs `npm install` and Playwright's browsers in `../web`. It builds
the app for a made-up project (`../web/.env.emulators`) into `../web/dist-emulators` and serves it
through the Hosting emulator, so the tests run under the same headers as the real site.

- The rules tests cover who gets in (a login, a confirmed address, an invitation), that nobody reaches
  another person's records, the guest list, and what a record must look like.
- The browser tests cover signing up, confirming, the guest list, a forgotten password, two devices of
  one account, two accounts side by side, working without a connection (with the service worker, in
  Chromium), restoring a backup, removals that are held back, a login lost without asking, signing
  out and deleting the account.
- How syncing decides what to send and take is tested without any Firebase at all, in
  `../web/tests/unit/cloud.test.ts`.

Not covered by any test: giving up on a request that never answers (it would take the test a minute
to find out), and anything only the real service does — sending email, the daily allowances.

A freshly started Firestore emulator takes several seconds over its first large writes, so the browser
tests are given generous time and one retry; a test that needed its retry is listed as flaky.
