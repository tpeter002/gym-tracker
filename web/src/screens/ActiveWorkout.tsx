import { Check, ChevronDown, CirclePlus, Ellipsis, Plus, SquarePlay } from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { queueExports, sendWaiting } from '../lib/exports';
import { liftRanks, rankUps } from '../lib/ranks';
import type { LiftRank, RankUp } from '../lib/ranks';
import { goBack, navigate } from '../lib/router';
import { update } from '../lib/store';
import { toTryFor } from '../lib/suggestions';
import type { AppState, EffortScale, Exercise, SetEntry, WeightUnit, Workout, WorkoutEntry } from '../lib/types';
import { effortChoices, effortText, effortTitle, effortValue, fmtNumber, fromKg, rpeFrom, toKg } from '../lib/units';
import {
  addExercise, addSet, deleteSet, deleteWorkout, finishWorkout, hasCompletedSets, hasOpenSets,
  moveEntry, previousSets, removeEntry, rowLabels, updateSet,
} from '../lib/workouts';
import { webLink } from '../lib/videos';
import { DecimalField, IntegerField } from '../ui/controls';
import { Page, Section } from '../ui/layout';
import { ConfirmDialog, Menu } from '../ui/overlays';
import { ElapsedTime, ExerciseLabel } from '../ui/parts';
import { RankBadge, RankUpToast } from '../ui/RankBadge';
import { ExercisePicker } from './ExercisePicker';

/** How many fitting to-try exercises the workout lists before pointing at the picker. */
const TO_TRY_SHOWN = 3;
/** A rank has to hold this long before it is celebrated, so typing "100" isn't three rank-ups. */
const RANK_SETTLE = 600; // milliseconds

/**
 * Ranks as they stand with this workout's ticked sets counted, and the climb to
 * celebrate when one of them rises while the page is open.
 */
function useLiveRanks(state: AppState): { ranks: Map<string, LiftRank>; rankUp: RankUp | null; dismiss: () => void } {
  const ranks = useMemo(
    () => liftRanks(state, { includeActive: true }),
    [state.workouts, state.exercises, state.bodyWeights, state.settings.rankStandards],
  );
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
    }, RANK_SETTLE);
    return () => clearTimeout(timer);
  }, [ranks]);

  const dismiss = useCallback(() => setRankUp(null), []);
  return { ranks: useMemo(() => new Map(ranks.map((rank) => [rank.exercise.id, rank])), [ranks]), rankUp, dismiss };
}

/**
 * The in-progress workout: exercises, their sets, and the finish / discard flow.
 * Leaving the page only minimises it; the workout keeps running.
 */
