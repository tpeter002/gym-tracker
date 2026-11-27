import { CirclePlus, Ellipsis, Plus, SquarePlay } from 'lucide-react';
import { useMemo, useState } from 'react';
import { deleteExercise, searchExercises } from '../lib/exercises';
import { describeLift, rankSetup, rankTitle, standardFor } from '../lib/ranks';
import { goBack } from '../lib/router';
import { update } from '../lib/store';
import { equipmentTitle, muscleTitle } from '../lib/types';
import type { AppState, Exercise, MuscleGroup } from '../lib/types';
import { effortLabel, fmtDate, fromKg, setText, weightText } from '../lib/units';
import { webLink } from '../lib/videos';
import { dumbbellWeight, estimatedOneRepMax, sessionsFor, takesDumbbells } from '../lib/workouts';
import { LineChart } from '../ui/Chart';
import { MuscleFilterBar, SearchField, Switch } from '../ui/controls';
import { Link, LinkRow, Page, Section, ValueRow } from '../ui/layout';
import { ConfirmDialog, Menu } from '../ui/overlays';
import { DumbbellToggle, ExerciseLabel } from '../ui/parts';
import { RankBadge, RankProgress } from '../ui/RankBadge';
import { useLiftRanks } from '../ui/useLiftRanks';
import { ExerciseEditor } from './ExerciseEditor';

/** The exercise library: built-ins plus your own, searchable. */
export function Exercises({ state }: { state: AppState }) {
  const [query, setQuery] = useState('');
  const [muscle, setMuscle] = useState<MuscleGroup | null>(null);
  const [showEditor, setShowEditor] = useState(false);
  const trimmed = query.trim();
  const results = useMemo(() => searchExercises(state.exercises, query, muscle), [state.exercises, query, muscle]);
  const ranked = useLiftRanks(state);
  const ranks = useMemo(() => new Map(ranked.map((rank) => [rank.exercise.id, rank])), [ranked]);

  return (
    <Page
      title="Exercises"
      large
      trailing={
        <button className="icon-button" aria-label="New exercise" onClick={() => setShowEditor(true)}>
          <Plus size={24} aria-hidden />
        </button>
      }
    >
      <SearchField value={query} onChange={setQuery} placeholder="Search exercises" />
      <MuscleFilterBar value={muscle} onChange={setMuscle} />

      {(results.length > 0 || trimmed !== '') && (
        <div className="card">
          {results.map((exercise) => (
            <LinkRow key={exercise.id} to={`/exercises/${exercise.id}`}>
              <ExerciseLabel exercise={exercise} />
              {ranks.has(exercise.id) && <RankBadge rank={ranks.get(exercise.id)!} size={30} />}
            </LinkRow>
          ))}
          {/* "Not found" is the moment you want to add your own. */}
          {trimmed !== '' && (
            <button className="row accent" onClick={() => setShowEditor(true)}>
              <CirclePlus size={22} aria-hidden />
              Create “{trimmed}”
            </button>
          )}
        </div>
      )}
      {results.length === 0 && trimmed === '' && <p className="chart-note">Nothing in this muscle group yet.</p>}

      {showEditor && (
        <ExerciseEditor state={state} suggestedName={trimmed} onClose={() => setShowEditor(false)} onSaved={() => setQuery('')} />
      )}
    </Page>
  );
}

