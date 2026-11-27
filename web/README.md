# Gym Tracker — web version

The same workout log as the iPhone app, in a browser: start or repeat a workout, log sets with weight,
reps and RPE/RIR, search ~200 exercises or add your own, track body weight, import a Strong export, and
turn saved workout videos into exercises on a "to try" list.

It is its own program. It shares no code and no data with the iPhone app — only the video analyzer in
`../server`, which both can call.

What it does that the iPhone app doesn't yet:

- **Up next** on the home screen: the routine you have gone longest without — what a rotation such as
  push / pull / legs calls for next — with a button that repeats your last session of it. Workouts count
  as the same routine when they share a name you gave them or at least half their exercises, so it also
  works if you never name workouts. It looks at the last eight weeks and needs a routine to have been
  done twice.
- **To try today** inside a workout: the exercises from your saved videos that fit what you are training
  — the workout already has an exercise for the same muscle, or at least a third of it is about the same
  part of the body (legs, push, pull). They are offered with one tap each, never added by themselves.
- **Ranks**: every lift gets a rank, and so does the lifter — see [Ranks](#ranks).
- **One dumbbell or both**: each logged dumbbell exercise says how its weights were typed in — see
  [Dumbbell weights](#dumbbell-weights).
- **Sharing from other apps** without a share extension — see
  [Sharing from Instagram, TikTok or YouTube](#sharing-from-instagram-tiktok-or-youtube).
- **Choosing the model** that names a video's exercises, per browser — see [Saving videos](#saving-videos).
- **Strava and Garmin Connect**: a finished workout can be sent to both — see
  [the analyzer's README](../server/README.md#sending-workouts-to-strava-and-garmin-connect).

## Run it

Needs Node 22.12 or newer and, to serve it the way shown here, what the analyzer needs
(`brew install ffmpeg uv` — it won't start without ffmpeg). Browsers: Safari 17+, Chrome 114+,
Firefox 125+ — tested in Chromium and WebKit, not in Firefox.

```sh
cd web
npm install
npm run build
uv run ../server/analyzer.py     # serves the app and the analyzer
```

Open `http://localhost:8787`. From another device on the same Wi-Fi, use the `http://<your-mac>.local:8787`
address the analyzer prints.

Without the analyzer (and without ffmpeg or uv), `npm run preview` serves the app alone at
`http://localhost:4173`. Everything works except what the analyzer does: videos are saved as links and
you name their exercises yourself, and nothing is shared in or sent out.

`npm run dev` is the development server (it forwards analyzer calls to a running `analyzer.py`).

## Where your data is

In the browser's own storage (IndexedDB) — per browser, per device, per address. The browser talks
only to your analyzer, and to YouTube for a video's still image. The analyzer in turn passes a video's
frames to the model service you chose and, only if you switch that on, finished workouts to Strava and
Garmin Connect. An API key entered under Settings → Video model is kept in the browser too; it is
left out of backups and goes only to your analyzer, which uses it for that one request.

- **Settings → Download Backup** saves everything as one JSON file; **Restore Backup** loads it, replacing
  what is there. That is also how you move between browsers, devices or addresses.
- Clearing the browser's website data deletes the log. Safari can also remove a site's data when it
  hasn't been opened for seven days; a site added to the Home Screen is not affected.

## On a phone

- **At home:** the address above works as it is, including video identification. The page comes from the
  Mac each time, so it only opens while the Mac is reachable.
- **At the gym:** put the `dist` folder on any static https host (GitHub Pages, Netlify, Cloudflare
  Pages…), open it once, then Share → Add to Home Screen. From then on it opens without a connection.
  Browsers allow that only over https, which is why the Mac's `http://` address can't do it. Opening
  without a connection is tested in Chromium; it has not been tried on an iPhone yet.
- A hosted copy can't call an `http://` analyzer (browsers block that). Either identify videos from the
  Mac's address and move the result with a backup, or run the analyzer behind https and enter its address
  under Settings → Video analyzer; the analyzer then needs `ALLOWED_ORIGINS=https://<where the app is
  hosted>` and its https name in `ALLOWED_HOSTS`
  ([its settings](../server/README.md#other-settings)). Of that second route only the analyzer's
  response headers have been tested.

## Saving videos

Saved Videos → **+**, then paste the link (text around it is fine). With the analyzer reachable the clip
is identified straight away and its exercises go onto the to-try list; otherwise it happens the next
time the app is open and the analyzer answers.

Which model names the exercises is the analyzer's choice (see
[its README](../server/README.md#choosing-the-model)) unless you make it here:
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

## Editing a finished workout

A finished workout's page has **Edit Workout** in its menu. It opens the workout in the same screen
it was logged in: change a number, add or remove a set or an exercise, rename it, and move its start
or change when it ended. **Done** keeps the changes — as does leaving the page any other way —
and **Cancel** puts everything back as it was. As when finishing, only ticked sets are kept.

The "Previous" column shows the session before the one being edited. Records, ranks and "Up next"
follow the change by themselves; a copy already sent to Strava or Garmin Connect does not.

## Dumbbell weights

Dumbbell weights get typed in two ways — one dumbbell, or the pair together — sometimes by the same
person. Every logged dumbbell exercise carries a small button that says which: **Per dumbbell** or
**Both dumbbells**. It is on the exercise in a running workout, on a finished workout's page, and on
each session of the exercise's own page, so old sessions can be put right too.

The numbers themselves are never rewritten; the button changes how they are read:

- A new workout counts an exercise the way it was counted last time, and the "Previous" column (and
  what a tick takes over from it) is said the current workout's way.
- On the exercise's page, records and the top-set chart read every session the way the latest one
  was counted. The chart names the reps with the weight: "31.5 kg × 10".
- Volume and ranks count one dumbbell, whichever way a session was typed in.
- Workouts sent to Strava and Garmin Connect carry the numbers as typed.

One dumbbell is the default, which is how Strong exports them.

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
on the spot. A finished workout's page shows, for each of its lifts, the rank as it stood once that
workout was done — and "Up from Gold II" or "First rank" where the workout earned it. (Past ranks
are measured against today's body weight, like all the others.) The emblems are drawn in code
(`src/ui/RankBadge.tsx`); the animation is switched off for anyone who has asked their device to
reduce motion.

The yardsticks live in `src/lib/standards.ts`, one line per exercise; its header says where the
numbers come from and how rough they are. Change a line if a rank feels off.

## Tests

```sh
npm run typecheck                      # the app and its tests
npm test                               # the logic, in Node (Vitest)
npx playwright install chromium webkit # once
npm run test:e2e                       # the built app in desktop Chromium and iPhone-sized WebKit
```

`tests/unit` and `tests/e2e` have one file per feature. The browser tests stand in for the analyzer
themselves, so they need neither the Mac service nor an API key; opening without a connection is
tested in Chromium only. `tests/fixtures/backup-v1.json` is a backup in the format people have on
disk: a change that stops it restoring is a change that breaks their files. The analyzer's own tests are described in
[its README](../server/README.md#tests).

## Code

- `src/lib` — data and logic, no interface, one module per subject; `types.ts` describes what is
  stored, `store.ts` holds the state and `db.ts` writes it to IndexedDB.
- `src/screens` — one file per page; `src/ui` — shared pieces (page frame, sheets, menus, chart, emblems).
- `sw.template.js` — the service worker; `vite.config.ts` fills in the list of built files.
