import { useState } from 'react';
import { guessMuscle, normalizeName, saveExercise } from '../lib/exercises';
import { update } from '../lib/store';
import { EQUIPMENT, equipmentTitle, MUSCLE_GROUPS, muscleTitle } from '../lib/types';
import type { AppState, Equipment, Exercise, MuscleGroup } from '../lib/types';
import { Section } from '../ui/layout';
import { Sheet } from '../ui/overlays';

interface Props {
  state: AppState;
  /** The exercise to edit; leave out to create one. */
  exercise?: Exercise;
  suggestedName?: string;
  onSaved?: (exerciseId: string) => void;
  onClose: () => void;
}

/** Create a custom exercise, or edit an existing one. */
export function ExerciseEditor({ state, exercise, suggestedName = '', onSaved, onClose }: Props) {
  const [name, setName] = useState(exercise?.name ?? suggestedName);
  const [muscle, setMuscle] = useState<MuscleGroup>(exercise?.muscle ?? (suggestedName ? guessMuscle(suggestedName) : 'other'));
  const [equipment, setEquipment] = useState<Equipment>(exercise?.equipment ?? 'other');
  const [notes, setNotes] = useState(exercise?.notes ?? '');
  const [videoURL, setVideoURL] = useState(exercise?.videoURL ?? '');

  const trimmed = name.trim();
  // Two exercises with the same name would be indistinguishable in search.
  const key = normalizeName(trimmed);
  const isDuplicate = state.exercises.some((other) => other.id !== exercise?.id && normalizeName(other.name) === key);
  const canSave = trimmed !== '' && !isDuplicate;

  const save = () => {
    if (!canSave) return;
    let id = '';
    update((draft) => {
      id = saveExercise(draft, { name, muscle, equipment, notes, videoURL }, exercise?.id);
    });
    onSaved?.(id);
    onClose();
  };

  return (
    <Sheet
      title={exercise ? 'Edit Exercise' : 'New Exercise'}
      tall
      onClose={onClose}
      trailing={<button className="bar-button strong" disabled={!canSave} onClick={save}>Save</button>}
    >
      <Section footer={isDuplicate && <span className="error-text">An exercise with this name already exists.</span>}>
        <div className="row">
          <input
            className="field"
            aria-label="Name"
            placeholder="Name"
            autoComplete="off"
            autoCapitalize="words"
            spellCheck={false}
            data-autofocus={exercise ? undefined : true}
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && save()}
          />
        </div>
      </Section>

      <Section>
        <label className="row">
          Muscle group
          <select className="field" value={muscle} onChange={(event) => setMuscle(event.target.value as MuscleGroup)}>
            {MUSCLE_GROUPS.map((value) => <option key={value} value={value}>{muscleTitle(value)}</option>)}
          </select>
        </label>
        <label className="row">
          Equipment
          <select className="field" value={equipment} onChange={(event) => setEquipment(event.target.value as Equipment)}>
            {EQUIPMENT.map((value) => <option key={value} value={value}>{equipmentTitle(value)}</option>)}
          </select>
        </label>
      </Section>

      <Section title="Notes">
        <div className="row">
          <textarea
            className="field"
            aria-label="Notes"
            placeholder="Cues, setup, how it should feel…"
            rows={3}
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
          />
        </div>
      </Section>

      <Section title="Video link">
        <div className="row">
          <input
            className="field"
            type="url"
            inputMode="url"
            aria-label="Video link"
            placeholder="https://…"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={videoURL}
            onChange={(event) => setVideoURL(event.target.value)}
          />
        </div>
      </Section>
    </Sheet>
  );
}
