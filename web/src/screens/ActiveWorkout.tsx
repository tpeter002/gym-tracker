import { Check, ChevronDown, CirclePlus, Ellipsis, Plus, SquarePlay } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { queueExports, sendWaiting } from '../lib/exports';
import { rankUps } from '../lib/ranks';
import type { LiftRank, RankUp } from '../lib/ranks';
import { skipRest, startRest } from '../lib/rest';
import { goBack, navigate } from '../lib/router';
import { getState, update } from '../lib/store';
import { RANK_SETTLE_MS } from '../lib/timing';
import { toTryFor } from '../lib/suggestions';
import type { AppState, EffortScale, Exercise, SetEntry, WeightUnit, Workout, WorkoutEntry } from '../lib/types';
import { EXPORT_TARGET_TITLES, EXPORT_TARGETS } from '../lib/types';
import {
  effortChoices, effortText, effortTitle, effortValue, fmtNumber, fromDateTimeInputValue, fromKg, rpeFrom, setText,
  toDateTimeInputValue, toKg,
} from '../lib/units';
import {
  addExercise, addSet, deleteSet, deleteWorkout, finishEditing, finishWorkout, hasCompletedSets, hasOpenSets,
  moveEntry, previousSets, removeEntry, restoreWorkout, rowLabels, setWorkoutTimes, takesDumbbells, updateSet,
} from '../lib/workouts';
import { webLink } from '../lib/videos';
import { DecimalField, IntegerField } from '../ui/controls';
import { Page, Section } from '../ui/layout';
import { ConfirmDialog, Menu } from '../ui/overlays';
import { DumbbellToggle, ElapsedTime, ExerciseLabel } from '../ui/parts';
import { RankBadge, RankUpToast } from '../ui/RankBadge';
import { RestChip } from '../ui/RestChip';
import { useLiftRanks } from '../ui/useLiftRanks';
import { ExercisePicker } from './ExercisePicker';

/** How many fitting to-try exercises the workout lists before pointing at the picker. */
const TO_TRY_SHOWN = 3;

/**
 * Ranks as they stand with this workout's ticked sets counted, and the climb to
 * celebrate when one of them rises while the page is open.
 */
