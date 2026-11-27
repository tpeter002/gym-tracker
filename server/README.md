# Gym Tracker — analyzer

The one service behind both apps. It names the exercises in a saved workout video, serves the built
[web version](../web/README.md), holds links shared to the web version from other apps, and sends
finished workouts to Strava and Garmin Connect. It runs on your own computer; the phone reaches it
over Wi-Fi.

**It has no login.** Anyone who can reach it can use the model keys it holds, read what is waiting in
an inbox, and post to the Strava and Garmin accounts connected to it — so run it only on a network you
trust. What it does guard against is listed under [What it refuses](#what-it-refuses).

- `analyzer.py` — the service itself: download, frames, the vision model.
- `inbox.py` — links shared from other apps, waiting for the web version to collect them.
- `connectors.py` — Strava and Garmin Connect.
- `jsonstore.py` — the small JSON files the two above keep, written safely.
- `stub_analyzer.py` — a stand-in with a canned answer, for testing the apps without a model.
- `.env.example` — the settings, to copy to `.env`.

The commands below are run from the repository's root.

## Video analyzer

`server/analyzer.py` downloads a clip with yt-dlp, samples frames with ffmpeg and asks a vision model
— Claude unless you choose another — which exercises are in it.

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

- It works on one clip of up to 10 minutes and 300 MB: playlists, profiles and live streams are refused.
- Instagram usually refuses anonymous downloads. `YTDLP_COOKIES_FROM_BROWSER=safari` (or `chrome`) in
  `server/.env` lends the analyzer that browser's login; for Safari, the app the analyzer runs in
  (Terminal) needs Full Disk Access.
- `uv run server/analyzer.py --check <url>` tests just the download and frame steps, no AI call. It
  leaves the frames in a temporary folder and prints where, so you can look at them.
- Each analysis sends up to 24 frames to the model. With Claude Opus 5.5 that is, by a rough
  estimate, 5–10 cents per video; the free models below cost nothing but have daily limits.

### Choosing the model

The analyzer can ask Claude, [Z.ai](https://z.ai)'s GLM models, any image-reading model on
[OpenRouter](https://openrouter.ai), or Google's Gemini. Put the key of the service you want in
`server/.env` (git ignores that file; `server/.env.example` is the template):

```sh
# Claude; claude-opus-5-5 unless ANALYZER_MODEL says otherwise
ANTHROPIC_API_KEY=sk-ant-...
# Z.ai; glm-4.6v-flash by default
ZAI_API_KEY=...
# OpenRouter; openrouter/free by default, which picks a free model
OPENROUTER_API_KEY=sk-or-...
# Google AI Studio; gemini-3.8-flash by default
GEMINI_API_KEY=...

# anthropic, zai, openrouter or gemini — only needed with more than one key
ANALYZER_PROVIDER=zai
# optional: another model of that service
ANALYZER_MODEL=glm-5.3-flash
```

With one key, that service is used; with several and no `ANALYZER_PROVIDER`, the first of them in the
order above is. The line the analyzer prints at start-up says which model it will ask.

Three of the four have something that costs nothing. The limits are the services' own and change;
check them where you got the key.

- **Gemini** — the Flash models have a free daily allowance per model. A request that is turned away
  for "high demand" still counts against it, so the analyzer asks each Flash model at most once per
  video, in order, until one answers; the video shows which one did. Google uses free-tier requests to
  improve its products, and its terms allow only the paid tier for apps offered to users in the EEA,
  Switzerland and the UK.
- **OpenRouter** — models whose name ends in `:free`, and `openrouter/free`, with a daily limit.
- **Z.ai** — `glm-4.6v-flash` is listed as free. When a model is busy and the service offers no other,
  the analyzer asks once more after a few seconds and then says so.

The web version can also choose for itself, per browser: Settings → Video model sets the service and
the model, and optionally a key of your own that is sent along with each video instead of the
analyzer's. The iPhone app has no such setting and uses whatever the analyzer is set to. A saved video
shows which model identified it, and **Identify Again** makes comparing two models on your own videos
a one-tap job — how well a given model names exercises is something only that shows.

### Other settings

All go in `server/.env` (or the environment, which wins):

| Setting | What it does |
| :- | :- |
| `PORT` | The port to listen on; 8787 unless set. |
| `ALLOWED_HOSTS` | Extra names the service answers to, comma-separated (`*.example.net` covers subdomains) — for a tunnel or a tailnet name. IP addresses, `localhost` and `.local` names always work. |
| `ALLOWED_ORIGINS` | Sites allowed to call in from a browser, comma-separated — only when the web version is hosted somewhere else. |
| `ALLOW_LOCAL_VIDEO_LINKS` | Set to `1` to let video links point at this computer or the local network. |
| `YTDLP_COOKIES_FROM_BROWSER` | `safari`, `chrome`, `firefox`… — see above. |
| `STRAVA_CLIENT_ID`, `STRAVA_CLIENT_SECRET` | Your Strava API application — see below. |

`ZAI_BASE_URL`, `OPENROUTER_BASE_URL` and `GEMINI_BASE_URL` point a service's requests somewhere else;
they exist for the tests.

### What it refuses

- **Requests under a name it doesn't go by.** A web page you happen to visit can't read this service's
  answers — unless it points its own domain at your Mac, which is why a request whose `Host` is neither
  an IP address, `localhost`, a `.local` name nor listed in `ALLOWED_HOSTS` gets a 421.
- **Video links into the local network.** The service fetches what it is given, so a link to
  `localhost`, a private address or the router is turned away unless `ALLOW_LOCAL_VIDEO_LINKS` is set.
  A link that starts outside and redirects inside is not caught.
- **Workouts that could not have happened** — dates before 1990, negative reps and the like — rather
  than letting them crash the file written for Garmin.

## Links shared from other apps

The web version can't be in the iPhone share sheet, so an iOS Shortcut posts the shared link here and
the app picks it up when it is next open
([how to set that up](../web/README.md#sharing-from-instagram-tiktok-or-youtube)).

- `POST /inbox/<code>` — leaves a link. The body can be JSON (`{"url": "…"}` or `{"text": "…"}`), a
  form with the same fields, or plain text; the first web address in it is kept. Answers
  `{"saved": true, "url": "…", "waiting": 1}`, or 422 when there is no link.
- `GET /inbox/<code>` — what is waiting: `{"links": [{"id", "url", "added_at"}]}`.
- `POST /inbox/<code>/taken` with `{"ids": […]}` — the app has saved these; they are dropped.

Each copy of the web app makes up its own code, so two browsers never empty each other's inbox. The
links wait in `server/inbox.json` (not in git): at most 100 per inbox, for at most two months. The code
keeps inboxes apart; it doesn't guard them.

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

Strava's tokens and the list of what has been sent to either service live in `server/connections.json`
(ignored by git).

**Garmin Connect** has no official way for a personal project to add an activity: its developer
programme is for approved businesses, and the personal API only reads. What this uses is the upload the
Garmin Connect website itself has, reached with your own login through the unofficial
[`garminconnect`](https://github.com/cyberjunky/python-garminconnect) library. That is outside what
Garmin supports: it can stop working when Garmin changes its sign-in, and using it is your call. Your
password goes to the analyzer once, is exchanged for tokens (`server/garmin-tokens/`, ignored by git)
and is not stored. The workout is uploaded as a FIT file — a strength activity with one record per set
(exercise, reps, weight). The app doesn't record when each set was done, so the sets are spread evenly
over the workout's duration.

## Tests

```sh
uv run server/test_analyzer.py      # the video part and the service around it
uv run server/test_connectors.py    # Strava and Garmin Connect
uv run server/test_inbox.py         # links shared from other apps
```

They call no outside service: downloads and frames are replaced, Claude's client and the chat APIs of
Z.ai, OpenRouter and Gemini are stand-ins that record what they are sent, Strava is an in-process
stand-in, Garmin's library is a fake, and the FIT files are read back with Garmin's own FIT SDK.

What has been run against the real thing, and what has not:

- **Run:** the download and frame steps on YouTube and Instagram; Gemini on its free tier, which named
  the exercises in a one-exercise Instagram reel and a five-exercise YouTube video (its Flash-Lite
  models named the reel wrongly, so they are offered but never used as a fallback); Z.ai, OpenRouter,
  Strava and Garmin as far as a made-up key or login gets, which each refuses as it should.
- **Not yet:** an analysis by Z.ai's free model or by Claude with a real key; anything posted to a
  real Strava or Garmin account, so how the sets appear in Garmin Connect is still to be seen.
