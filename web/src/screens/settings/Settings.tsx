import { CircleCheck, CircleX, Download, FolderInput, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { changeSettings } from '../../lib/actions';
import { analyzerOnline, isBlockedAsMixedContent, isReachable } from '../../lib/analyzer';
import { BackupError, parseBackup, restoreBackup } from '../../lib/backup';
import type { Backup } from '../../lib/backup';
import { STANDARDS_OPTIONS } from '../../lib/ranks';
import { fmtRest, REST_CHOICES } from '../../lib/rest';
import { getState, replaceState } from '../../lib/store';
import type { AppState } from '../../lib/types';
import { fmtCount, fmtDateTime } from '../../lib/units';
import { Segmented, Spinner, Switch } from '../../ui/controls';
import { downloadBackup } from '../../ui/downloadBackup';
import { LinkRow, Page, Section } from '../../ui/layout';
import { ConfirmDialog } from '../../ui/overlays';
import { Connections } from './Connections';
import { ShareFromOtherApps } from './ShareFromOtherApps';
import { readText, UNITS } from './shared';
import type { Note } from './shared';
import { VideoModel } from './VideoModel';

const SCALES = [{ value: 'rpe', label: 'RPE' }, { value: 'rir', label: 'RIR' }] as const;

export function Settings({ state }: { state: AppState }) {
  const { settings } = state;
  const [connection, setConnection] = useState<'unknown' | 'checking' | 'ok' | 'failed'>('unknown');
  const [checked, setChecked] = useState(0);
  const [backup, setBackup] = useState<Backup | null>(null);
  const [backupNote, setBackupNote] = useState<Note | null>(null);
  const backupInput = useRef<HTMLInputElement>(null);

  const testConnection = async () => {
    const address = settings.analyzerURL;
    setConnection('checking');
    const online = await isReachable(address);
    // The address was edited while the answer was on its way: it says nothing about the one shown now.
    if (getState().settings.analyzerURL !== address) return;
    analyzerOnline.set(online);
    setConnection(online ? 'ok' : 'failed');
    setChecked((count) => count + 1);
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
        title="Rest between sets"
        footer="Ticking a set off starts the countdown at the top of the workout. Tap it there for more time or to skip it."
      >
        <label className="row">
          Rest timer
          <select
            className="field"
            value={String(settings.restSeconds)}
            onChange={(event) => changeSettings({ restSeconds: Number(event.target.value) })}
          >
            {/* A length saved by hand or by another version stays selectable. */}
            {[...new Set([...REST_CHOICES, settings.restSeconds])].sort((a, b) => a - b).map((seconds) => (
              <option key={seconds} value={String(seconds)}>{seconds === 0 ? 'Off' : fmtRest(seconds)}</option>
            ))}
          </select>
        </label>
        {settings.restSeconds > 0 && (
          <Switch label="Sound when the rest is over" checked={settings.restSound} onChange={(restSound) => changeSettings({ restSound })} />
        )}
      </Section>

      <Section title="Ranks" footer="Ranks compare your best set of each lift with strength standards for your body weight. Off hides them everywhere.">
        <div className="row">
          Standards
          <Segmented label="Strength standards" value={settings.rankStandards} options={STANDARDS_OPTIONS} onChange={(rankStandards) => changeSettings({ rankStandards })} />
        </div>
      </Section>

      <Section
        title="Data"
        footer={backupNote
          ? <span className={backupNote.isError ? 'error-text' : undefined}>{backupNote.text}</span>
          : "Everything is kept in this browser, on this device. Clearing the browser's website data deletes it, so download a backup now and then — it is also how you move to another browser or device."}
      >
        <LinkRow to="/settings/import">
          <FolderInput className="row-icon" size={22} aria-hidden />
          Import from Strong
        </LinkRow>
        <button className="row accent" onClick={() => downloadBackup(state)}>
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
          : "The analyzer from this project's server folder downloads a saved video and names the exercises in it. Leave the address empty when you opened this app from the analyzer itself; otherwise enter where it runs."}
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
