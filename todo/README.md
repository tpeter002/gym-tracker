# What's next

Three things are agreed, in this order. Ideas that are not decided yet are in [ideas.md](ideas.md);
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

**Proposal:** Firebase's free plan (no payment method needed): Hosting for the site (https, so it
opens at the gym without a connection), Authentication (Google sign-in), Firestore for the data.
Supabase's free plan pauses a project after a week without activity, which rules it out here.

**What has to change**

- Sign-in, and a sync layer under `web/src/lib/store.ts`: IndexedDB stays as the copy that works
  offline; Firestore gets one document per workout, exercise, video and weigh-in, as `db.ts` already
  stores them.
- The share inbox moves from the analyzer to the cloud, so sharing a video works when the Mac is off.
- The analyzer stays on a home machine — video sites turn away downloads from cloud servers (found
  earlier; worth re-checking) — and is reached over an https tunnel (`ALLOWED_HOSTS` and
  `ALLOWED_ORIGINS` exist for that). It has no login today: it would have to learn who is asking,
  and keep Strava and Garmin connections per person instead of one set for the whole service.

**Before building:** read the limits on Firebase's own pricing page (a search summary said 50,000
reads and 20,000 writes a day; one page mentioned a change from September 2026 that could not be
attributed), and note that Google allows only its paid Gemini tier for apps offered to people in
the EEA, Switzerland and the UK.

**Needed from the owner:** a Firebase project.

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
- **The iPhone app** lacks seven things the web version has. Keep it in step, or freeze it?