export function ActiveWorkout({ state, workout }: { state: AppState; workout: Workout }) {
  const [showPicker, setShowPicker] = useState(false);
  const [question, setQuestion] = useState<'finish' | 'discard' | 'nothing' | null>(null);
  const exercises = useMemo(() => new Map(state.exercises.map((exercise) => [exercise.id, exercise])), [state.exercises]);
  // Saved-video exercises that suit what is being trained today, so they aren't forgotten again.
  const toTry = useMemo(() => toTryFor(state, workout), [state.exercises, workout.entries]);
  const { ranks, rankUp, dismiss } = useLiveRanks(state);
  const edit = (change: (draft: Workout) => void) =>
    update((draft) => {
      const current = draft.workouts.find((candidate) => candidate.id === workout.id);
      if (current) change(current);
    });

  const finish = () => {
    update((draft) => {
      finishWorkout(draft, workout.id);
      queueExports(draft, workout.id); // for the services set to get workouts automatically
    });
    void sendWaiting();
    navigate('/history', { replace: true });
  };

  const requestFinish = () => {
    if (!hasCompletedSets(workout)) setQuestion('nothing');
    else if (hasOpenSets(workout)) setQuestion('finish');
    else finish();
  };

  return (
    <Page
      title={workout.name || 'Workout'}
      heading={<ElapsedTime since={workout.startedAt} />}
      leading={
        <button className="bar-button" aria-label="Minimise" onClick={() => goBack('/')}>
          <ChevronDown size={24} aria-hidden />
        </button>
      }
      trailing={<button className="bar-button strong" onClick={requestFinish}>Finish</button>}
    >
      <section className="section">
        <div className="card">
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
              className="field small"
              aria-label="Notes"
              placeholder="Notes"
              rows={1}
              value={workout.notes}
              onChange={(event) => edit((draft) => { draft.notes = event.target.value; })}
            />
          </div>
        </div>
      </section>

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
          previous={entry.exerciseId ? previousSets(state.workouts, entry.exerciseId) : []}
          rank={entry.exerciseId ? ranks.get(entry.exerciseId) : undefined}
          isFirst={index === 0}
          isLast={index === workout.entries.length - 1}
          unit={state.settings.unit}
          effort={state.settings.effort}
        />
      ))}

      <button className="btn btn-tinted spaced" onClick={() => setShowPicker(true)}>
        <Plus size={20} aria-hidden />
        Add Exercise
      </button>

      <section className="section">
        <div className="card">
          <button className="row destructive" onClick={() => setQuestion('discard')}>Discard Workout</button>
        </div>
      </section>

      {rankUp && <RankUpToast up={rankUp} onDone={dismiss} />}

      {showPicker && (
        <ExercisePicker
          state={state}
          onClose={() => setShowPicker(false)}
          onAdd={(ids) => update((draft) => ids.forEach((id) => addExercise(draft, workout.id, id)))}
        />
      )}
      {question === 'finish' && (
        <ConfirmDialog
          title="Finish workout?"
          message="Sets you haven't ticked off won't be saved."
          actions={[{ label: 'Finish', run: finish }]}
          cancelLabel="Keep Going"
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
              navigate('/', { replace: true });
            },
          }]}
          cancelLabel="Keep Going"
          onClose={() => setQuestion(null)}
        />
      )}
      {question === 'nothing' && (
        <ConfirmDialog
          title="Nothing logged yet"
          message="Tick off at least one set to finish, or discard the workout."
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
  /** The sets logged the last time this exercise was done. */
  previous: SetEntry[];
  /** Where the lift stands, counting this workout's ticked sets. */
  rank: LiftRank | undefined;
  isFirst: boolean;
  isLast: boolean;
  unit: WeightUnit;
  effort: EffortScale;
}

/** One exercise block inside the active workout. */
function EntrySection({ workoutId, entry, exercise, previous, rank, isFirst, isLast, unit, effort }: EntryProps) {
  const labels = rowLabels(entry.sets);
  return (
    <section className="section" aria-label={entry.exerciseName}>
      <div className="card">
        <div className="entry-header">
          <div className="grow">
            <h2>{entry.exerciseName}</h2>
            {exercise?.notes && <p className="caption secondary prewrap">{exercise.notes}</p>}
          </div>
          {rank && <RankBadge rank={rank} size={30} />}
          {webLink(exercise?.videoURL ?? null) && (
            <a className="icon-button" href={exercise!.videoURL!} target="_blank" rel="noreferrer" aria-label="Watch video">
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
          />
        ))}
        <button className="row add-set" onClick={() => update((draft) => addSet(draft, workoutId, entry.id))}>
          <Plus size={16} aria-hidden />
          Add Set
        </button>
      </div>
    </section>
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
}

const SetRow = memo(function SetRow({ workoutId, entryId, set, label, previous, unit, effort }: SetRowProps) {
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
  const reps = previous.reps === null ? '–' : String(previous.reps);
  const main = previous.weight === null ? `${reps} reps` : `${fmtNumber(fromKg(unit, previous.weight))} ${unit} × ${reps}`;
  return previous.rpe === null ? [main] : [main, `@${effortText(effort, previous.rpe)}`];
}
