import { CircleCheck, CircleX, Download, FileText, FolderInput, TriangleAlert, Upload } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { analyzerInfo, isBlockedAsMixedContent, isReachable, listModels } from '../lib/analyzer';
import type { AnalyzerInfo, ModelOption } from '../lib/analyzer';
import { backupFilename, BackupError, exportBackup, parseBackup, restoreBackup } from '../lib/backup';
import { connectGarmin, connections, disconnect, loadConnections, stravaConnectAddress } from '../lib/exports';
import type { Backup } from '../lib/backup';
import { analyzerOnline, shareAddress } from '../lib/inbox';
import { replaceState, update, useSignal } from '../lib/store';
import { applyStrongImport, exerciseNames, parseStrongCSV, setCount, StrongFormatError } from '../lib/strong';
import type { ImportSummary, StrongImport } from '../lib/strong';
import { MODEL_PROVIDER_TITLES, MODEL_PROVIDERS } from '../lib/types';
import type { AppState, ExportTarget, ModelProvider, Settings as SettingsValues, WeightUnit } from '../lib/types';
import { fmtCount, fmtDate, fmtDateTime } from '../lib/units';
import { Segmented, Spinner, Switch } from '../ui/controls';
import { LinkRow, Page, Section, ValueRow } from '../ui/layout';
import { ConfirmDialog } from '../ui/overlays';
import { chooseStandards, STANDARDS_OPTIONS } from './Ranks';

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
  gemini: 'Gemini models; the Flash ones have a free daily allowance. Keys come from aistudio.google.com.',
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

type Note = { text: string; isError: boolean };

// What Strava's approval page led to; the analyzer hands it back in the address.
const STRAVA_OUTCOMES: Record<string, Note> = {
  connected: { text: 'Strava is connected.', isError: false },
  denied: { text: "Strava wasn't connected: the request was declined.", isError: true },
  'no-upload-permission': { text: "Strava wasn't connected: it needs the permission to upload activities, so leave that box ticked.", isError: true },
};

/** Reads `?strava=…` left by the return from Strava, and takes it out of the address. */
function takeStravaOutcome(): Note | null {
  const params = new URLSearchParams(window.location.search);
  const outcome = params.get('strava');
  if (outcome === null) return null;
  params.delete('strava');
  const query = params.toString();
  history.replaceState(history.state, '', window.location.pathname + (query ? `?${query}` : '') + window.location.hash);
  return STRAVA_OUTCOMES[outcome] ?? null;
}

const setAutoExport = (target: ExportTarget, on: boolean) =>
  update((draft) => {
    draft.settings.autoExport[target] = on;
  });

