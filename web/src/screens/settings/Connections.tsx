import { useEffect, useState } from 'react';
import { connectGarmin, connections, disconnect, loadConnections, stravaConnectAddress } from '../../lib/exports';
import { useSignal } from '../../lib/signal';
import { update } from '../../lib/store';
import type { ExportTarget, Settings as SettingsValues } from '../../lib/types';
import { Spinner, Switch } from '../../ui/controls';
import { Section, ValueRow } from '../../ui/layout';
import type { Note } from './shared';

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
export function Connections({ settings }: { settings: SettingsValues }) {
  const status = useSignal(connections);
  const [asked, setAsked] = useState(false);
  const [stravaNote, setStravaNote] = useState<Note | null>(null);
  const [garminNote, setGarminNote] = useState<Note | null>(null);

  useEffect(() => {
    void loadConnections().finally(() => setAsked(true));
  }, []);

  // In an effect rather than as the state's first value: taking the outcome
  // rewrites the address, and React may run a state initializer more than once.
  useEffect(() => {
    const outcome = takeStravaOutcome();
    if (outcome) setStravaNote(outcome);
  }, []);

  if (!status) {
    return (
      <Section title="Connections" footer="Finished workouts can be sent to Strava and Garmin Connect through the analyzer.">
        <div className="row secondary">{asked ? "The analyzer isn't reachable, so the connections can't be shown." : 'Checking…'}</div>
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
            password is used once and isn't stored.
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
          <GarminSignIn onNote={setGarminNote} />
        )}
      </Section>
    </>
  );
}

/** Garmin's email and password, then the verification code if Garmin asks for one. `onNote` hears how each attempt went. */
function GarminSignIn({ onNote }: { onNote: (note: Note | null) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);

  const signIn = async () => {
    setBusy(true);
    onNote(null);
    const answer = await connectGarmin(email, password, needsCode ? code : '');
    setBusy(false);
    setNeedsCode(answer.needsCode);
    setCode('');
    if (answer.connected) {
      setPassword(''); // not needed again, so not kept around either
      onNote({ text: 'Garmin Connect is connected.', isError: false });
    } else if (answer.message) {
      onNote({ text: answer.message, isError: !answer.needsCode });
    }
  };

  return (
    <form onSubmit={(event) => { event.preventDefault(); void signIn(); }}>
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
  );
}
