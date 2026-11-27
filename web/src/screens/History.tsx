import { Ellipsis, History as HistoryIcon, RotateCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { requestStart } from '../lib/actions';
import { connections, loadConnections, sending, sendWorkout } from '../lib/exports';
import { goBack } from '../lib/router';
import { update, useSignal } from '../lib/store';
import { EXPORT_TARGET_TITLES, EXPORT_TARGETS } from '../lib/types';
import type { AppState, SetEntry, WeightUnit, Workout } from '../lib/types';
import { effortLabel, fmtCount, fmtDateTime, fmtDuration, fmtMonthYear, fmtNumber, fromKg, weightText } from '../lib/units';
import { deleteWorkout, doneSets, durationSeconds, finishedWorkouts, rowLabels, takesDumbbells, volumeKg } from '../lib/workouts';
import { EmptyState, Link, Page, Section, ValueRow } from '../ui/layout';
import { Spinner } from '../ui/controls';
import { ConfirmDialog, Menu } from '../ui/overlays';
import { DumbbellToggle, WorkoutRow } from '../ui/parts';

/** Every finished workout, newest first, grouped by month. */
export function History({ state }: { state: AppState }) {
  const months = useMemo(() => {
    const groups: { title: string; workouts: Workout[] }[] = [];
    for (const workout of finishedWorkouts(state)) {
      const title = fmtMonthYear(workout.startedAt);
      if (groups.at(-1)?.title === title) groups.at(-1)!.workouts.push(workout);
      else groups.push({ title, workouts: [workout] });
    }
    return groups;
  }, [state.workouts]);

  return (
    <Page title="History" large>
      {months.length === 0 && (
        <EmptyState icon={<HistoryIcon size={48} aria-hidden />} title="No Workouts Yet">
          <p>Finished workouts appear here. You can also import your Strong history in Settings.</p>
        </EmptyState>
      )}
      {months.map((month) => (
        <Section key={month.title} title={month.title} aside={fmtCount(month.workouts.length, 'workout')}>
          {month.workouts.map((workout) => <WorkoutRow key={workout.id} workout={workout} />)}
        </Section>
      ))}
    </Page>
  );
}

export const setText = (set: SetEntry, unit: WeightUnit) => {
  const reps = set.reps === null ? '–' : String(set.reps);
  return set.weight === null ? `${reps} reps` : `${weightText(unit, set.weight)} × ${reps}`;
};

const EXPORT_STATUS = { waiting: 'Waiting to be sent', sent: 'Sent', failed: 'Not sent' } as const;

/** Whether the workout is on Strava and Garmin Connect, with a way to send it or try again. */
function Sharing({ workout }: { workout: Workout }) {
  const status = useSignal(connections);
  const busy = useSignal(sending);
  // Asked afresh each time: a service may have been connected or dropped since Settings was last open.
  useEffect(() => {
    void loadConnections();
  }, []);

  // Only the services that matter here: connected ones, and ones this workout already has a history with.
  const targets = EXPORT_TARGETS.filter((target) => workout.exports?.[target] || status?.[target].connected);
  if (targets.length === 0) return null;
  const problems = targets.flatMap((target) => {
    const state = workout.exports?.[target];
    return state?.error ? [`${EXPORT_TARGET_TITLES[target]}: ${state.error}`] : [];
  });

  return (
    <Section title="Sent to" footer={problems.length > 0 && <span className="error-text">{problems.join(' ')}</span>}>
      {targets.map((target) => {
        const state = workout.exports?.[target];
        const name = EXPORT_TARGET_TITLES[target];
        return (
          <div key={target} className="row">
            <span className="grow">
              {name}
              {state && <span className="sub">{EXPORT_STATUS[state.status]}</span>}
            </span>
            {busy.has(`${workout.id}:${target}`) ? <Spinner /> : (
              <>
                {state?.status === 'sent' && state.url && (
                  <a className="bar-button small" href={state.url} target="_blank" rel="noreferrer" aria-label={`Open on ${name}`}>Open</a>
                )}
                {state?.status !== 'sent' && status?.[target].connected && (
                  <button className="bar-button small" onClick={() => void sendWorkout(workout.id, target)}>
                    {state ? 'Try Again' : `Send to ${name}`}
                  </button>
                )}
              </>
            )}
          </div>
        );
      })}
    </Section>
  );
}

/** A finished workout in full, with the button to do it again. */
export function WorkoutDetail({ state, workout }: { state: AppState; workout: Workout }) {
  const { unit, effort } = state.settings;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const seconds = durationSeconds(workout);
  const volume = volumeKg(workout);
  const known = useMemo(() => new Map(state.exercises.map((exercise) => [exercise.id, exercise])), [state.exercises]);

  return (
    <Page
      title={workout.name}
      back="/history"
      trailing={
        <Menu
          className="bar-button"
          label="Workout options"
          items={[{ label: 'Delete Workout', destructive: true, run: () => setConfirmDelete(true) }]}
        >
          <Ellipsis size={24} aria-hidden />
        </Menu>
      }
    >
      <Section>
        <ValueRow label="Date" value={fmtDateTime(workout.startedAt)} />
        {seconds >= 60 && <ValueRow label="Duration" value={fmtDuration(seconds)} />}
        <ValueRow label="Sets" value={doneSets(workout).length} />
        {volume > 0 && <ValueRow label="Volume" value={`${fmtNumber(fromKg(unit, volume), 0)} ${unit}`} />}
        {workout.notes && <div className="row secondary prewrap">{workout.notes}</div>}
      </Section>

      {workout.entries.map((entry) => {
        const labels = rowLabels(entry.sets);
        const exercise = entry.exerciseId !== null ? known.get(entry.exerciseId) : undefined;
        return (
          <Section
            key={entry.id}
            title={exercise ? <Link to={`/exercises/${entry.exerciseId}`}>{entry.exerciseName}</Link> : entry.exerciseName}
            aside={takesDumbbells(exercise) && <DumbbellToggle workoutId={workout.id} entry={entry} />}
            footer={entry.notes}
          >
            {entry.sets.map((set, index) => (
              <div key={set.id} className="row numeric">
                <span className={set.isWarmup ? 'warm small' : 'secondary small'} style={{ width: 20, fontWeight: 600 }}>
                  {labels[index]}
                </span>
                <span>{setText(set, unit)}</span>
                {set.rpe !== null && <span className="row-value small">{effortLabel(effort, set.rpe)}</span>}
              </div>
            ))}
          </Section>
        );
      })}

      <Sharing workout={workout} />

      <div className="bottom-bar">
        <button className="btn btn-primary" onClick={() => requestStart({ kind: 'repeat', workoutId: workout.id })}>
          <RotateCw size={20} aria-hidden />
          Repeat Workout
        </button>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title="Delete this workout?"
          actions={[{
            label: 'Delete Workout',
            destructive: true,
            run: () => {
              update((draft) => deleteWorkout(draft, workout.id));
              goBack('/history');
            },
          }]}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </Page>
  );
}
