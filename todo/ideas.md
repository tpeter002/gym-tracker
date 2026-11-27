# Ideas

Not decided, not scheduled. The first two are the owner's; the rest came up while building.

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

## Others

- **Edit a finished workout.** Today a finished workout can only be deleted (and its dumbbell
  counting changed). A wrong number stays wrong.
- **Rest timer** between sets.
- **Routines by name.** "Up next" infers them from history; let them be made and named on purpose.
- **Supersets.**
- **A best-set celebration** of its own: a new record that doesn't happen to cross a rank step
  passes unnoticed.
- **Volume per muscle group by week**, and a calendar of training days.
- **Plate calculator** for barbell lifts.
- **Friends' ranks side by side**, once there are accounts.
- **Export to CSV**, in Strong's format, so leaving is as easy as arriving.
- **A reminder to download a backup** until the data is synced somewhere.
- **Apple Health:** the iPhone app could write finished workouts to it (Health has no place for
  exercises or sets, so only the fact and the duration).
- **Strava:** say in the description when a dumbbell set was typed in as the pair.
