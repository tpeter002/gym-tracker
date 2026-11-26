# Gym Tracker — analyzer

The one service behind both apps. It names the exercises in a saved workout video, serves the built
[web version](../web/README.md), and sends finished workouts to Strava and Garmin Connect. It runs on
your own computer; the phone reaches it over Wi-Fi.

- `analyzer.py` — the service itself: download, frames, the vision model.
- `connectors.py` — Strava and Garmin Connect.
- `stub_analyzer.py` — a stand-in with a canned answer, for testing the apps without a model.
- `.env.example` — the settings, to copy to `.env`.

The commands below are run from the repository's root.

## Video analyzer

`server/analyzer.py` downloads a clip with yt-dlp, samples frames with ffmpeg and asks a vision model
— Claude unless you choose another — which exercises are in it. It runs on your Mac; the phone reaches
it over Wi-Fi.

```sh
brew install ffmpeg uv                    # once
cp server/.env.example server/.env        # once — then put an API key in it (see "Choosing the model")
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
`server/.env` (git ignores that file; `server/.env.example` is the template):

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

- **Gemini** — on the free tier each Flash model allows 5 requests a minute and 20 a day, each Flash-Lite
  model 15 and 500 (as Google AI Studio showed for a new project on 26 November 2026; yours are under
  "Rate limit" there). Requests answered with "high demand" count too, and the models take turns being
  in high demand, so the analyzer asks each Flash model at most once per video, in order, until one
  answers; the video shows which one did. Google uses free-tier requests to improve its products, and
  its terms allow only the paid tier for apps offered to users in the EEA, Switzerland and the UK.
- **OpenRouter** — models whose name ends in `:free`, and `openrouter/free`; 50 requests a day, 1,000 once
  the account has ever bought $10 of credit.
- **Z.ai** — `glm-4.6v-flash` is listed as free, but on the day this was written it answered every request
  with "temporarily overloaded". The analyzer asks once more after a few seconds and then says so.

The web version can also choose for itself, per browser: Settings → Video model sets the service and the
model, and optionally a key of your own that is sent along with each video instead of the analyzer's.
The iPhone app has no such setting and uses whatever the analyzer is set to. A saved video shows which
model identified it.

Gemini has been run for real on its free tier (26 November 2026): a one-exercise Instagram reel and a
five-exercise YouTube video were both identified, in 40 seconds to 3½ minutes depending on which model
had capacity. The Flash-Lite models named the reel's exercise wrongly, so they are offered but never
used as a fallback. Z.ai and OpenRouter are covered by tests against their documented request and
answer formats and were run as far as a made-up key gets (they refuse it, and the app says so); Z.ai's
free model has not returned an analysis yet. How well a given model names exercises is something to try
on your own videos — **Identify Again** makes that a one-tap comparison.

## Sending workouts to Strava and Garmin Connect

The web version can send a workout to Strava and Garmin Connect when you finish it. The analyzer holds
the connections and does the sending (`server/connectors.py`); the app queues the workout and shows what
came of it. Set it up under Settings → Strava / Garmin Connect, then switch on "Send finished workouts
automatically" for the services you want.

- A workout finished while the analyzer is out of reach waits and goes out the next time the app is
  opened within reach of it. Each workout is sent to each service once, however often that is retried.
- Only workouts you finish in the app are sent by themselves. Imported or restored ones never are; any
  workout can be sent by hand from its page under History.
- If your Garmin account already forwards activities to Strava, switch automatic sending on for Garmin
  only, or the workout will appear on Strava twice.

**Strava** uses its official API. Strava's API has no fields for exercises, sets or reps, so the workout
becomes a Weight Training activity with everything written into the description:

```
Bench Press (Barbell)
Warm-up: 40 kg × 10
Set 1: 87.5 kg × 8 @ RPE 7.5
Set 2: 87.5 kg × 7

Logged by my own app automatically
```

You need an API application of your own (Strava requires a subscription to create one):

1. At <https://www.strava.com/settings/api> create an application and set its "Authorization Callback
   Domain" to `localhost`.
2. Put its id and secret into `server/.env` as `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET`, and
   restart the analyzer.
3. On the computer the analyzer runs on, open the app at `http://localhost:8787`, go to Settings →
   Strava → **Connect Strava**, and approve. A new application accepts only your own Strava account
   until you raise its athlete limit in Strava's dashboard.

**Garmin Connect** has no official way for a personal project to add an activity: its developer
programme is for approved businesses, and the personal API only reads. What this uses is the upload the
Garmin Connect website itself has, reached with your own login through the unofficial
[`garminconnect`](https://github.com/cyberjunky/python-garminconnect) library. That is outside what
Garmin supports: it can stop working when Garmin changes its sign-in, and using it is your call. Your
password goes to the analyzer once, is exchanged for tokens (`server/garmin-tokens/`, ignored by git)
and is not stored. The workout is uploaded as a FIT file — a strength activity with one record per set
(exercise, reps, weight). The app doesn't record when each set was done, so the sets are spread evenly
over the workout's duration.

The tokens for both services and the list of what has been sent live in `server/connections.json`, also
ignored by git. The analyzer has no login of its own, so anyone who can reach it on your network could
post to these accounts through it: one more reason to run it only on a network you trust.

Tested without either service: Strava against its documented requests and its real refusals, Garmin's
library with a stand-in and one real sign-in with a made-up account (refused, as it should be), and the
FIT files by reading them back with Garmin's own FIT SDK. Nothing has been posted to a real Strava or
Garmin account yet, so how the sets appear in Garmin Connect is still to be seen.

## Tests

- **Analyzer tests**: `uv run server/test_analyzer.py` — model choice, the requests sent to Claude, Z.ai
  and OpenRouter, reading their answers and errors. They call no outside service.
- **Connector tests**: `uv run server/test_connectors.py` — connecting, sending and not sending twice,
  for Strava and Garmin Connect.