function useLiveRanks(state: AppState): { ranks: Map<string, LiftRank>; rankUp: RankUp | null; dismiss: () => void } {
  const ranks = useLiftRanks(state, { includeActive: true });
  // What has been seen so far; whatever stands when the page opens is not news.
  const seen = useRef<LiftRank[] | null>(null);
  const [rankUp, setRankUp] = useState<RankUp | null>(null);

  useEffect(() => {
    if (seen.current === null) {
      seen.current = ranks;
      return;
    }
    const timer = setTimeout(() => {
      const [biggest] = rankUps(seen.current ?? [], ranks);
      // Only ever upwards: unticking a set and ticking it again is not a second climb.
      const known = new Map((seen.current ?? []).map((rank) => [rank.exercise.id, rank]));
      for (const rank of ranks) {
        const before = known.get(rank.exercise.id);
        if (!before || rank.step > before.step) known.set(rank.exercise.id, rank);
      }
      seen.current = [...known.values()];
      if (biggest) setRankUp(biggest);
    }, RANK_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [ranks]);

  const dismiss = useCallback(() => setRankUp(null), []);
  return { ranks: useMemo(() => new Map(ranks.map((rank) => [rank.exercise.id, rank])), [ranks]), rankUp, dismiss };
}

/**
 * A workout being logged: exercises, their sets, and the finish / discard flow.
 * Leaving the page only minimises it; the workout keeps running.
 *
 * With `editing` it is a finished workout opened again to put something right:
 * the same tools, Cancel and Done in place of Minimize and Finish, and its
 * start and end can be changed too.
 */
export function ActiveWorkout({ state, workout, editing = false }: { state: AppState; workout: Workout; editing?: boolean }) {
  const [showPicker, setShowPicker] = useState(false);
  const [question, setQuestion] = useState<'finish' | 'discard' | 'nothing' | null>(null);
  const exercises = useMemo(() => new Map(state.exercises.map((exercise) => [exercise.id, exercise])), [state.exercises]);
  // Saved-video exercises that suit what is being trained today, so they aren't forgotten again.
  const toTry = useMemo(() => (editing ? [] : toTryFor(state, workout)), [state.exercises, workout.entries, editing]);
  const { ranks, rankUp, dismiss } = useLiveRanks(state);
  const edit = (change: (draft: Workout) => void) =>
    update((draft) => {
      const current = draft.workouts.find((candidate) => candidate.id === workout.id);
      if (current) change(current);
    });

  // The workout as it was when the edit began, for Cancel. The state is never changed in place, so keeping it is enough.
  const original = useRef(workout);
  const cancelled = useRef(false);
  // Leaving by any road but Cancel ends the edit the way Done does, so a finished workout is never left with unticked sets.
  useEffect(() => {
    if (!editing) return;
    const id = workout.id;
    return () => {
      if (!cancelled.current) update((draft) => finishEditing(draft, id));
    };
  }, [editing, workout.id]);

  const finish = () => {
    if (editing) {
      update((draft) => finishEditing(draft, workout.id));
      navigate(`/history/${workout.id}`, { replace: true });
      return;
    }
    update((draft) => {
      finishWorkout(draft, workout.id);
      queueExports(draft, workout.id); // for the services set to get workouts automatically
    });
    skipRest();
    void sendWaiting();
    navigate('/history', { replace: true });
  };

  const cancel = () => {
    cancelled.current = true;
    update((draft) => restoreWorkout(draft, original.current));
    goBack(`/history/${workout.id}`);
  };

  const requestFinish = () => {
    if (!hasCompletedSets(workout)) setQuestion('nothing');
    else if (hasOpenSets(workout)) setQuestion('finish');
    else finish();
  };

  // Where the workout has gone already: the copy there doesn't follow an edit made here.
  const sentTo = EXPORT_TARGETS.filter((target) => workout.exports?.[target]?.status === 'sent').map((target) => EXPORT_TARGET_TITLES[target]);

  return (
    <Page
      title={editing ? 'Edit Workout' : workout.name || 'Workout'}
      heading={editing ? undefined : <ElapsedTime since={workout.startedAt} />}
      leading={editing ? (
        <button className="bar-button" onClick={cancel}>Cancel</button>
      ) : (
        <button className="bar-button" aria-label="Minimize" onClick={() => goBack('/')}>
          <ChevronDown size={24} aria-hidden />
        </button>
      )}
      trailing={
        <>
          {!editing && <RestChip settings={state.settings} />}
          <button className="bar-button strong" onClick={requestFinish}>{editing ? 'Done' : 'Finish'}</button>
        </>
      }
    >
      <Section footer={editing && sentTo.length > 0 && `Already sent to ${sentTo.join(' and ')}: what you change here stays in this app.`}>
        <div className="row">
          <input
            className="field title"
            aria-label="Workout name"
            placeholder="Workout name"
            value={workout.name}
            onChange={(event) => edit((draft) => { draft.name = event.target.value; })}
          />
        </div>
        <div className="row">
          <textarea
            className="field"
            aria-label="Notes"
            placeholder="Notes"
            rows={1}
            value={workout.notes}
            onChange={(event) => edit((draft) => { draft.notes = event.target.value; })}
          />
        </div>
        {editing && workout.endedAt !== null && (
          <>
            <label className="row">
              Started
              <input
                className="field"
                type="datetime-local"
                value={toDateTimeInputValue(workout.startedAt)}
                onChange={(event) => {
                  const startedAt = fromDateTimeInputValue(event.target.value);
                  if (startedAt !== null) update((draft) => setWorkoutTimes(draft, workout.id, { startedAt }));
                }}
              />
            </label>
            <label className="row">
              Finished
              <input
                className="field"
                type="datetime-local"
                min={toDateTimeInputValue(workout.startedAt + 60_000)}
                value={toDateTimeInputValue(workout.endedAt)}
                onChange={(event) => {
                  const endedAt = fromDateTimeInputValue(event.target.value);
                  if (endedAt !== null) update((draft) => setWorkoutTimes(draft, workout.id, { endedAt }));
                }}
              />
            </label>
          </>
        )}
      </Section>

      {toTry.length > 0 && (
        <Section
          title="To try today"
          footer={toTry.length > TO_TRY_SHOWN
            ? `From your saved videos; ${toTry.length - TO_TRY_SHOWN} more that fit are in the exercise picker.`
            : 'From your saved videos — they fit what you are training today.'}
        >
          {toTry.slice(0, TO_TRY_SHOWN).map((exercise) => (
            <div key={exercise.id} className="row split">
              <div className="row-main">
                <ExerciseLabel exercise={exercise} />
              </div>
              <button
                className="icon-button"
                aria-label={`Add ${exercise.name}`}
                onClick={() => update((draft) => addExercise(draft, workout.id, exercise.id))}
              >
                <CirclePlus size={26} aria-hidden />
              </button>
            </div>
          ))}
        </Section>
      )}

      {workout.entries.map((entry, index) => (
        <EntrySection
          key={entry.id}
          workoutId={workout.id}
          entry={entry}
          exercise={entry.exerciseId ? exercises.get(entry.exerciseId) : undefined}
          previous={entry.exerciseId
            ? previousSets(state.workouts, entry.exerciseId, entry.bothDumbbells === true, editing ? workout.startedAt : undefined)
            : []}
          rank={entry.exerciseId ? ranks.get(entry.exerciseId) : undefined}
          isFirst={index === 0}
          isLast={index === workout.entries.length - 1}
          unit={state.settings.unit}
          effort={state.settings.effort}
          rests={!editing}
        />
      ))}

      <button className="btn btn-tinted spaced" onClick={() => setShowPicker(true)}>
        <Plus size={20} aria-hidden />
        Add Exercise
      </button>

      {!editing && (
        <Section>
          <button className="row destructive" onClick={() => setQuestion('discard')}>Discard Workout</button>
        </Section>
      )}

      {/* Putting an old number right is not an achievement to celebrate. */}
      {rankUp && !editing && <RankUpToast up={rankUp} onDone={dismiss} />}

      {showPicker && (
        <ExercisePicker
          state={state}
          onClose={() => setShowPicker(false)}
          onAdd={(ids) => update((draft) => ids.forEach((id) => addExercise(draft, workout.id, id)))}
        />
      )}
      {question === 'finish' && (
        <ConfirmDialog
          title={editing ? 'Save the changes?' : 'Finish workout?'}
          message={editing ? "Sets you haven't ticked off will be removed." : "Sets you haven't ticked off won't be saved."}
          actions={[{ label: editing ? 'Save' : 'Finish', run: finish }]}
          cancelLabel={editing ? 'Keep Editing' : 'Keep Going'}
          onClose={() => setQuestion(null)}
        />
      )}
      {question === 'discard' && (
        <ConfirmDialog
          title="Discard this workout?"
          message="Everything logged in it will be lost."
          actions={[{
            label: 'Discard Workout',
            destructive: true,
            run: () => {
              update((draft) => deleteWorkout(draft, workout.id));
              skipRest();
              navigate('/', { replace: true });
            },
          }]}
          cancelLabel="Keep Going"
          onClose={() => setQuestion(null)}
        />
      )}
      {question === 'nothing' && (
        <ConfirmDialog
          title={editing ? 'Nothing left in this workout' : 'Nothing logged yet'}
          message={editing
            ? 'A workout needs at least one ticked set. Tick one, or cancel and delete the workout from its page.'
            : 'Tick off at least one set to finish, or discard the workout.'}
          cancelLabel="OK"
          onClose={() => setQuestion(null)}
        />
      )}
    </Page>
  );
}

interface EntryProps {
  workoutId: string;
  entry: WorkoutEntry;
  exercise: Exercise | undefined;
  /** The sets logged the last time this exercise was done, with dumbbells counted the way this entry counts them. */
  previous: SetEntry[];
  /** Where the lift stands, counting this workout's ticked sets. */
  rank: LiftRank | undefined;
  isFirst: boolean;
  isLast: boolean;
  unit: WeightUnit;
  effort: EffortScale;
  /** Whether ticking a set starts the rest timer: while logging, not while correcting an old workout. */
  rests: boolean;
}

/** One exercise block inside the active workout. */
function EntrySection({ workoutId, entry, exercise, previous, rank, isFirst, isLast, unit, effort, rests }: EntryProps) {
  const labels = rowLabels(entry.sets);
  const video = webLink(exercise?.videoURL ?? null);
  return (
    <Section label={entry.exerciseName}>
      <div className="entry-header">
        <div className="grow">
          <h2>{entry.exerciseName}</h2>
          {takesDumbbells(exercise) && <DumbbellToggle workoutId={workoutId} entry={entry} />}
          {exercise?.notes && <p className="caption secondary prewrap">{exercise.notes}</p>}
        </div>
        {rank && <RankBadge rank={rank} size={30} />}
        {video && (
          <a className="icon-button" href={video} target="_blank" rel="noreferrer" aria-label="Watch video">
            <SquarePlay size={22} aria-hidden />
          </a>
        )}
        <Menu
          className="icon-button"
          label={`${entry.exerciseName} options`}
          items={[
            { label: 'Move Up', disabled: isFirst, run: () => update((draft) => moveEntry(draft, workoutId, entry.id, -1)) },
            { label: 'Move Down', disabled: isLast, run: () => update((draft) => moveEntry(draft, workoutId, entry.id, 1)) },
            { label: 'Remove Exercise', destructive: true, run: () => update((draft) => removeEntry(draft, workoutId, entry.id)) },
          ]}
        >
          <Ellipsis size={22} aria-hidden />
        </Menu>
      </div>

      <div className="set-grid set-head" aria-hidden>
        <span>Set</span>
        <span>Previous</span>
        <span>{unit}</span>
        <span>Reps</span>
        <span>{effortTitle(effort)}</span>
        <Check size={14} />
      </div>
      {entry.sets.map((set, index) => (
        <SetRow
          key={set.id}
          workoutId={workoutId}
          entryId={entry.id}
          set={set}
          label={labels[index]}
          previous={previous[index]}
          unit={unit}
          effort={effort}
          rests={rests}
        />
      ))}
      <button className="row add-set" onClick={() => update((draft) => addSet(draft, workoutId, entry.id))}>
        <Plus size={16} aria-hidden />
        Add Set
      </button>
    </Section>
  );
}

interface SetRowProps {
  workoutId: string;
  entryId: string;
  set: SetEntry;
  label: string;
  /** The matching set from the last time this exercise was done. */
  previous: SetEntry | undefined;
  unit: WeightUnit;
  effort: EffortScale;
  rests: boolean;
}

const SetRow = memo(function SetRow({ workoutId, entryId, set, label, previous, unit, effort, rests }: SetRowProps) {
  const repsField = useRef<HTMLInputElement>(null);
  const change = (patch: Partial<SetEntry>) => update((draft) => updateSet(draft, workoutId, entryId, set.id, patch));

  /**
   * Ticking an empty row takes over last time's numbers, so repeating a
   * workout is one tap per set when nothing changed.
   */
  const toggleDone = () => {
    if (set.isDone) return change({ isDone: false });
    const weight = set.weight === null && set.reps === null && previous ? previous.weight : set.weight;
    const reps = set.reps ?? previous?.reps ?? null;
    if (reps === null) return repsField.current?.focus(); // nothing to log yet
    change({ weight, reps, isDone: true });
    if (rests) startRest(getState().settings);
  };

  const shownEffort = set.rpe === null ? null : effortValue(effort, set.rpe);
  const choices = effortChoices(effort);

  return (
    <div className={set.isDone ? 'set-grid set-row done' : 'set-grid set-row'}>
      <Menu
        className={set.isWarmup ? 'cell set-label warm' : 'cell set-label'}
        label={set.isWarmup ? 'Warm-up set options' : `Set ${label} options`}
        items={[
          { label: 'Warm-up Set', checked: set.isWarmup, run: () => change({ isWarmup: !set.isWarmup }) },
          { label: 'Delete Set', destructive: true, run: () => update((draft) => deleteSet(draft, workoutId, entryId, set.id)) },
        ]}
      >
        {label}
      </Menu>

      <button
        className="previous"
        disabled={!previous}
        aria-label={previous ? `Use last time's numbers: ${previousText(previous, unit, effort).join(' ')}` : 'No previous set'}
        onClick={() => previous && change({ weight: previous.weight, reps: previous.reps })}
      >
        {previous ? previousText(previous, unit, effort).map((part) => <span key={part}>{part}&nbsp;</span>) : '–'}
      </button>

      <DecimalField
        className="cell"
        label="Weight"
        placeholder={previous?.weight != null ? fmtNumber(fromKg(unit, previous.weight)) : '–'}
        value={set.weight === null ? null : fromKg(unit, set.weight)}
        onChange={(value) => change({ weight: value === null ? null : toKg(unit, value) })}
        onEnter={() => !set.isDone && toggleDone()}
      />
      <IntegerField
        ref={repsField}
        className="cell"
        label="Reps"
        placeholder={previous?.reps != null ? String(previous.reps) : '–'}
        value={set.reps}
        onChange={(reps) => change({ reps })}
        onEnter={() => !set.isDone && toggleDone()}
      />

      <select
        className={set.rpe === null ? 'cell unset' : 'cell'}
        aria-label={effortTitle(effort)}
        value={shownEffort === null ? '' : String(shownEffort)}
        onChange={(event) => change({ rpe: event.target.value === '' ? null : rpeFrom(effort, Number(event.target.value)) })}
      >
        <option value="">–</option>
        {/* A value logged in the other scale may fall outside this scale's choices. */}
        {shownEffort !== null && !choices.includes(shownEffort) && (
          <option value={String(shownEffort)}>{effortText(effort, set.rpe!)}</option>
        )}
        {choices.map((choice) => <option key={choice} value={String(choice)}>{fmtNumber(choice, 1)}</option>)}
      </select>

      <button
        className="cell check"
        aria-pressed={set.isDone}
        aria-label={set.isDone ? 'Mark set as not done' : 'Mark set as done'}
        onClick={toggleDone}
      >
        <Check size={18} strokeWidth={3} aria-hidden />
      </button>
    </div>
  );
});

/** "80 kg × 8" and, if effort was logged, "@8.5" — two parts so a narrow column can wrap between them. */
function previousText(previous: SetEntry, unit: WeightUnit, effort: EffortScale): string[] {
  const main = setText(previous, unit);
  return previous.rpe === null ? [main] : [main, `@${effortText(effort, previous.rpe)}`];
}
