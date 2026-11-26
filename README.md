# Gym Tracker

A workout log whose main trick is turning saved workout videos (Instagram Reels, YouTube Shorts,
TikTok) into named exercises on a "to try" list — as an iPhone app and as a web app, with one small
service behind both.

| Folder | What it is |
| :- | :- |
| [`ios/`](ios/README.md) | The iPhone app (SwiftUI, SwiftData) and its share extension. |
| [`web/`](web/README.md) | The same log in a browser (React, TypeScript). |
| [`server/`](server/README.md) | The analyzer: names the exercises in a video with a vision model, serves the web version, and sends finished workouts to Strava and Garmin Connect. |

The two apps are separate programs and keep separate data; each talks to the analyzer on its own.
Each folder's README covers building, running and testing that part.

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
(cd web && npm test && npm run test:e2e)   # the web app: logic, then the built app in two browsers
```

The iPhone app's tests run in Xcode or the simulator; see [`ios/README.md`](ios/README.md#tests).
