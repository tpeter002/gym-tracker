import { CircleCheck, CircleX, Download, FileText, FolderInput, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { analyzerInfo, isBlockedAsMixedContent, isReachable, listModels } from '../lib/analyzer';
import type { AnalyzerInfo, ModelOption } from '../lib/analyzer';
import { backupFilename, BackupError, exportBackup, parseBackup, restoreBackup } from '../lib/backup';
import type { Backup } from '../lib/backup';
import { analyzerOnline } from '../lib/inbox';
import { replaceState, update } from '../lib/store';
import { applyStrongImport, exerciseNames, parseStrongCSV, setCount, StrongFormatError } from '../lib/strong';
import type { ImportSummary, StrongImport } from '../lib/strong';
import { MODEL_PROVIDER_TITLES, MODEL_PROVIDERS } from '../lib/types';
import type { AppState, ModelProvider, Settings as SettingsValues, WeightUnit } from '../lib/types';
import { fmtCount, fmtDate, fmtDateTime } from '../lib/units';
import { Segmented, Spinner } from '../ui/controls';
import { LinkRow, Page, Section, ValueRow } from '../ui/layout';
import { ConfirmDialog } from '../ui/overlays';

const UNITS = [{ value: 'kg', label: 'kg' }, { value: 'lb', label: 'lb' }] as const;
const SCALES = [{ value: 'rpe', label: 'RPE' }, { value: 'rir', label: 'RIR' }] as const;

function changeSettings(patch: Partial<SettingsValues>): void {
  update((draft) => {
    Object.assign(draft.settings, patch);
  });
}

// What each service is and where its keys come from.
const PROVIDER_NOTES: Record<ModelProvider, string> = {
  anthropic: 'Claude models. Keys come from platform.claude.com.',
  zai: 'GLM models; glm-4.6v-flash is free. Keys come from z.ai, under API Keys.',
  openrouter: 'Hundreds of models behind one key from openrouter.ai; the free ones have a daily limit.',
};

/** Choose which model names the exercises in a video, and whose key pays for it. */
function VideoModel({ settings, checked }: { settings: SettingsValues; checked: number }) {
  const provider = settings.modelProvider;
  const [info, setInfo] = useState<AnalyzerInfo | null>(null);
  const [options, setOptions] = useState<ModelOption[]>([]);

  // Asked when the service changes and after a connection test, not on every
  // letter typed into the address above.
  useEffect(() => {
    let current = true;
    setOptions([]);
    if (!provider) return;
    void analyzerInfo(settings.analyzerURL).then((found) => current && setInfo(found));
    void listModels(settings.analyzerURL, provider).then((found) => current && setOptions(found));
    return () => {
      current = false;
    };
  }, [provider, checked]); // eslint-disable-line react-hooks/exhaustive-deps

  const known = provider ? info?.providers.find((candidate) => candidate.id === provider) : undefined;
  const title = provider ? MODEL_PROVIDER_TITLES[provider] : '';

  let footer: React.ReactNode = 'The analyzer decides: Claude, unless its server/.env names another model. Pick a service to choose the model yourself or to use a key of your own.';
  if (provider) {
    let warning: string | null = null;
    if (info && info.providers.length === 0) {
      warning = 'This analyzer is an older version and ignores the choice — update it and start it again.';
    } else if (known && !known.hasKey && !settings.apiKeys[provider].trim()) {
      warning = `The analyzer has no key for ${title}, so it needs yours.`;
    }
    footer = (
      <>
        {PROVIDER_NOTES[provider]} Your key stays in this browser (backups leave it out) and is sent to your analyzer
        with each video; leave it empty to use the analyzer’s own.
        {warning && <span className="error-text" role="status"> {warning}</span>}
      </>
    );
  }

  return (
    <Section title="Video model" footer={footer}>
      <label className="row">
        Service
        <select
          className="field"
          value={provider}
          onChange={(event) => changeSettings({ modelProvider: event.target.value as ModelProvider | '' })}
        >
          <option value="">Analyzer’s choice</option>
          {MODEL_PROVIDERS.map((id) => <option key={id} value={id}>{MODEL_PROVIDER_TITLES[id]}</option>)}
        </select>
      </label>
      {provider && (
        <>
          <label className="row">
            Model
            <input
              className="field right"
              list="model-suggestions"
              placeholder={known?.defaultModel ? `Default: ${known.defaultModel}` : 'Default model'}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={settings.models[provider]}
              onChange={(event) => update((draft) => {
                draft.settings.models[provider] = event.target.value;
              })}
            />
            <datalist id="model-suggestions">
              {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
            </datalist>
          </label>
          <label className="row">
            API key
            <input
              className="field right"
              type="password"
              placeholder={known?.hasKey ? 'Using the analyzer’s key' : `Your own ${title} key`}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={settings.apiKeys[provider]}
              onChange={(event) => update((draft) => {
                draft.settings.apiKeys[provider] = event.target.value;
              })}
            />
          </label>
        </>
      )}
    </Section>
  );
}

/** Text of a chosen file; exports from older apps aren't always UTF-8. */
async function readText(file: File): Promise<string> {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

export function Settings({ state }: { state: AppState }) {
  const { settings } = state;
  const [connection, setConnection] = useState<'unknown' | 'checking' | 'ok' | 'failed'>('unknown');
  const [checked, setChecked] = useState(0);
  const [backup, setBackup] = useState<Backup | null>(null);
  const [backupNote, setBackupNote] = useState<{ text: string; isError: boolean } | null>(null);
  const backupInput = useRef<HTMLInputElement>(null);

  const testConnection = async () => {
    setConnection('checking');
    const online = await isReachable(settings.analyzerURL);
    analyzerOnline.set(online);
    setConnection(online ? 'ok' : 'failed');
    setChecked((count) => count + 1);
  };

  const downloadBackup = () => {
    const url = URL.createObjectURL(new Blob([exportBackup(state)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = backupFilename();
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 10_000);
  };

  const chooseBackup = async (file: File | undefined) => {
    if (!file) return;
    setBackupNote(null);
    try {
      setBackup(parseBackup(await readText(file)));
    } catch (error) {
      setBackupNote({ text: error instanceof BackupError ? error.message : "Couldn't read that file.", isError: true });
    }
  };

  const blocked = isBlockedAsMixedContent(settings.analyzerURL, document.baseURI);

  return (
    <Page title="Settings" back="/">
      <Section
        title="Logging"
        footer="RPE rates how hard a set was out of 10; RIR counts the reps you had left. They're two views of the same thing (RIR = 10 − RPE), so you can switch any time."
      >
        <div className="row">
          Weight unit
          <Segmented label="Weight unit" value={settings.unit} options={UNITS} onChange={(unit) => changeSettings({ unit })} />
        </div>
        <div className="row">
          Effort scale
          <Segmented label="Effort scale" value={settings.effort} options={SCALES} onChange={(effort) => changeSettings({ effort })} />
        </div>
      </Section>

      <Section
        title="Data"
        footer={backupNote
          ? <span className={backupNote.isError ? 'error-text' : undefined}>{backupNote.text}</span>
          : 'Everything is kept in this browser, on this device. Clearing the browser’s website data deletes it, so download a backup now and then — it is also how you move to another browser or device.'}
      >
        <LinkRow to="/settings/import">
          <FolderInput className="row-icon" size={22} aria-hidden />
          Import from Strong
        </LinkRow>
        <button className="row accent" onClick={downloadBackup}>
          <Download size={22} aria-hidden />
          Download Backup
        </button>
        <button className="row accent" onClick={() => backupInput.current?.click()}>
          <Upload size={22} aria-hidden />
          Restore Backup…
        </button>
        <input
          ref={backupInput}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Backup file"
          onChange={(event) => {
            void chooseBackup(event.target.files?.[0]);
            event.target.value = ''; // so choosing the same file again still fires
          }}
        />
      </Section>

      <Section
        title="Video analyzer"
        footer={blocked
          ? "This page is loaded over https, so the browser won't let it call an http address. Open the app from the analyzer's own address instead."
          : 'The analyzer from this project’s server folder downloads a saved video and names the exercises in it. Leave the address empty when you opened this app from the analyzer itself; otherwise enter where it runs.'}
      >
        <div className="row">
          <input
            className="field"
            type="url"
            inputMode="url"
            aria-label="Analyzer address"
            placeholder="This site"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={settings.analyzerURL}
            onChange={(event) => {
              changeSettings({ analyzerURL: event.target.value });
              setConnection('unknown');
            }}
          />
        </div>
        <button className="row accent" disabled={connection === 'checking'} onClick={() => void testConnection()}>
          <span className="grow">Test Connection</span>
          {connection === 'checking' && <Spinner />}
          {connection === 'ok' && <span className="ok-text"><CircleCheck size={18} aria-hidden />Connected</span>}
          {connection === 'failed' && <span className="bad-text"><CircleX size={18} aria-hidden />Not reachable</span>}
        </button>
      </Section>

      <VideoModel settings={settings} checked={checked} />

      {backup && (
        <ConfirmDialog
          title="Replace everything with this backup?"
          message={`The backup${backup.exportedAt ? ` from ${fmtDateTime(backup.exportedAt)}` : ''} has ${fmtCount(backup.state.workouts.length, 'workout')}. What is in this browser now will be overwritten.`}
          actions={[{
            label: 'Replace',
            destructive: true,
            run: () => {
              replaceState(restoreBackup(state, backup));
              setBackupNote({ text: `Restored ${fmtCount(backup.state.workouts.length, 'workout')} from the backup.`, isError: false });
            },
          }]}
          onClose={() => setBackup(null)}
        />
      )}
    </Page>
  );
}

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
