import { Circle, CircleCheck, CirclePlus, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { byName, searchExercises } from '../lib/exercises';
import type { AppState, Exercise, MuscleGroup } from '../lib/types';
import { MuscleFilterBar, SearchField } from '../ui/controls';
import { Section } from '../ui/layout';
import { Sheet } from '../ui/overlays';
import { ExerciseLabel } from '../ui/parts';
import { ExerciseEditor } from './ExerciseEditor';

interface Props {
  state: AppState;
  onAdd: (exerciseIds: string[]) => void;
  onClose: () => void;
}

/**
 * Searchable multi-select list for adding exercises to a workout. Exercises
 * saved from videos but not tried yet sit on top so they don't get forgotten.
 */
export function ExercisePicker({ state, onAdd, onClose }: Props) {
  const [query, setQuery] = useState('');
  const [muscle, setMuscle] = useState<MuscleGroup | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [showEditor, setShowEditor] = useState(false);

  const trimmed = query.trim();
  const isBrowsing = trimmed === '' && muscle === null;
  const results = useMemo(() => searchExercises(state.exercises, query, muscle), [state.exercises, query, muscle]);
  const toTry = useMemo(() => state.exercises.filter((exercise) => exercise.wantToTry).sort(byName), [state.exercises]);

  const toggle = (id: string) =>
    setSelection((current) => (current.includes(id) ? current.filter((other) => other !== id) : [...current, id]));

  const row = (exercise: Exercise) => {
    const isSelected = selection.includes(exercise.id);
    return (
      <button key={exercise.id} className="row" aria-pressed={isSelected} onClick={() => toggle(exercise.id)}>
        <ExerciseLabel exercise={exercise} />
        {isSelected
          ? <CircleCheck className="row-icon" size={24} aria-hidden />
          : <Circle className="secondary" size={24} aria-hidden />}
      </button>
    );
  };

  return (
    <Sheet
      title="Add Exercise"
      tall
      onClose={onClose}
      trailing={
        <button className="bar-button" aria-label="New exercise" onClick={() => setShowEditor(true)}>
          <Plus size={24} aria-hidden />
        </button>
      }
      // Always in view, also while the keyboard is up — which is exactly when you pick.
      footer={selection.length > 0 && (
        <button
          className="btn btn-primary"
          onClick={() => {
            onAdd(selection);
            onClose();
          }}
        >
          {selection.length === 1 ? 'Add 1 Exercise' : `Add ${selection.length} Exercises`}
        </button>
      )}
    >
      <SearchField value={query} onChange={setQuery} placeholder="Search exercises" />
      <MuscleFilterBar value={muscle} onChange={setMuscle} />

      {isBrowsing && toTry.length > 0 && (
        <Section title="To try · from your videos">{toTry.map(row)}</Section>
      )}
      {(results.length > 0 || trimmed !== '') && (
        <Section title={isBrowsing ? 'All exercises' : undefined}>
          {results.map(row)}
          {trimmed !== '' && (
            <button className="row accent" onClick={() => setShowEditor(true)}>
              <CirclePlus size={22} aria-hidden />
              Create “{trimmed}”
            </button>
          )}
        </Section>
      )}
      {results.length === 0 && trimmed === '' && (
        <p className="chart-note">Nothing in this muscle group yet.</p>
      )}

      {showEditor && (
        <ExerciseEditor
          state={state}
          suggestedName={trimmed}
          onClose={() => setShowEditor(false)}
          onSaved={(id) => {
            setSelection((current) => [...current, id]);
            setQuery('');
          }}
        />
      )}
    </Sheet>
  );
}
