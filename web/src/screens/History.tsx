import { Ellipsis, History as HistoryIcon, RotateCw, TrendingUp } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { requestStart } from '../lib/actions';
import { connections, loadConnections, sending, sendWorkout } from '../lib/exports';
import { rankTitle } from '../lib/ranks';
import { goBack, navigate } from '../lib/router';
import { useSignal } from '../lib/signal';
import { update } from '../lib/store';
import { EXPORT_TARGET_TITLES, EXPORT_TARGETS } from '../lib/types';
import type { AppState, Workout } from '../lib/types';
import { effortLabel, fmtCount, fmtDate, fmtDateTime, fmtDuration, fmtMonthYear, fmtNumber, fromKg, setText } from '../lib/units';
import { webLink } from '../lib/videos';
import { deleteWorkout, doneSets, durationSeconds, finishedWorkouts, removeRoutine, ROUTINE_NAME_MAX, rowLabels, saveAsRoutine, takesDumbbells, volumeKg } from '../lib/workouts';
import { EmptyState, Link, Page, Section, ValueRow } from '../ui/layout';
import { Spinner } from '../ui/controls';
import { ConfirmDialog, Menu, Sheet } from '../ui/overlays';
import { DumbbellToggle, WorkoutRow } from '../ui/parts';
import { RankBadge } from '../ui/RankBadge';
import { useLiftRanks } from '../ui/useLiftRanks';

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
        // The address is the analyzer's word for it; only a web address becomes a link.
        const link = state?.status === 'sent' ? webLink(state.url ?? null) : null;
        return (
          <div key={target} className="row">
            <span className="grow">
              {name}
              {state && <span className="sub">{EXPORT_STATUS[state.status]}</span>}
            </span>
            {busy.has(`${workout.id}:${target}`) ? <Spinner /> : (
              <>
                {link && (
                  <a className="bar-button small" href={link} target="_blank" rel="noreferrer" aria-label={`Open on ${name}`}>Open</a>
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
  const [namingRoutine, setNamingRoutine] = useState(false);
  const seconds = durationSeconds(workout);
  const volume = volumeKg(workout);
  const known = useMemo(() => new Map(state.exercises.map((exercise) => [exercise.id, exercise])), [state.exercises]);
  // Each lift's rank as it stood once this workout was done, and just before it — the difference is what the workout earned.
  const ranksAfter = useLiftRanks(state, { until: workout.startedAt });
  const ranksUntil = useLiftRanks(state, { until: workout.startedAt - 1 });
  const [ranks, ranksBefore] = useMemo(
    () => [ranksAfter, ranksUntil].map((list) => new Map(list.map((rank) => [rank.exercise.id, rank]))),
    [ranksAfter, ranksUntil],
  );

  return (
    <Page
      title={workout.name}
      back="/history"
      trailing={
        <Menu
          className="bar-button"
          label="Workout options"
          items={[
            { label: 'Edit Workout', run: () => navigate(`/history/${workout.id}/edit`) },
            { label: workout.routine ? 'Rename Routine…' : 'Save as Routine…', run: () => setNamingRoutine(true) },
            ...(workout.routine ? [{ label: 'Remove from Routines', run: () => update((draft) => removeRoutine(draft, workout.id)) }] : []),
            { label: 'Delete Workout', destructive: true, run: () => setConfirmDelete(true) },
          ]}
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
        {workout.routine && <ValueRow label="Routine" value={workout.routine} />}
        {workout.notes && <div className="row secondary prewrap">{workout.notes}</div>}
      </Section>

      {workout.entries.map((entry) => {
        // Only ticked sets count; an edit that was interrupted may have left others behind.
        const sets = entry.sets.filter((set) => set.isDone);
        const labels = rowLabels(sets);
        const exercise = entry.exerciseId !== null ? known.get(entry.exerciseId) : undefined;
        const rank = exercise && ranks.get(exercise.id);
        const before = exercise && ranksBefore.get(exercise.id);
        const rose = rank && (!before || rank.step > before.step);
        return (
          <Section
            key={entry.id}
            title={exercise ? <Link to={`/exercises/${entry.exerciseId}`}>{entry.exerciseName}</Link> : entry.exerciseName}
            aside={takesDumbbells(exercise) && <DumbbellToggle workoutId={workout.id} entry={entry} />}
            footer={entry.notes}
          >
            {rank && (
              <div className="row rank-line">
                <RankBadge rank={rank} size={30} decorative />
                <span className="grow">{rankTitle(rank)}</span>
                {rose && (
                  <span className="rank-rise">
                    <TrendingUp size={15} aria-hidden />
                    {before ? `Up from ${rankTitle(before)}` : 'First rank'}
                  </span>
                )}
              </div>
            )}
            {sets.map((set, index) => (
              <div key={set.id} className="row numeric">
                <span className={set.isWarmup ? 'set-number warm small' : 'set-number secondary small'}>{labels[index]}</span>
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

      {namingRoutine && <RoutineName state={state} workout={workout} onClose={() => setNamingRoutine(false)} />}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete this workout?"
          message={workout.routine ? `The routine “${workout.routine}” was saved from it and goes with it.` : undefined}
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

/** Names the routine a workout is kept as. A name already in use is taken over, and the sheet says so first. */
function RoutineName({ state, workout, onClose }: { state: AppState; workout: Workout; onClose: () => void }) {
  const [name, setName] = useState(workout.routine ?? workout.name);
  const trimmed = name.trim();
  const taken = state.workouts.find((other) => other.id !== workout.id && other.routine?.toLowerCase() === trimmed.toLowerCase());

  const save = () => {
    if (!trimmed) return;
    update((draft) => saveAsRoutine(draft, workout.id, trimmed));
    onClose();
  };

  return (
    <Sheet
      title={workout.routine ? 'Rename Routine' : 'Save as Routine'}
      onClose={onClose}
      trailing={<button className="bar-button strong" disabled={!trimmed} onClick={save}>Save</button>}
    >
      <Section
        footer={taken
          ? `“${taken.routine}” is saved from your workout of ${fmtDate(taken.startedAt)}. Saving moves it to this one.`
          : "A routine shows on the Workout tab with a Start button, which repeats this workout: the same exercises and sets, with last time's numbers to beat."}
      >
        <div className="row">
          <input
            className="field title"
            aria-label="Routine name"
            placeholder="Routine name"
            maxLength={ROUTINE_NAME_MAX}
            data-autofocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && save()}
          />
        </div>
      </Section>
    </Sheet>
  );
}
