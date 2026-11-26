# Gym Tracker

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

There is also a **web version** with the same features in [`web/`](web/README.md). It is a separate
program with its own data; the two share only the video analyzer below.

## Build and install

Requires Xcode and [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`).

```sh
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

## Video analyzer

`server/analyzer.py` downloads a clip with yt-dlp, samples frames with ffmpeg and asks a vision model
— Claude unless you choose another — which exercises are in it. It runs on your Mac; the phone reaches
it over Wi-Fi.

```sh
brew install ffmpeg uv                               # once
echo 'ANTHROPIC_API_KEY=sk-ant-...' > server/.env    # once
uv run server/analyzer.py
```

It prints the address to enter in the app under Settings → Video analyzer
(`http://<your-mac>.local:8787`, plus the Mac's IP address in case the phone can't resolve the name).
If the web version has been built (`web/dist`), the same address also serves it.

A video is analyzed as soon as it's saved, and what it finds goes straight onto the to-try list.
Videos saved while the Mac was out of reach are analyzed the next time you open the app on the same
Wi-Fi. **Identify Again** on a video re-runs it and only offers suggestions, so exercises you removed
stay removed.

- Instagram usually refuses anonymous downloads. Start the analyzer with
  `YTDLP_COOKIES_FROM_BROWSER=safari` (or `chrome`) to use the login from that browser.
- `uv run server/analyzer.py --check <url>` tests just the download and frame steps, no AI call.
- Each analysis sends up to 24 frames to the model. With Claude Opus 5.5 that is, by a rough
  estimate, 5–10 cents per video; the free models below cost nothing but have daily limits.
- The service has no authentication, so only run it on a network you trust.

### Choosing the model

The analyzer can ask Claude, [Z.ai](https://z.ai)'s GLM models, any image-reading model on
[OpenRouter](https://openrouter.ai), or Google's Gemini. Put the key of the service you want in
`server/.env`:

```sh
ANTHROPIC_API_KEY=sk-ant-...    # Claude; claude-opus-5-5 unless ANALYZER_MODEL says otherwise
ZAI_API_KEY=...                 # Z.ai; glm-4.6v-flash (free) by default
OPENROUTER_API_KEY=sk-or-...    # OpenRouter; openrouter/free by default, which picks a free model
GEMINI_API_KEY=AIza...          # Google AI Studio; gemini-3.8-flash by default, which has a free tier

ANALYZER_PROVIDER=zai           # anthropic, zai, openrouter or gemini — only needed with more than one key
ANALYZER_MODEL=glm-5.3-flash    # optional: another model of that service
```

With one key, that service is used; with several and no `ANALYZER_PROVIDER`, the first of them in the
order above is. The line the analyzer prints at start-up says which model it will ask.

What costs nothing, as of November 2026:

- **Gemini** — the Flash models have a free daily allowance (your project's limits are shown in Google AI
  Studio). Google uses free-tier requests to improve its products, and its terms allow only the paid tier
  for apps offered to users in the EEA, Switzerland and the UK.
- **OpenRouter** — models whose name ends in `:free`, and `openrouter/free`; 50 requests a day, 1,000 once
  the account has ever bought $10 of credit.
- **Z.ai** — `glm-4.6v-flash` is listed as free, but on the day this was written it answered every request
  with "temporarily overloaded". The analyzer retries a few times and then says so.

The web version can also choose for itself, per browser: Settings → Video model sets the service and the
model, and optionally a key of your own that is sent along with each video instead of the analyzer's.
The iPhone app has no such setting and uses whatever the analyzer is set to. A saved video shows which
model identified it.

Z.ai, OpenRouter and Gemini are covered by tests against their documented request and answer formats,
and were run against the real services as far as a made-up key gets (they refuse it, and the app says
so). No real analysis has come back from any of them yet, so how well a given model names exercises is
something to try on your own videos — **Identify Again** makes that a one-tap comparison.

## Tests

- **Analyzer tests**: `uv run server/test_analyzer.py` — model choice, the requests sent to Claude, Z.ai
  and OpenRouter, reading their answers and errors. They call no outside service.
- **Web version**: see [`web/README.md`](web/README.md#tests).
- **Unit tests** (`GymTracker` scheme, ⌘U): the Strong CSV parser, and the logging / import paths
  against a real in-memory database.
- **UI tests** (`GymTrackerUITests` scheme): walk the main flows in the simulator — log, finish and
  repeat a workout, custom exercises, to-try list, body weight, settings, and sharing a link from Safari
  through the share extension.

```sh
SIM='platform=iOS Simulator,name=iPhone 17,OS=latest'
xcodebuild -project GymTracker.xcodeproj -scheme GymTracker -destination "$SIM" test
xcodebuild -project GymTracker.xcodeproj -scheme GymTrackerUITests -destination "$SIM" test
```

Two UI tests need something from outside and are skipped unless you name it (`TEST_RUNNER_…` variables
are passed through to the tests):

- `TEST_RUNNER_ANALYZER_URL=http://localhost:8787` — saves a clip and waits for its exercises to land on
  the to-try list. `TEST_RUNNER_ANALYZER_VIDEO=<link>` picks the clip; use a real workout short.
  To test the app's side without spending anything, point it at `python3 server/stub_analyzer.py 8799`,
  which answers with two canned exercises.
- `TEST_RUNNER_STRONG_CSV=<file name>` — imports that CSV through the document picker. The file has to
  be in the simulator's Files app under "On My iPhone".

`TEST_RUNNER_SHOTS_DIR=<folder>` also writes the screenshots the tests take to that folder.

The app understands two launch arguments in debug builds: `-seedDemoData` (sample history) and
`-uiTesting` (throwaway database and default settings).
