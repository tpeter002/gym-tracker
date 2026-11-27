# What's next

Three things are agreed, in this order; the second is built and waits to be deployed. Ideas that are not decided yet are in [ideas.md](ideas.md);
what the code review turned up and was deliberately left alone is in
[review-leftovers.md](review-leftovers.md).

## 1. Log the music played during a workout

**Goal:** a finished workout shows what was playing while it was done.

**What is known**

- A web page cannot see what another app is playing; there is nothing to "just ask".
- [Last.fm](https://www.last.fm/api/show/user.getRecentTracks) can serve as the common record:
  `user.getRecentTracks` takes a `from` and a `to`, so a workout's tracks can be fetched afterwards,
  and its API answers calls made straight from a web page (checked: it allows any origin). It needs
  one free API key and each person's Last.fm user name.
- Getting plays *into* Last.fm depends on the music app:
  - **Spotify** connects to Last.fm in its own settings.
  - **Apple Music** on an iPhone needs a separate scrobbler app. The App Store lists several
    (QuietScrob, Scrobbly, FastScrobbler); none has been tried.
  - **SoundCloud** on a phone: no route found.
- Spotify's own API would need a Premium account for whoever registers the app (since February 2026).
  Apple's API for listening history is, as far as known, tied to the paid developer programme — unverified.

**First step:** try one scrobbler on an iPhone with Apple Music for a week: do the plays reach
Last.fm, and how late? Everything else depends on that.

**Then:** Settings → Music (Last.fm user name, API key); fetch the tracks between a workout's start
and end when it is finished or next opened; keep them on the workout; show them on its page.

## 2. Host it for a handful of people, free

**Goal:** 1–10 people, a login or two a day each, their data on every device they use — and nobody
pays anything, the owner included. Each person brings their own model key.

**Built** (see [cloud/README.md](../cloud/README.md)): sign-in with email and password, by invitation;
a per-account database in the browser kept in step with Firestore; database rules that let a person
reach only their own records; the host's security headers; export and account deletion; a note in the
app on where the data is kept. Tested against Firebase's emulators — rules, syncing, and the app in two
browsers.

**Not done: the deployment itself.** It needs a Firebase project, which only the owner can create
(cloud/README.md → Setting it up, eight steps), and then the checks listed there under "The first
deployment": the confirmation email, the page under the real headers, an iPhone Home Screen app that
stays signed in and syncs after being offline.

**What is still missing after that**

- **The analyzer per person.** It stays on a home machine — video sites turn away downloads from cloud
  servers (found earlier; worth re-checking) — reached over an https tunnel (`ALLOWED_HOSTS` and
  `ALLOWED_ORIGINS` exist for that). It has no login: it would have to learn who is asking, and keep
  Strava and Garmin connections per person instead of one set for the whole service.
- **The share inbox in the cloud,** so sharing a video works when the home machine is off. Without
  Cloud Functions (not on the free plan) a Shortcut would post straight to Firestore, into an inbox
  whose code a signed-in app registered; the rules for that are not written.
- **Sign in with Google.** Left out on purpose: its pop-up and redirect are fragile in an iPhone Home
  Screen app, and need frames the content security policy now forbids.
- **Encrypting records on the device,** so that the database's console shows only ciphertext. The
  record format has room for it (cloud/README.md → What protects the data); it costs a passphrase
  that, once forgotten, nobody can recover.
- **Friends' ranks side by side** — the idea that needed accounts. It also needs a rule that lets a
  person share a few numbers with named others, and nothing more.
- **Known gaps in syncing,** from an independent review of it (the rest of what it found is fixed):
  - What a device takes over from the cloud and its note of having done so are saved in two steps. A
    crash exactly between them, followed by another device changing the same record again, lets the
    older version overwrite the newer one.
  - The settings are one record, so the device that syncs last wins all of them; and an app update
    that adds a setting makes each device send its settings once, over whatever is there.
  - A record the server refuses blocks the request it travels in, and every later one. The app then
    says "no longer on the guest list", whatever the reason was.
  - Nothing notices records removed from the database by hand, and there is no "send everything
    again" button.
  - Restoring the wrong backup replaces the account on every device at one tap; no copy of what was
    there is kept.
  - Giving up on a request that never answers is not covered by a test. While the emulator tests were
    being written, a sync stalled twice in some eight hundred test runs with nothing visibly wrong;
    the time limit on requests was added after that and it has not been seen since, but what caused
    it was never pinned down.
- **Smaller things:** deleted records leave a marker (no content) in the database for good; a second
  device that is open when the account is deleted can still write for up to an hour; two tabs of one
  account are kept from syncing at once, but a browser without Web Locks is not; the ten-character
  minimum for passwords is checked by the app only; creating an account tells whether an address
  already has one; there is no "this is a shared computer" way to sign in; Google allows only its
  paid Gemini tier for apps offered to people in the EEA, Switzerland and the UK, which matters once
  other people use an analyzer with the owner's key.

## 3. Redesign to Apple's Human Interface Guidelines

**Goal:** the web app looks and behaves the way an iPhone app is expected to, by the guidelines
rather than by eye. (Decide first whether the native app in `ios/` is in scope too; it already uses
the system's own components.)

**What the review already flagged**

- Type is sized in pixels, so the phone's text-size setting (Dynamic Type) is ignored.
- Contrast: accent text on the tinted buttons is 4.04:1 and the search placeholder 3.73:1 in light
  mode, both under the 4.5:1 the stylesheet promises. Dark mode was not looked at.
- The manifest's theme colour and the page's differ; the background colour is light only.
- Landscape: the left and right safe areas are not handled.
- Menu items have no pressed state on touch; a confirmation dialog focuses itself rather than its
  least destructive button; the rank ladder's labels are 9.5px because seven don't fit otherwise.
- An app left open on the Home Screen keeps running the old build after an update: there is no
  "new version — reload".

**Approach:** an audit against the guidelines screen by screen, a design pass before any code, then
the change. The before/after screenshot comparison used in the review (every page, phone and desktop,
old build against new) is the way to see what moved.

## Decisions that are waiting

- **Git history:** two test files once held a real shared link (replaced since). Removing it from
  history means rewriting it and force-pushing.
- **Bundle identifiers** in `ios/` carry the owner's name (`com.torokpeter.…`). Renaming makes the
  phone see a different app, so its data does not carry over.
- **CI and a linter:** there is no GitHub Actions workflow and no ESLint/Prettier or Ruff. Both
  would have caught things the review found by hand.
- **Python dependencies** are unpinned (the web side has a lock file): `uv lock --script` would fix
  the versions the service runs with.
- **The iPhone app** lacks ten things the web version has (ranks, routines, the rest timer and
  editing a finished workout among them). Keep it in step, or freeze it?
