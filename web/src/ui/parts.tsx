import { Calendar, Clock, Play, RotateCw, SquarePlay } from 'lucide-react';
import { useEffect, useState } from 'react';
import { requestStart } from '../lib/actions';
import { exerciseSubtitle } from '../lib/exercises';
import type { Exercise, SavedVideo, Workout } from '../lib/types';
import { fmtClock, fmtDayMonth, fmtDuration } from '../lib/units';
import { youtubeThumbnail } from '../lib/videos';
import { durationSeconds } from '../lib/workouts';
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
        {exercise.videoURL && <SquarePlay size={14} aria-label="has a video" />}
      </span>
    </span>
  );
}

/** A finished workout in a list: opens it, with a button to do it again. */
export function WorkoutRow({ workout }: { workout: Workout }) {
  const seconds = durationSeconds(workout);
  return (
    <div className="row split">
      <Link to={`/history/${workout.id}`} className="row-main">
        <div className="summary">
          <h3>{workout.name}</h3>
          <div className="meta">
            <span><Calendar size={14} aria-hidden />{fmtDayMonth(workout.startedAt)}</span>
            {seconds >= 60 && <span><Clock size={14} aria-hidden />{fmtDuration(seconds)}</span>}
          </div>
          <ul>
            {workout.entries.slice(0, 4).map((entry) => (
              <li key={entry.id}>{entry.sets.length} × {entry.exerciseName}</li>
            ))}
            {workout.entries.length > 4 && <li>+ {workout.entries.length - 4} more</li>}
          </ul>
        </div>
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