/** Where finished workouts are sent: connect, switch automatic sending on, disconnect. */
function Connections({ settings }: { settings: SettingsValues }) {
  const status = useSignal(connections);
  const [asked, setAsked] = useState(false);
  const [stravaNote, setStravaNote] = useState<Note | null>(takeStravaOutcome);
  const [garminNote, setGarminNote] = useState<Note | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadConnections().finally(() => setAsked(true));
  }, []);

  const signInToGarmin = async () => {
    setBusy(true);
    setGarminNote(null);
    const answer = await connectGarmin(email, password, needsCode ? code : '');
    setBusy(false);
    setNeedsCode(answer.needsCode);
    setCode('');
    if (answer.connected) {
      setPassword(''); // not needed again, so not kept around either
      setGarminNote({ text: 'Garmin Connect is connected.', isError: false });
    } else if (answer.message) {
      setGarminNote({ text: answer.message, isError: !answer.needsCode });
    }
  };

  if (!status) {
    return (
      <Section title="Connections" footer="Finished workouts can be sent to Strava and Garmin Connect through the analyzer.">
        <div className="row secondary">{asked ? 'The analyzer isn’t reachable, so the connections can’t be shown.' : 'Checking…'}</div>
      </Section>
    );
  }

  const noteLine = (note: Note | null) => note && <span className={note.isError ? 'error-text' : 'ok-text'} role="status"> {note.text}</span>;

  return (
    <>
      <Section
        title="Strava"
        footer={
          <>
            {!status.strava.configured
              ? 'Not set up on the analyzer yet. Create an API application at strava.com/settings/api with “localhost” as its callback domain, put its id and secret into server/.env as STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET, and start the analyzer again.'
              : 'A workout becomes a Weight Training activity with its exercises and sets written into the description. Connect from the computer the analyzer runs on.'}
            {noteLine(stravaNote)}
          </>
        }
      >
        {status.strava.connected ? (
          <>
            <ValueRow label="Account" value={status.strava.account ?? 'Connected'} />
            <Switch label="Send finished workouts automatically" checked={settings.autoExport.strava} onChange={(on) => setAutoExport('strava', on)} />
            <button className="row destructive" onClick={() => { setStravaNote(null); void disconnect('strava'); }}>Disconnect Strava</button>
          </>
        ) : status.strava.configured ? (
          <a className="row accent" href={stravaConnectAddress(settings.analyzerURL, document.baseURI, `${window.location.pathname}#/settings`)}>
            Connect Strava
          </a>
        ) : (
          <div className="row secondary">Not available</div>
        )}
      </Section>

      <Section
        title="Garmin Connect"
        footer={
          <>
            A workout is uploaded as a strength activity with its exercises, sets, reps and weights. Garmin has no official way for a personal app
            to add activities, so this signs in like the Garmin Connect website does, through an unofficial library that can stop working. Your
            password is used once and isn’t stored.
            {noteLine(garminNote)}
          </>
        }
      >
        {status.garmin.connected ? (
          <>
            <ValueRow label="Account" value={status.garmin.account ?? 'Connected'} />
            <Switch label="Send finished workouts automatically" checked={settings.autoExport.garmin} onChange={(on) => setAutoExport('garmin', on)} />
            <button className="row destructive" onClick={() => { setGarminNote(null); void disconnect('garmin'); }}>Disconnect Garmin</button>
          </>
        ) : (
          <form onSubmit={(event) => { event.preventDefault(); void signInToGarmin(); }}>
            {needsCode ? (
              <label className="row">
                Verification code
                <input className="field right" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(event) => setCode(event.target.value)} />
              </label>
            ) : (
              <>
                <label className="row">
                  Garmin email
                  <input className="field right" type="email" autoComplete="off" autoCapitalize="none" spellCheck={false} value={email} onChange={(event) => setEmail(event.target.value)} />
                </label>
                <label className="row">
                  Garmin password
                  <input className="field right" type="password" autoComplete="off" value={password} onChange={(event) => setPassword(event.target.value)} />
                </label>
              </>
            )}
            <button className="row accent" type="submit" disabled={busy || (needsCode ? !code.trim() : !email.trim() || !password)}>
              <span className="grow">{needsCode ? 'Finish Connecting' : 'Connect Garmin'}</span>
              {busy && <Spinner />}
            </button>
          </form>
        )}
      </Section>
    </>
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

      <Section title="Ranks" footer="Ranks compare your best set of each lift with strength standards for your body weight. Off hides them everywhere.">
        <div className="row">
          Standards
          <Segmented label="Strength standards" value={settings.rankStandards} options={STANDARDS_OPTIONS} onChange={chooseStandards} />
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

      <ShareFromOtherApps settings={settings} />

      <VideoModel settings={settings} checked={checked} />

      <Connections settings={settings} />

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

/**
 * The address an iOS Shortcut posts shared videos to, and how to make that
 * Shortcut. A web page can't be in the share sheet itself; this is the way round.
 */
function ShareFromOtherApps({ settings }: { settings: SettingsValues }) {
  const address = shareAddress(settings, document.baseURI);
  const field = useRef<HTMLInputElement>(null);
  const [copied, setCopied] = useState<boolean | null>(null);
  if (!address) return null;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // Browsers offer the clipboard on https only; from the Mac's http address the older way still works.
      field.current?.focus();
      field.current?.setSelectionRange(0, address.length);
      setCopied(document.execCommand('copy'));
    }
  };

  return (
    <Section
      title="Share from other apps"
      footer="The address belongs to this copy of the app — one on the Home Screen and one in a browser tab each have their own. It works while the analyzer is running and within the phone's reach."
    >
      <div className="row">
        <input
          ref={field}
          className="field small"
          readOnly
          aria-label="Share address"
          value={address}
          onFocus={(event) => event.target.select()}
        />
      </div>
      <button className="row accent" onClick={() => void copy()}>
        <span className="grow">Copy Address</span>
        {copied === true && <span className="ok-text"><CircleCheck size={18} aria-hidden />Copied</span>}
        {copied === false && <span className="secondary small">Select it above and copy</span>}
      </button>
      <div className="row">
        <ol className="steps">
          <li>On the iPhone, open Shortcuts, make a new shortcut and add the action <b>Get Contents of URL</b>.</li>
          <li>Paste the address as its URL. Open the action's options: Method <b>POST</b>, Request Body <b>JSON</b>, one text field named <b>url</b> with the variable <b>Shortcut Input</b> as its value.</li>
          <li>In the shortcut's details switch on <b>Show in Share Sheet</b>, and name it Gym Tracker.</li>
          <li>In Instagram, TikTok or YouTube: Share → Gym Tracker. The video is under Saved Videos the next time this app is open.</li>
        </ol>
      </div>
    </Section>
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
