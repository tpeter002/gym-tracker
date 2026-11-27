import { CircleCheck, FileText, TriangleAlert } from 'lucide-react';
import { useRef, useState } from 'react';
import { update } from '../../lib/store';
import { applyStrongImport, exerciseNames, parseStrongCSV, setCount, StrongFormatError } from '../../lib/strong';
import type { ImportSummary, StrongImport } from '../../lib/strong';
import type { AppState, WeightUnit } from '../../lib/types';
import { fmtCount, fmtDate } from '../../lib/units';
import { Segmented } from '../../ui/controls';
import { Page, Section, ValueRow } from '../../ui/layout';
import { readText, UNITS } from './shared';

/** Pick a Strong CSV export, preview what's in it, import. */
export function StrongImportPage({ state }: { state: AppState }) {
  const [parsed, setParsed] = useState<StrongImport | null>(null);
  const [fileUnit, setFileUnit] = useState<WeightUnit>(state.settings.unit);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async (file: File | undefined) => {
    if (!file) return;
    setParsed(null);
    setSummary(null);
    setError(null);
    try {
      setParsed(parseStrongCSV(await readText(file)));
    } catch (problem) {
      setError(problem instanceof StrongFormatError ? problem.message : "Couldn't read that file as text.");
    }
  };

  const runImport = () => {
    if (!parsed) return;
    let result: ImportSummary | null = null;
    update((draft) => {
      result = applyStrongImport(draft, parsed, parsed.headerUnit ?? fileUnit);
    });
    setSummary(result);
  };

  const first = parsed?.workouts[0];
  const last = parsed?.workouts.at(-1);

  return (
    <Page title="Import from Strong" back="/settings">
      <Section footer="In Strong: Profile → Settings → Export Strong Data. Save the file where this browser can reach it, then choose it here.">
        <button className="row accent" onClick={() => fileInput.current?.click()}>
          <FileText size={22} aria-hidden />
          Choose CSV File…
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".csv,text/csv,text/plain"
          hidden
          aria-label="Strong export file"
          onChange={(event) => {
            void load(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      </Section>

      {error && (
        <Section>
          <div className="row error-text" role="alert">
            <TriangleAlert size={20} aria-hidden />
            {error}
          </div>
        </Section>
      )}

      {parsed && !summary && (
        <>
          <Section
            title="Found in the file"
            footer={parsed.headerUnit === null && "This export doesn't say which unit it uses — pick the one Strong was set to."}
          >
            <ValueRow label="Workouts" value={parsed.workouts.length} />
            <ValueRow label="Exercises" value={exerciseNames(parsed).size} />
            <ValueRow label="Sets" value={setCount(parsed)} />
            {first && last && <ValueRow label="Period" value={`${fmtDate(first.date)} – ${fmtDate(last.date)}`} />}
            {parsed.headerUnit === null && (
              <div className="row">
                Weights in the file are in
                <Segmented label="Weights in the file are in" value={fileUnit} options={UNITS} onChange={setFileUnit} />
              </div>
            )}
          </Section>
          <button className="btn btn-primary spaced" disabled={parsed.workouts.length === 0} onClick={runImport}>
            Import {fmtCount(parsed.workouts.length, 'Workout')}
          </button>
        </>
      )}

      {summary && (
        <Section>
          <div className="row ok-text" role="status">
            <CircleCheck size={20} aria-hidden />
            Imported {fmtCount(summary.workouts, 'workout')} and {fmtCount(summary.sets, 'set')}
          </div>
          {summary.newExercises > 0 && (
            <div className="row">
              {summary.newExercises === 1
                ? "1 exercise wasn't in the built-in list and was added as your own."
                : `${summary.newExercises} exercises weren't in the built-in list and were added as your own.`}
            </div>
          )}
          {summary.alreadyImported > 0 && (
            <div className="row">
              {summary.alreadyImported === 1
                ? '1 workout was already here and was skipped.'
                : `${summary.alreadyImported} workouts were already here and were skipped.`}
            </div>
          )}
        </Section>
      )}
    </Page>
  );
}
