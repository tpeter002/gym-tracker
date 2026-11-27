# Gym Tracker

A workout log whose main trick is turning saved workout videos (Instagram Reels, YouTube Shorts,
TikTok) into named exercises on a "to try" list — as an iPhone app and as a web app, with one small
service behind both.

| Folder | What it is |
| :- | :- |
| [`ios/`](ios/README.md) | The iPhone app (SwiftUI, SwiftData) and its share extension. |
| [`web/`](web/README.md) | The same log in a browser (React, TypeScript). |
| [`server/`](server/README.md) | The analyzer: names the exercises in a video with a vision model, serves the web version, takes links shared from other apps, and sends finished workouts to Strava and Garmin Connect. |

The two apps are separate programs and keep separate data; each talks to the analyzer on its own.
Each folder's README covers building, running and testing that part. What is planned next, and the
ideas that are not decided yet, are in [`todo/`](todo/README.md).

## Quick start: the web version

```sh
brew install ffmpeg uv                     # once
cp server/.env.example server/.env         # once — then put an API key in it
(cd web && npm install && npm run build)   # once, and after changing the web app
uv run server/analyzer.py                  # then open http://localhost:8787
```

## Tests

```sh
uv run server/test_analyzer.py             # the analyzer
uv run server/test_connectors.py           # Strava and Garmin Connect
uv run server/test_inbox.py                # links shared from other apps
(cd web && npm test)                       # the web app's logic
(cd web && npm run test:e2e)               # the built web app in two browsers
```

The browser tests need Playwright's browsers once: `npx playwright install chromium webkit` in `web/`
(more in [`web/README.md`](web/README.md#tests)). The iPhone app's tests run in Xcode or the simulator;
see [`ios/README.md`](ios/README.md#tests).

## License

[Apache-2.0](LICENSE).
