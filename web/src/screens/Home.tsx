import { ChevronUp, Dumbbell, Plus, Settings, SquarePlay } from 'lucide-react';
import { useMemo } from 'react';
import { requestStart } from '../lib/actions';
import { navigate } from '../lib/router';
import type { AppState, Workout } from '../lib/types';
import { activeWorkout, finishedWorkouts } from '../lib/workouts';
import { Link, LinkRow, Page, Section } from '../ui/layout';
import { ElapsedTime, ExerciseLabel, WorkoutRow } from '../ui/parts';

/**
 * Landing tab: start or resume a workout, see what's waiting from saved
 * videos, and repeat a recent session.
 */
export function Home({ state }: { state: AppState }) {
  const active = activeWorkout(state);
  const recent = useMemo(() => finishedWorkouts(state).slice(0, 5), [state.workouts]);
  const toTry = useMemo(
    () => state.exercises.filter((exercise) => exercise.wantToTry).sort((a, b) => b.createdAt - a.createdAt),
    [state.exercises],
  );

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

      <Section
        title="To try"
        footer={
          state.videos.length === 0
            ? 'Save a workout reel, short or TikTok under Saved Videos and its exercises show up here.'
            : toTry.length > 5 && `${toTry.length - 5} more in the exercise picker.`
        }
      >
        <LinkRow to="/videos">
          <SquarePlay className="row-icon" size={22} aria-hidden />
          Saved Videos
          <span className="row-value">{state.videos.length}</span>
        </LinkRow>
        {toTry.slice(0, 5).map((exercise) => (
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

/** The running workout, as a button back into it. */
export function ResumeCard({ workout, compact }: { workout: Workout; compact?: boolean }) {
  return (
    <button className={compact ? 'resume-card resume-bar' : 'resume-card'} onClick={() => navigate('/workout')}>
      {!compact && <Dumbbell size={26} aria-hidden />}
      <span className="grow">
        <strong>{workout.name || 'Workout'}</strong>
        <span className="small">In progress · <ElapsedTime since={workout.startedAt} /></span>
      </span>
      <span className="cta">Resume <ChevronUp size={18} aria-hidden /></span>
    </button>
  );
}
