import { ArrowLeftRight, Calendar, ChevronUp, Clock, Dumbbell, Play, RotateCw, SquarePlay } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { requestStart } from '../lib/actions';
import { exerciseSubtitle } from '../lib/exercises';
import { navigate } from '../lib/router';
import { update } from '../lib/store';
import type { Exercise, SavedVideo, Workout, WorkoutEntry } from '../lib/types';
import { fmtClock, fmtDayMonth, fmtDuration } from '../lib/units';
import { youtubeThumbnail } from '../lib/videos';
import { durationSeconds, setBothDumbbells } from '../lib/workouts';
import { Link } from './layout';

/** Live "12:34" clock counting up from the workout's start. */
export function ElapsedTime({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return <span className="numeric">{fmtClock((now - since) / 1000)}</span>;
}

/** Name, muscle and equipment, plus markers for exercises saved from a video. */
export function ExerciseLabel({ exercise }: { exercise: Exercise }) {
  return (
    <span className="grow">
      <span className="title-line">
        {exercise.name}
        {exercise.wantToTry && <span className="badge">To try</span>}
      </span>
      <span className="sub">
        {exerciseSubtitle(exercise)}
        {exercise.videoURL && <SquarePlay size={14} role="img" aria-label="has a video" />}
      </span>
    </span>
  );
}

/**
 * Says whether a dumbbell exercise's weights are for one dumbbell or the pair
 * together, and flips it. The numbers stay as typed; what changes is how they
 * are read — in "previous", in records and in ranks.
 */
export function DumbbellToggle({ workoutId, entry }: { workoutId: string; entry: WorkoutEntry }) {
  const both = entry.bothDumbbells === true;
  return (
    <button
      className="pill-toggle"
      aria-pressed={both}
      aria-label="Both dumbbells together"
      title={both ? 'The weights are the two dumbbells together.' : 'The weights are one dumbbell.'}
      onClick={() => update((draft) => setBothDumbbells(draft, workoutId, entry.id, !both))}
    >
      <ArrowLeftRight size={13} aria-hidden />
      {both ? 'Both dumbbells' : 'Per dumbbell'}
    </button>
  );
}

/** How many exercises a workout's summary names before it says "+ N more". */
const SUMMARY_ENTRIES = 4;

/** A workout at a glance: its name, a line of facts (`meta`) and its first few exercises. */
export function WorkoutSummary({ workout, meta, children }: { workout: Workout; meta: ReactNode; children?: ReactNode }) {
  return (
    <div className="summary">
      <h3>{workout.name}</h3>
      <div className="meta">{meta}</div>
      <ul>
        {workout.entries.slice(0, SUMMARY_ENTRIES).map((entry) => (
          <li key={entry.id}>{entry.sets.length} × {entry.exerciseName}</li>
        ))}
        {workout.entries.length > SUMMARY_ENTRIES && <li>+ {workout.entries.length - SUMMARY_ENTRIES} more</li>}
      </ul>
      {children}
    </div>
  );
}

/** A finished workout in a list: opens it, with a button to do it again. */
export function WorkoutRow({ workout }: { workout: Workout }) {
  const seconds = durationSeconds(workout);
  return (
    <div className="row split">
      <Link to={`/history/${workout.id}`} className="row-main">
        <WorkoutSummary
          workout={workout}
          meta={
            <>
              <span><Calendar size={14} aria-hidden />{fmtDayMonth(workout.startedAt)}</span>
              {seconds >= 60 && <span><Clock size={14} aria-hidden />{fmtDuration(seconds)}</span>}
            </>
          }
        />
      </Link>
      <button
        className="icon-button"
        aria-label={`Repeat ${workout.name}`}
        title="Repeat this workout"
        onClick={() => requestStart({ kind: 'repeat', workoutId: workout.id })}
      >
        <RotateCw size={20} aria-hidden />
      </button>
    </div>
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

export function Thumbnail({ video, large }: { video: SavedVideo; large?: boolean }) {
  const source = video.thumbnail ?? youtubeThumbnail(video.url);
  const [failed, setFailed] = useState(false);
  return (
    <span className={large ? 'thumb large' : 'thumb'}>
      {source && !failed
        ? <img src={source} alt="" loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
        : <Play size={large ? 32 : 20} aria-hidden />}
    </span>
  );
}
