# Gym Tracker — iPhone app

A small iPhone workout log whose main trick is turning saved workout videos
(Instagram Reels, YouTube Shorts, TikTok) into named exercises on a "to try" list.

- **Workout** — start an empty workout or repeat a past one; log sets with weight, reps and RPE/RIR.
  Each row shows what you did last time; ticking an empty row takes those numbers over.
- **History** — every finished workout; open one and tap **Repeat Workout**.
- **Exercises** — ~200 built-in exercises, searchable, plus your own.
- **Body** — body-weight log with a trend chart.
- **Saved videos** — share a clip to Gym Tracker from any app; the analyzer names its exercises and
  puts them on a "to try" list that leads the exercise picker until you've done them.
- **Import from Strong** — Settings → Import from Strong reads a Strong CSV export (both layouts).

The [web version](../web/README.md) is a separate program with its own data. Both use the
[analyzer](../server/README.md) to name the exercises in a video.

## Build and install

Requires Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
cd ios
xcodegen generate        # creates GymTracker.xcodeproj from project.yml
open GymTracker.xcodeproj
```

In Xcode, once:

1. Settings → Accounts → add your Apple ID.
2. For **both** targets (`GymTracker` and `ShareExtension`) → Signing & Capabilities → pick your
   Personal Team. Re-pick it after re-running `xcodegen generate`, or put the team ID in
   `DEVELOPMENT_TEAM` in `project.yml`.
3. Plug in the iPhone, select it as the run destination, press Run. The first time, trust the
   developer on the phone under Settings → General → VPN & Device Management.

With a free Apple ID the installed app stops launching after 7 days — press Run again to renew it.
Your data stays on the phone as long as you don't delete the app.

To see the app with sample data in the simulator, add `-seedDemoData` to the scheme's launch arguments.

## Saving videos

In Instagram / TikTok / YouTube: Share → (More) → **Gym Tracker**. The first time you may need to
enable it under "Edit Actions…" at the end of the share sheet's app row. You can also paste a link
under Workout → Saved Videos → +, or open `gymtracker://add?url=<link>` from a Shortcut.

Without the analyzer the link is still saved and you can name the exercises yourself
(Saved Video → Add Exercise Manually).

The link is picked up the next time you open Gym Tracker — the share sheet only drops it in an inbox.

## Tests

- **Unit tests** (`GymTracker` scheme, ⌘U): the Strong CSV parser, and the logging / import paths
  against a real in-memory database.
- **UI tests** (`GymTrackerUITests` scheme): walk the main flows in the simulator — log, finish and
  repeat a workout, custom exercises, to-try list, body weight, settings, and sharing a link from Safari
  through the share extension.

```sh
cd ios
SIM='platform=iOS Simulator,name=iPhone 17,OS=latest'
xcodebuild -project GymTracker.xcodeproj -scheme GymTracker -destination "$SIM" test
xcodebuild -project GymTracker.xcodeproj -scheme GymTrackerUITests -destination "$SIM" test
```

Two UI tests need something from outside and are skipped unless you name it (`TEST_RUNNER_…` variables
are passed through to the tests):

- `TEST_RUNNER_ANALYZER_URL=http://localhost:8787` — saves a clip and waits for its exercises to land on
  the to-try list. `TEST_RUNNER_ANALYZER_VIDEO=<link>` picks the clip; use a real workout short.
  To test the app's side without spending anything, point it at `python3 ../server/stub_analyzer.py 8799`,
  which answers with two canned exercises.
- `TEST_RUNNER_STRONG_CSV=<file name>` — imports that CSV through the document picker. The file has to
  be in the simulator's Files app under "On My iPhone".

`TEST_RUNNER_SHOTS_DIR=<folder>` also writes the screenshots the tests take to that folder.

The app understands two launch arguments in debug builds: `-seedDemoData` (sample history) and
`-uiTesting` (throwaway database and default settings).
