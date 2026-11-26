import { Search } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import type { Ref } from 'react';
import { MUSCLE_GROUPS, muscleTitle } from '../lib/types';
import type { MuscleGroup } from '../lib/types';
import { fmtNumber, parseDecimal } from '../lib/units';

interface NumberFieldProps<T> {
  value: T | null;
  onChange: (value: T | null) => void;
  label: string;
  placeholder?: string;
  className?: string;
  autoFocus?: boolean;
  onEnter?: () => void;
  ref?: Ref<HTMLInputElement>;
}

/** Tolerant comparison: unit conversion makes 135 lb come back as 134.9999…. */
const same = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.abs(a - b) < 0.005;

/**
 * Text-backed number entry that writes through on every keystroke, so the
 * value is already saved when the set's tick is tapped straight after typing.
 */
export function DecimalField({ value, onChange, label, placeholder, className, autoFocus, onEnter, ref }: NumberFieldProps<number>) {
  const [text, setText] = useState(() => (value === null ? '' : fmtNumber(value)));

  // Only rewrite the text for changes that came from outside (e.g. "use last
  // time's numbers", or switching units), never mid-typing.
  useEffect(() => {
    setText((current) => (same(parseDecimal(current), value) ? current : value === null ? '' : fmtNumber(value)));
  }, [value]);

  return (
    <input
      ref={ref}
      className={className}
      type="text"
      inputMode="decimal"
      autoComplete="off"
      aria-label={label}
      placeholder={placeholder}
      data-autofocus={autoFocus || undefined}
      value={text}
      onChange={(event) => {
        const next = event.target.value.replace(/[^\d.,]/g, '');
        setText(next);
        const parsed = parseDecimal(next);
        if (!same(parsed, value)) onChange(parsed);
      }}
      onKeyDown={(event) => event.key === 'Enter' && onEnter?.()}
    />
  );
}

export function IntegerField({ value, onChange, label, placeholder, className, onEnter, ref }: NumberFieldProps<number>) {
  return (
    <input
      ref={ref}
      className={className}
      type="text"
      inputMode="numeric"
      autoComplete="off"
      aria-label={label}
      placeholder={placeholder}
      value={value === null ? '' : String(value)}
      onChange={(event) => {
        const digits = event.target.value.replace(/\D/g, '').slice(0, 4);
        onChange(digits === '' ? null : Number(digits));
      }}
      onKeyDown={(event) => event.key === 'Enter' && onEnter?.()}
    />
  );
}

interface SegmentedProps<T extends string> {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (value: T) => void;
}

export function Segmented<T extends string>({ label, value, options, onChange }: SegmentedProps<T>) {
  const name = useId();
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <label key={option.value}>
          <input type="radio" name={name} checked={option.value === value} onChange={() => onChange(option.value)} />
          {option.label}
        </label>
      ))}
    </div>
  );
}

export function SearchField({ value, onChange, placeholder }: { value: string; onChange: (value: string) => void; placeholder: string }) {
  return (
    <div className="search">
      <Search size={18} aria-hidden />
      <input
        type="search"
        aria-label={placeholder}
        placeholder={placeholder}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/** Horizontal chips for narrowing the exercise list to one muscle group. */
export function MuscleFilterBar({ value, onChange }: { value: MuscleGroup | null; onChange: (value: MuscleGroup | null) => void }) {
  return (
    <div className="chips" role="group" aria-label="Muscle group">
      <button className="chip" aria-pressed={value === null} onClick={() => onChange(null)}>All</button>
      {MUSCLE_GROUPS.map((muscle) => (
        <button
          key={muscle}
          className="chip"
          aria-pressed={value === muscle}
          onClick={() => onChange(value === muscle ? null : muscle)}
        >
          {muscleTitle(muscle)}
        </button>
      ))}
    </div>
  );
}

export const Spinner = () => <span className="spinner" role="status" aria-label="Working" />;
