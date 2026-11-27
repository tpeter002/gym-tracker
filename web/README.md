# Gym Tracker — web version

The same workout log as the iPhone app, in a browser: start or repeat a workout, log sets with weight,
reps and RPE/RIR, search ~200 exercises or add your own, track body weight, import a Strong export, and
turn saved workout videos into exercises on a "to try" list.

It is its own program. It shares no code and no data with the iPhone app — only the video analyzer in
`../server`, which both can call.

Three things it does that the iPhone app doesn't yet:

- **Up next** on the home screen: the routine you have gone longest without — what a rotation such as
  push / pull / legs calls for next — with a button that repeats your last session of it. Workouts count
  as the same routine when they share a name you gave them or at least half their exercises, so it also
  works if you never name workouts. It looks at the last eight weeks and needs a routine to have been
  done twice.
- **To try today** inside a workout: the exercises from your saved videos that fit what you are training
  — the workout already has an exercise for the same muscle, or at least a third of it is about the same
  part of the body (legs, push, pull). They are offered with one tap each, never added by themselves.

- **Ranks**: every lift gets a rank, and so does the lifter — see [Ranks](#ranks).

It can also send each finished workout to Strava and Garmin Connect; see
[the analyzer's README](../server/README.md#sending-workouts-to-strava-and-garmin-connect).

## Run it

Needs Node 22 or newer (20.19+ also works) and, for the video part, what the analyzer needs
(`brew install ffmpeg uv`). Browsers: Safari 17+, Chrome 114+, Firefox 125+ — tested in Chromium and
WebKit, not in Firefox.

```sh
cd web
npm install
npm run build
uv run ../server/analyzer.py     # serves the app and the analyzer
```

Open `http://localhost:8787`. From another device on the same Wi-Fi, use the `http://<your-mac>.local:8787`
address the analyzer prints.

Without the analyzer, `npm run preview` serves the app alone at `http://localhost:4173`. Everything works
except automatic identification: videos are saved as links and you name their exercises yourself.

`npm run dev` is the development server (it forwards analyzer calls to a running `analyzer.py`).

## Where your data is

In the browser's own storage (IndexedDB) — per browser, per device, per address. Nothing is sent
anywhere; the only network calls are to the analyzer, and to YouTube for a video's still image.
An API key entered under Settings → Video model is kept there too; it is left out of backups and goes
only to your analyzer.

- **Settings → Download Backup** saves everything as one JSON file; **Restore Backup** loads it, replacing
  what is there. That is also how you move between browsers, devices or addresses.
- Clearing the browser's website data deletes the log. Safari can also remove a site's data when it
  hasn't been opened for seven days; a site added to the Home Screen is not affected.

## On a phone

- **At home:** the address above works as it is, including video identification. The page comes from the
  Mac each time, so it only opens while the Mac is reachable.
- **At the gym:** put the `dist` folder on any static https host (GitHub Pages, Netlify, Cloudflare
  Pages…), open it once, then Share → Add to Home Screen. From then on it opens without a connection.
  Browsers allow that only over https, which is why the Mac's `http://` address can't do it.
- A hosted copy can't call an `http://` analyzer (browsers block that). Either identify videos from the
  Mac's address and move the result with a backup, or run the analyzer behind https and enter its address
  under Settings → Video analyzer; start it with `ALLOWED_ORIGINS=https://<where the app is hosted>`.
  Of that second route only the analyzer's response headers have been tested.

## Saving videos

Saved Videos → **+**, then paste the link (text around it is fine). With the analyzer reachable the clip
is identified straight away and its exercises go onto the to-try list; otherwise it happens the next
time the app is open and the analyzer answers.

Which model names the exercises is the analyzer's choice (see [its README](../server/README.md#choosing-the-model)) unless you make it here:
**Settings → Video model** picks the service — Claude, Z.ai, OpenRouter or Gemini — and the model, with
suggestions from the analyzer (for OpenRouter, its current list with prices, free ones first). Leave the
key field empty to use the key the analyzer has, or enter your own. Each saved video shows which model
identified it, and **Identify Again** asks whichever model is selected now.

### Sharing from Instagram, TikTok or YouTube

A web page can't appear in the iPhone share sheet, and a Shortcut can't hand a link to an app on the
Home Screen either — it can only open Safari, which keeps its data apart. So the link goes through the
analyzer: a Shortcut in the share sheet posts it to an inbox that belongs to one copy of the app, and
that copy collects it the next time it is open (and identifies it straight away).

**Settings → Share from other apps** shows the address of that inbox, with a button to copy it. Open
Settings in the copy you actually use — the one on the Home Screen has a different inbox from a Safari
tab. Then, once, in the Shortcuts app:

1. New shortcut → add the action **Get Contents of URL** and paste the address as its URL.
2. In the action's options: Method **POST**, Request Body **JSON**, one text field named `url` whose
   value is the variable **Shortcut Input**.
3. In the shortcut's details switch on **Show in Share Sheet**; name it "Gym Tracker".

From then on: Share → Gym Tracker in any app. The phone has to reach the analyzer at that moment, so
on the Mac's `http://` address this works on the home Wi-Fi while the Mac is awake. Tested by posting
to the inbox the way a Shortcut does; the Shortcut itself has not been run on a phone yet.

Two other ways in:

- Opening `<app address>/?url=<link>` saves the link — handy as a bookmark in the browser the app runs in.
- On Android, an installed copy is listed in the share sheet (`share_target` in the manifest). Untested.

## Ranks

The **Ranks** tab gives every lift a rank, from Iron through Bronze, Silver, Gold, Platinum and Diamond
to Legend, with three steps to each tier. A rank compares your best working set with what strong
lifters of your body weight manage:

- **Lifts with weight** are ranked by estimated one-rep max (weight × (1 + reps ÷ 30), reps counted up
  to twelve) as a multiple of body weight. Legend begins at about 2× body weight on the bench press,
  2.7× in the squat and 3× in the deadlift for men; Gold at 55% of that.
- **Bodyweight exercises** — pull-ups, push-ups, dips and the like — are ranked by reps in one set,
  and weight added on top counts.
- **Your own exercises** are ranked when their name contains a library movement done with the same
  equipment: "Paused Bench Press (Barbell)" is measured as a barbell bench press. Holds, carries,
  cardio and anything the library has no yardstick for stay unranked.

It needs two things, both on the Ranks page: which standards to measure against (men's or women's;
**Off** hides ranks everywhere) and a body weight — the latest weigh-in under Body is used, so the same
lift counts for more at a lower body weight. The overall rank is the average of your best push, pull
and leg lift; a part of the body with nothing ranked counts as zero.

In a running workout each ranked lift shows its emblem, and a set that lifts it a step is celebrated
on the spot. The emblems are drawn in code (`src/ui/RankBadge.tsx`); the animation is switched off
for anyone who has asked their device to reduce motion.

The yardsticks live in `src/lib/standards.ts`, one line per exercise. The big barbell lifts and
pull-ups follow the bodyweight-ratio tables in common use; the rest — dumbbells, cables, machines —
are estimates scaled from those, and machines differ from gym to gym. Treat it as a game that makes
progress visible, and change a line if a rank feels off.

## Tests

```sh
npm test                               # logic: workouts, Strong import, videos, backup, model choice, ranks (Vitest)
npx playwright install chromium webkit # once
npm run test:e2e                       # the built app in desktop Chromium and iPhone-sized WebKit
uv run ../server/test_analyzer.py      # the analyzer's side
uv run ../server/test_connectors.py    # Strava and Garmin Connect
uv run ../server/test_inbox.py         # links shared from other apps
```

The browser tests stand in for the analyzer themselves, so they need neither the Mac service nor an API
key. They cover logging, finishing and repeating a workout, custom exercises, the to-try list, saved
videos with and without the analyzer, videos shared from other apps, choosing the model and key,
ranks and the rank-up celebration, Strong import, body weight, units, backup and restore, two tabs,
and opening without a connection (Chromium only).

## Code

- `src/lib` — data and logic, no interface: `types.ts`, `workouts.ts`, `exercises.ts`, `strong.ts`,
  `videos.ts`, `backup.ts`, `ranks.ts` with its table in `standards.ts`; `store.ts` holds the state
  and `db.ts` writes it to IndexedDB.
- `src/screens` — one file per page; `src/ui` — shared pieces (page frame, sheets, menus, chart).
- `sw.template.js` — the service worker; `vite.config.ts` fills in the list of built files.