/** One exercise: where it came from, your records and every time you did it. */
export function ExerciseDetail({ state, exercise }: { state: AppState; exercise: Exercise }) {
  const { unit, effort } = state.settings;
  const [showEditor, setShowEditor] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const sessions = useMemo(() => sessionsFor(state.workouts, exercise.id), [state.workouts, exercise.id]);
  const hasDumbbells = takesDumbbells(exercise);
  // Dumbbell sessions may have been typed in either way; records and the chart
  // read them all the way the latest one was, so the numbers can be compared.
  const showBoth = hasDumbbells && sessions[0]?.entry.bothDumbbells === true;
  const working = sessions.map((session) => ({
    time: session.workout.startedAt,
    sets: session.entry.sets
      .filter((set) => set.isDone && !set.isWarmup)
      .map((set) => ({ ...set, weight: dumbbellWeight(set.weight, session.entry.bothDumbbells === true, showBoth) })),
  }));
  const workingSets = working.flatMap((session) => session.sets);
  const best = (values: (number | null)[]) => {
    const numbers = values.filter((value): value is number => value !== null);
    return numbers.length > 0 ? Math.max(...numbers) : null;
  };
  const heaviest = best(workingSets.map((set) => set.weight));
  const oneRepMax = best(workingSets.map(estimatedOneRepMax));
  const mostReps = best(workingSets.map((set) => set.reps));

  // Heaviest working set per session — at the same weight, the one with more reps — oldest first.
  const topSets = working
    .flatMap(({ time, sets }) => {
      const top = sets
        .filter((set): set is typeof set & { weight: number } => set.weight !== null)
        .reduce<{ weight: number; reps: number | null } | null>(
          (found, set) => (!found || set.weight > found.weight || (set.weight === found.weight && (set.reps ?? 0) > (found.reps ?? 0)) ? set : found),
          null,
        );
      return top ? [{ time, kg: top.weight, reps: top.reps }] : [];
    })
    .reverse();
  const video = webLink(exercise.videoURL);
  const rank = useLiftRanks(state).find((candidate) => candidate.exercise.id === exercise.id);
  const rankWords = rank && describeLift(rank, unit);
  const canBeRanked = standardFor(exercise) !== null;

  return (
    <Page
      title={exercise.name}
      back="/exercises"
      trailing={
        <Menu
          className="bar-button"
          label="Exercise options"
          items={[
            { label: 'Edit', run: () => setShowEditor(true) },
            { label: 'Delete Exercise', destructive: true, run: () => setConfirmDelete(true) },
          ]}
        >
          <Ellipsis size={24} aria-hidden />
        </Menu>
      }
    >
      <Section footer="Exercises marked “Want to try” are listed first when you add exercises to a workout.">
        <ValueRow label="Muscle group" value={muscleTitle(exercise.muscle)} />
        <ValueRow label="Equipment" value={equipmentTitle(exercise.equipment)} />
        {video && (
          <a className="row accent" href={video} target="_blank" rel="noreferrer">
            <SquarePlay size={22} aria-hidden />
            Watch Video
          </a>
        )}
        <Switch
          label="Want to try"
          checked={exercise.wantToTry}
          onChange={(wantToTry) => update((draft) => {
            const target = draft.exercises.find((candidate) => candidate.id === exercise.id);
            if (target) target.wantToTry = wantToTry;
          })}
        />
      </Section>

      {exercise.notes && (
        <Section title="Notes">
          <div className="row prewrap">{exercise.notes}</div>
        </Section>
      )}

      {rank && rankWords && (
        <Section title="Rank">
          <Link to="/ranks" className="row">
            <RankBadge rank={rank} size={56} decorative />
            <span className="grow" data-tier={rank.tier}>
              <span className="title-line strong">{rankTitle(rank)}</span>
              <span className="sub">{rankWords.best}</span>
              <RankProgress rank={rank} />
              {rankWords.next && <span className="sub">{rankWords.next}</span>}
            </span>
          </Link>
        </Section>
      )}
      {!rank && canBeRanked && workingSets.length > 0 && state.settings.rankStandards !== '' && (
        <Section title="Rank">
          <LinkRow to="/ranks">
            {rankSetup(state) ? 'Not ranked yet — it takes a set with weight' : 'Log your body weight to see where this lift stands'}
          </LinkRow>
        </Section>
      )}

      {workingSets.length > 0 && (
        <Section title="Records">
          {heaviest !== null && <ValueRow label="Heaviest weight" value={weightText(unit, heaviest)} />}
          {oneRepMax !== null && <ValueRow label="Estimated 1RM" value={weightText(unit, oneRepMax)} />}
          {mostReps !== null && <ValueRow label="Most reps" value={mostReps} />}
          <ValueRow label="Sessions" value={sessions.length} />
        </Section>
      )}
      {workingSets.length > 0 && hasDumbbells && sessions.some((session) => (session.entry.bothDumbbells === true) !== showBoth) && (
        <p className="section-footer">
          Some sessions count {showBoth ? 'one dumbbell' : 'both dumbbells'}; records and the chart show them as {showBoth ? 'both dumbbells together' : 'one dumbbell'}, like your latest session.
        </p>
      )}

      {topSets.length > 1 && (
        <Section title={`Top set · ${unit}`}>
          <div className="chart-block">
            <LineChart
              label={`Heaviest set of ${exercise.name} per session`}
              unit={unit}
              points={topSets.map((point) => ({
                time: point.time,
                value: fromKg(unit, point.kg),
                note: point.reps === null ? undefined : `× ${point.reps}`,
              }))}
            />
          </div>
        </Section>
      )}

      {sessions.length === 0 && (
        <Section title="History">
          <div className="row secondary">You haven't done this exercise yet.</div>
        </Section>
      )}
      {sessions.map(({ workout, entry }) => (
        <Section
          key={entry.id}
          title={`${fmtDate(workout.startedAt)} · ${workout.name}`}
          aside={hasDumbbells && <DumbbellToggle workoutId={workout.id} entry={entry} />}
        >
          {entry.sets.filter((set) => set.isDone).map((set) => (
            <div key={set.id} className="row numeric">
              <span>{setText(set, unit)}</span>
              {set.isWarmup && <span className="warm caption">warm-up</span>}
              {set.rpe !== null && <span className="row-value small">{effortLabel(effort, set.rpe)}</span>}
            </div>
          ))}
        </Section>
      ))}

      {showEditor && <ExerciseEditor state={state} exercise={exercise} onClose={() => setShowEditor(false)} />}
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete “${exercise.name}”?`}
          message={sessions.length === 0
            ? 'It will be removed from your exercise list.'
            : "Past workouts keep their sets, but this exercise's records and history page go away."}
          actions={[{
            label: 'Delete Exercise',
            destructive: true,
            run: () => {
              update((draft) => deleteExercise(draft, exercise.id));
              goBack('/exercises');
            },
          }]}
          onClose={() => setConfirmDelete(false)}
        />
      )}
    </Page>
  );
}
