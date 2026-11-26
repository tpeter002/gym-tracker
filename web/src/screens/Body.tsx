import { ArrowDownRight, ArrowRight, ArrowUpRight, Plus, Scale, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { uid } from '../lib/ids';
import { update } from '../lib/store';
import type { AppState, BodyWeight, WeightUnit } from '../lib/types';
import { fmtDate, fmtNumber, fromDateInputValue, fromKg, toDateInputValue, toKg, weightText } from '../lib/units';
import { LineChart } from '../ui/Chart';
import { DecimalField, Segmented } from '../ui/controls';
import { EmptyState, Page, Section } from '../ui/layout';
import { ConfirmDialog, Sheet } from '../ui/overlays';

const RANGES = [
  { value: 'month', label: '1M', months: 1 },
  { value: 'quarter', label: '3M', months: 3 },
  { value: 'year', label: '1Y', months: 12 },
  { value: 'all', label: 'All', months: null },
] as const;
type Range = (typeof RANGES)[number]['value'];

function rangeStart(range: Range): number {
  const months = RANGES.find((option) => option.value === range)!.months;
  if (months === null) return -Infinity;
  const start = new Date();
  start.setMonth(start.getMonth() - months);
  return start.getTime();
}

/** Body-weight log with a trend chart. */
export function Body({ state }: { state: AppState }) {
  const { unit } = state.settings;
  const [range, setRange] = useState<Range>('quarter');
  const [showLog, setShowLog] = useState(false);
  const [toDelete, setToDelete] = useState<BodyWeight | null>(null);

  // Newest first.
  const entries = useMemo(() => [...state.bodyWeights].sort((a, b) => b.date - a.date), [state.bodyWeights]);
  const latest = entries[0];
  const start = rangeStart(range);
  const visible = entries.filter((entry) => entry.date >= start);
  // Change across the visible range, rounded the way it is displayed.
  const oldest = visible.at(-1);
  const delta = latest && oldest && visible.length > 1
    ? Math.round((fromKg(unit, latest.kg) - fromKg(unit, oldest.kg)) * 10) / 10
    : null;
  const DeltaIcon = delta === null || delta === 0 ? ArrowRight : delta > 0 ? ArrowUpRight : ArrowDownRight;

  return (
    <Page
      title="Body Weight"
      large
      trailing={
        <button className="icon-button" aria-label="Log weight" onClick={() => setShowLog(true)}>
          <Plus size={24} aria-hidden />
        </button>
      }
    >
      {!latest && (
        <EmptyState icon={<Scale size={48} aria-hidden />} title="No Weigh-ins Yet">
          <p>Log your body weight to see how it trends.</p>
          <button className="btn btn-primary btn-inline" onClick={() => setShowLog(true)}>Log Weight</button>
        </EmptyState>
      )}

      {latest && (
        <>
          <Section>
            <div className="hero">
              <div>
                <strong>{weightText(unit, latest.kg)}</strong>
                <span className="secondary small">{fmtDate(latest.date)}</span>
              </div>
              {delta !== null && (
                <span className="delta">
                  <DeltaIcon size={16} aria-hidden />
                  {delta > 0 ? '+' : ''}{fmtNumber(delta, 1)} {unit}
                </span>
              )}
            </div>
            <div className="chart-block">
              <Segmented label="Range" value={range} options={RANGES} onChange={setRange} />
              {visible.length > 1 ? (
                <LineChart
                  label="Body weight"
                  unit={unit}
                  points={[...visible].reverse().map((entry) => ({ time: entry.date, value: fromKg(unit, entry.kg) }))}
                />
              ) : (
                <p className="chart-note">Not enough weigh-ins in this range to draw a trend.</p>
              )}
            </div>
          </Section>

          <Section title="Entries">
            {entries.map((entry) => (
              <div key={entry.id} className="row split">
                <div className="row-main">
                  <span>{fmtDate(entry.date)}</span>
                  <span className="row-value">{weightText(unit, entry.kg)}</span>
                </div>
                <button
                  className="icon-button secondary"
                  aria-label={`Delete the entry from ${fmtDate(entry.date)}`}
                  onClick={() => setToDelete(entry)}
                >
                  <Trash2 size={18} aria-hidden />
                </button>
              </div>
            ))}
          </Section>
        </>
      )}

      {showLog && <LogWeight unit={unit} lastKg={latest?.kg ?? null} onClose={() => setShowLog(false)} />}
      {toDelete && (
        <ConfirmDialog
          title="Delete this weigh-in?"
          message={`${weightText(unit, toDelete.kg)} on ${fmtDate(toDelete.date)}`}
          actions={[{
            label: 'Delete',
            destructive: true,
            run: () => update((draft) => {
              draft.bodyWeights = draft.bodyWeights.filter((entry) => entry.id !== toDelete.id);
            }),
          }]}
          onClose={() => setToDelete(null)}
        />
      )}
    </Page>
  );
}

function LogWeight({ unit, lastKg, onClose }: { unit: WeightUnit; lastKg: number | null; onClose: () => void }) {
  const today = toDateInputValue(Date.now());
  const [value, setValue] = useState<number | null>(null);
  const [day, setDay] = useState(today);
  const date = day <= today ? fromDateInputValue(day) : null;
  const canSave = value !== null && value > 0 && date !== null;

  const save = () => {
    if (!canSave) return;
    update((draft) => {
      draft.bodyWeights.push({ id: uid(), date, kg: toKg(unit, value) });
    });
    onClose();
  };

  return (
    <Sheet
      title="Log Weight"
      onClose={onClose}
      trailing={<button className="bar-button strong" disabled={!canSave} onClick={save}>Save</button>}
    >
      <Section>
        <div className="row">
          <span>Weight</span>
          <DecimalField
            className="field title right"
            label="Body weight"
            placeholder={lastKg === null ? '0' : fmtNumber(fromKg(unit, lastKg), 1)}
            value={value}
            onChange={setValue}
            onEnter={save}
            autoFocus
          />
          <span className="secondary">{unit}</span>
        </div>
        <label className="row">
          Date
          <input className="field" type="date" max={today} value={day} onChange={(event) => setDay(event.target.value)} />
        </label>
      </Section>
    </Sheet>
  );
}
