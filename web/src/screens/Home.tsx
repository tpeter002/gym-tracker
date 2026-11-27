import { Calendar, Plus, Settings, Sparkles, SquarePlay } from 'lucide-react';
import { useMemo } from 'react';
import { requestStart } from '../lib/actions';
import { byNewest, nextWorkout, toTryFor } from '../lib/suggestions';
import type { Routine } from '../lib/suggestions';
import type { AppState } from '../lib/types';
import { fmtDaysAgo } from '../lib/units';
import { activeWorkout, finishedWorkouts } from '../lib/workouts';
import { Link, LinkRow, Page, Section } from '../ui/layout';
import { ExerciseLabel, ResumeCard, WorkoutRow, WorkoutSummary } from '../ui/parts';

/** How many finished workouts the landing tab lists; the rest are under History. */
const RECENT_SHOWN = 5;
/** How many to-try exercises it lists before pointing at the picker. */
const TO_TRY_SHOWN = 5;

/**
 * Landing tab: start or resume a workout, see which routine is due and what's
 * waiting from saved videos, and repeat a recent session.
 */
export function Home({ state }: { state: AppState }) {
  const active = activeWorkout(state);
  const recent = useMemo(() => finishedWorkouts(state).slice(0, RECENT_SHOWN), [state.workouts]);
  const toTry = useMemo(
    () => state.exercises.filter((exercise) => exercise.wantToTry).sort(byNewest),
    [state.exercises],
  );
  const next = useMemo(() => nextWorkout(state), [state.workouts]);

  return (
    <Page
      title="Workout"
      large
      trailing={
        <Link to="/settings" className="icon-button" label="Settings">
          <Settings size={22} aria-hidden />
        </Link>
      }
    >
      <div className="spaced">
        {active ? (
          <ResumeCard workout={active} />
        ) : (
          <button className="btn btn-primary" onClick={() => requestStart({ kind: 'empty' })}>
            <Plus size={20} aria-hidden />
            Start Empty Workout
          </button>
        )}
      </div>

      {next && <NextWorkout state={state} routine={next} />}

      <Section
        title="To try"
        footer={
          state.videos.length === 0
            ? 'Save a workout reel, short or TikTok under Saved Videos and its exercises show up here.'
            : toTry.length > TO_TRY_SHOWN && `${toTry.length - TO_TRY_SHOWN} more in the exercise picker.`
        }
      >
        <LinkRow to="/videos">
          <SquarePlay className="row-icon" size={22} aria-hidden />
          Saved Videos
          <span className="row-value">{state.videos.length}</span>
        </LinkRow>
        {toTry.slice(0, TO_TRY_SHOWN).map((exercise) => (
          <LinkRow key={exercise.id} to={`/exercises/${exercise.id}`}>
            <ExerciseLabel exercise={exercise} />
          </LinkRow>
        ))}
      </Section>

      {recent.length > 0 && (
        <Section title="Recent">
          {recent.map((workout) => <WorkoutRow key={workout.id} workout={workout} />)}
        </Section>
      )}
    </Page>
  );
}

/** The routine that is due, startable in one tap, with the saved-video exercises that would fit it. */
function NextWorkout({ state, routine }: { state: AppState; routine: Routine }) {
  const { latest } = routine;
  const fitting = useMemo(() => toTryFor(state, latest), [state.exercises, latest]);
  return (
    <Section title="Up next" footer="The routine you have gone longest without. Starting it repeats your last session of it.">
      <div className="row split">
        <Link to={`/history/${latest.id}`} className="row-main">
          <WorkoutSummary
            workout={latest}
            meta={<span><Calendar size={14} aria-hidden />Last done {fmtDaysAgo(latest.startedAt)}</span>}
          >
            {fitting.length > 0 && (
              <p className="fits">
                <Sparkles size={14} aria-hidden />
                {fitting.length} to try: {fitting.map((exercise) => exercise.name).join(', ')}
              </p>
            )}
          </WorkoutSummary>
        </Link>
        <button
          className="btn btn-primary btn-inline"
          aria-label={`Start ${latest.name}`}
          onClick={() => requestStart({ kind: 'repeat', workoutId: latest.id })}
        >
          Start
        </button>
      </div>
    </Section>
  );
}
