# Gym Tracker — web version

The same workout log as the iPhone app, in a browser: start or repeat a workout, log sets with weight,
reps and RPE/RIR, search ~200 exercises or add your own, track body weight, import a Strong export, and
turn saved workout videos into exercises on a "to try" list.

It is its own program. It shares no code and no data with the iPhone app — only the video analyzer in
`../server`, which both can call.

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

A web page can't appear in the iPhone share sheet. Two partial substitutes:

- Opening `<app address>/?url=<link>` saves the link — usable from a bookmark or an iOS Shortcut that
  takes the share sheet's input. On iPhone a Home Screen app keeps its data apart from Safari's, so
  this only helps if you use the app in a Safari tab.
- On Android, an installed copy is listed in the share sheet (`share_target` in the manifest). Untested.

## Tests

```sh
npm test                               # logic: workouts, Strong import, videos, backup (Vitest)
npx playwright install chromium webkit # once
npm run test:e2e                       # the built app in desktop Chromium and iPhone-sized WebKit
```

The browser tests stand in for the analyzer themselves, so they need neither the Mac service nor an API
key. They cover logging, finishing and repeating a workout, custom exercises, the to-try list, saved
videos with and without the analyzer, Strong import, body weight, units, backup and restore, two tabs,
and opening without a connection (Chromium only).

## Code

- `src/lib` — data and logic, no interface: `types.ts`, `workouts.ts`, `exercises.ts`, `strong.ts`,
  `videos.ts`, `backup.ts`; `store.ts` holds the state and `db.ts` writes it to IndexedDB.
- `src/screens` — one file per page; `src/ui` — shared pieces (page frame, sheets, menus, chart).
- `sw.template.js` — the service worker; `vite.config.ts` fills in the list of built files.
