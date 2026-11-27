# Left from the code review

In November 2026 six reviewers read the repository — the service, the web app's logic, its
interface, its tests, the iPhone app, and the repository as a whole — and returned about 117
findings. Most were fixed. These were looked at and deliberately left, because they change how
something behaves, need a decision, or cost more than they are worth right now.

## iPhone app

- An exercise can belong to one saved video only; a second video with the same exercise takes it
  over. Many-to-many would be a model change. Related: an exercise you already do weekly is still
  marked "to try" when a video shows it (the web app does the same).
- `Exercise.isCustom` is stored and never read: use it (a badge, a filter) or remove it.
- There is no migration plan (`VersionedSchema`), and a store that fails to open is a `fatalError`.
  The next change to a model that isn't purely additive would crash at launch on the phone that
  holds the real history. **Do this before changing any model.**
- Swift 5 mode without strict-concurrency checks; the review expects warnings in the share
  extension and the link preview.
- "Test Connection" says only "Not reachable", whatever the reason was.
- A link's query is cut down to three known parameters (`v`, `list`, `t`); a site that identifies
  its video with another one would be saved broken. The web app does the same.
- History's swipe-to-delete and the active workout's discard save at once, while every other delete
  waits for the screen to settle; whether that can crash is unknown, and neither has a UI test of
  the swipe.
- Pasting a link reads the pasteboard directly (which asks permission); two deletes have no
  confirmation; some image work happens on the main thread.

## Service

- Dependencies are unpinned; the environments on this machine already differ between the service
  and its tests.
- A Strava sign-in that fails on the way back shows raw JSON in the browser instead of returning to
  the app.
- A Garmin upload that is "still processing" never gets its title and description. The library also
  offers `import_activity`, said not to be re-exported to Strava — it might remove the
  double-posting caveat. Nothing has been posted to a real account yet.
- A video link that starts on the internet and redirects into the local network is not caught.

## Web app

- The same small guards ("is it an object", "is it one of this list") are written in four modules.
- Things that travel in a backup although they belong to one device: the analyzer's address and
  the "send automatically" switches.
- A Strong export's timed sets (planks) are imported with their seconds as reps, and count in
  volume and "most reps". Imported sessions don't clear "to try".
- Saving a video's exercise overwrites a link the exercise already had.
- The fallback page for a crashed app offers Reload and Download Backup, but a damaged record makes
  it come straight back, and the backup containing that record would be refused on restore: the
  data gets out, but there is no repair.
- The Garmin sign-in form no longer remembers the e-mail after a disconnect in the same visit.
- Messages assume the single-owner setup ("Start it on your Mac"), and everything is called "the
  analyzer" although the service also holds the inbox and the connections.

## Tests and tooling

- The browser tests still repeat set-up that belongs in `helpers.ts` (starting, logging and
  finishing a workout; opening an exercise), and `app.spec.ts` covers ten unrelated subjects.
- Unit tests rebuild the same stand-in for `fetch` and the same seeded state in several files.
- Waits in the rank tests are real time (about ten seconds per browser); Playwright's clock control
  would remove them.
- One TypeScript configuration serves both browser code and Node code; `noUncheckedIndexedAccess`
  is off (190 places would need attention).
- `db.ts` is tested only through the browser; a fake IndexedDB would let it be unit-tested.
