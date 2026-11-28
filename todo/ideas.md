# Ideas

Not decided, not scheduled. Everything down to "Others" is the owner's; the rest came up while
building.

## Exercises compared by goal, on evidence

Choose what you train for — in Settings, a few goals such as looking better (muscle size), getting
stronger, moving well (function), and flexibility — and let the app say which exercises serve that
goal best. Two exercises for the same muscle are not interchangeable: a barbell bench press is the
choice for moving heavy weight, while for a bigger-looking chest an incline dumbbell press may be the
better pick.

**The condition:** everything it says has to rest on research, with the source shown. That makes
this mostly a research task before it is a programming one.

- A literature pass per goal and muscle: what long-term studies (not only muscle-activation
  readings) say about size, what specificity says about strength, what there is on range of motion
  and training at long muscle lengths, and how good that evidence is.
- A table next to `web/src/lib/standards.ts`: per exercise and goal, a rating, a one-line reason and
  the citation. Where the evidence is thin or mixed, say so instead of rating.
- In the app: goals in Settings; the exercise picker and "To try today" favouring what fits; an
  exercise's page saying what it is good for, and why.
- Start with the twenty or so lifts people actually log, not the whole library.

## A signal when progress has stopped

When an exercise has stopped going up — no progressive overload any more — say so, and suggest a
change, or at least mark it.

- Needs a definition of "stopped": for instance no new best estimated one-rep max, and no more reps
  at the same weight, over the last six sessions spanning at least four weeks. Irregular training
  must not trigger it.
- The data is there already (`sessionsFor`, `oneRepMax`); it is a calculation and a place to show it:
  the exercise's page, and the exercise in a running workout.
- What to suggest ties into the idea above: another rep range, a lighter week, or a variant that
  serves the same goal.

## Food: a connection to Yazio

Bring what was eaten — calories, protein, carbohydrate, fat, and when — next to the training log.

**What is known** (looked up in November 2026, not tried):

- Yazio has no official API. What exists is its apps' own undocumented backend, and unofficial
  clients written against it (`juriadams/yazio`, `yazio-exporter` and others) whose authors warn
  that it can change without notice. Using it means handing the app a Yazio password.
- The official way out is Apple Health: Yazio can write nutrition there. A web page cannot read
  Apple Health; the iPhone app in `ios/` could. So this idea either revives the iPhone app, or goes
  through a Shortcut that reads Health and posts a day's totals somewhere the web app can fetch
  them — the way shared videos arrive today.
- Yazio's own export is said to be a PDF or CSV for paying users; not confirmed.

**First step:** switch on Yazio → Apple Health on the phone and look at what actually lands in
Health: totals per day, or each meal with its time? The two ideas below need the times.

## Meals timed around training

Line up when to eat with when the workout is: how long before, what after.

- Needs a workout's time before it happens. The app only knows past sessions, so it would have to
  learn the usual days and hours from history ("Up next" already guesses the routine) or be told.
- Needs meal times, which is the Yazio question above — or it gives general guidance only.
- The condition from the goals idea applies: what it says has to rest on research, with the
  source shown, and say where the evidence is thin (it is for exact timing). It is guidance for a
  healthy adult, not dietary advice.

## Carbohydrate suggestion for training days

On a day with a hard session planned, suggest how much carbohydrate to aim for, and when.

- Same two needs: knowing the day's training in advance, and body weight (already logged).
- Same condition: the numbers come from sports-nutrition guidelines, cited, with the range they
  give rather than one figure. Loading in the strict sense is an endurance practice; for lifting
  the question is closer to "enough on heavy days", and the note should say so.
- Works without Yazio as a plain suggestion; with it, it could compare the suggestion with what
  was eaten.

## A calendar and charts on the home page

The Workout tab shows what is next; it could also show what has been.

- A month calendar with the training days marked, and a tap opening the day's workout.
- A few small charts, picked for being glanceable: workouts per week, volume per muscle group by
  week, body weight, the overall rank over time.
- Open question: which of them, and whether they belong on the home page or on a page of their own
  — the home page on a phone is already the list of routines and things to try.

## Ranks by body part — built

Each part of the body takes the rank of its best lift, shown as a list and on a drawing of the body
on the Ranks page (`web/src/ui/BodyMap.tsx`). What it does not do yet: count a compound lift for
more than the one muscle it is listed under, or say which part lags behind the others and what
would bring it up — the second ties into the goals idea above.

## Watching a lift: skeleton tracking and a form rating

Point the phone at a squat, deadlift, bench press or overhead press and have the web app follow the
body and rate the lift — all of it on the phone, nothing sent anywhere.

**What it would cost in money:** nothing. The model runs in the browser on the phone's own
processor and graphics chip.

**What it would take** — a rough guess, nothing here has been tried:

- *The tracking is the easy part.* Google's MediaPipe Pose Landmarker runs in a web page (33 points
  on the body, per frame); the model file is a few megabytes to some thirty, depending on how
  accurate. No measurement of it in iPhone Safari was found — reports of around 30 frames a second
  are for the native version, with slow-downs from heat after some minutes. Analysing a clip that
  was recorded first, instead of live, sidesteps both speed and heat, and is the place to start.
- *A day or two* for a trial: pick a recorded clip, draw the skeleton over it, see how well it
  holds up from the side at gym distances. This decides whether the rest is worth doing.
- *One to two weeks* for something useful on the squat and the deadlift: counting reps, depth
  (hip against knee), tempo, the path of the bar (followed at the wrists), left-right evenness.
  *Another one to two* for the bench press — lying down, half hidden by the bench, the hardest of
  the four to see — and the overhead press.
- *The rating is the hard part, and it is a research task like the goals idea.* What counts as good
  has to be defined and sourced per lift. And one camera with 33 points sees joints, not the spine:
  the thing most people want checked on a deadlift, a rounding lower back, is exactly what it
  cannot reliably see. It can say "not deep enough" or "the bar drifted forward"; it cannot say
  "your back is safe".
- Smaller costs: the site's security policy has to allow the model's code to run (WebAssembly),
  the files add to what the browser stores for offline use, the camera needs the https address,
  and tests need recorded sequences of points rather than a camera.

## Others

- **A routine built from scratch, and one that keeps up.** A routine is a finished workout saved
  under a name; it can't be put together without doing it once, and it doesn't follow later
  sessions unless a newer workout is saved under the same name.
- **Rest timer, further:** a length per exercise, and a way to be told when the phone is locked
  (a web page can't; the iPhone app could).
- **Supersets.**
- **A best-set celebration** of its own: a new record that doesn't happen to cross a rank step
  passes unnoticed.
- **Plate calculator** for barbell lifts.
- **Friends' ranks side by side.** Agreed as worth doing; it needs accounts, so it follows the
  hosting work in [README.md](README.md).
- **Export to CSV**, in Strong's format, so leaving is as easy as arriving.
- **A reminder to download a backup** until the data is synced somewhere.
- **Apple Health:** the iPhone app could write finished workouts to it (Health has no place for
  exercises or sets, so only the fact and the duration).
- **Strava:** say in the description when a dumbbell set was typed in as the pair.
