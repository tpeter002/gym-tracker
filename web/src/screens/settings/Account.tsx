import { CircleCheck, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { CloudError } from '../../lib/cloud/backend';
import type { Trouble } from '../../lib/cloud/backend';
import { confirmRemovals, deleteAccount, keepRemoved, signOut, stage, sync, syncState } from '../../lib/cloud/session';
import type { AtStake, SyncState } from '../../lib/cloud/session';
import { useSignal } from '../../lib/signal';
import { fmtCount, fmtDateTime } from '../../lib/units';
import { Spinner } from '../../ui/controls';
import { Section, ValueRow } from '../../ui/layout';
import { ConfirmDialog, Sheet } from '../../ui/overlays';
import { DataNote } from '../cloud/DataNote';

const PROBLEMS: Record<Trouble | 'storage', string> = {
  offline: "Couldn't reach the server. What you log is kept on this device and sent when the connection is back.",
  denied: "This account is no longer on the guest list, so nothing is being synced. What you logged is still on this device: download a backup to keep it.",
  quota: "Today's free allowance is used up. Syncing picks up again tomorrow; nothing is lost.",
  storage: "This browser couldn't save the last change, so syncing is paused. Reload the page; if it keeps happening, download a backup.",
  credentials: 'The login has expired. Sign out and in again.',
  emailInUse: 'Syncing failed. It is tried again shortly.',
  weakPassword: 'Syncing failed. It is tried again shortly.',
  badEmail: 'Syncing failed. It is tried again shortly.',
  tooManyTries: 'Too many tries. It is tried again shortly.',
  other: 'Syncing failed. It is tried again shortly.',
};

/** What the person is told before a sign-out that would lose something. */
const AT_STAKE: Record<AtStake, { title: string; message: string }> = {
  workout: {
    title: 'Sign out with a workout in progress?',
    message: 'A workout in progress is kept on this device only until it is finished. Signing out removes your data from this device, and the workout with it.',
  },
  unsent: {
    title: 'Sign out before everything is sent?',
    message: "This device couldn't make sure that your account has everything. Signing out removes your data from this device, so anything not yet sent would be lost.",
  },
  tooLarge: {
    title: 'Sign out and lose what is only here?',
    message: 'Some items are too large for the cloud and are kept on this device only. Signing out removes them. Download a backup first to keep them.',
  },
};

function statusLine(state: SyncState): string {
  if (state.busy) return 'Syncing…';
  if (state.held > 0) return 'Waiting for your answer below';
  if (state.waiting) return 'Changes waiting to be sent';
  if (state.lastSynced === null) return 'Not synced yet';
  return `Up to date · ${fmtDateTime(state.lastSynced)}`;
}

/** The signed-in account under Settings: how syncing stands, signing out, and deleting everything. */
export function Account() {
  const at = useSignal(stage);
  const state = useSignal(syncState);
  const [asking, setAsking] = useState<AtStake | 'delete' | null>(null);
  const [password, setPassword] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  if (at.name !== 'ready') return null;

  const leave = async () => {
    const atStake = await signOut();
    if (atStake) setAsking(atStake);
  };

  const erase = async () => {
    setDeleting(true);
    setRefusal(null);
    try {
      await deleteAccount(password);
    } catch (error) {
      setRefusal(error instanceof CloudError ? error.message : 'Something went wrong. Try again.');
      setDeleting(false);
    }
  };

  const notes = [
    state.problem && PROBLEMS[state.problem],
    state.tooLarge > 0 && `${fmtCount(state.tooLarge, 'item')} too large for the cloud ${state.tooLarge === 1 ? 'stays' : 'stay'} on this device only.`,
    state.unreadable > 0 && `${fmtCount(state.unreadable, 'item')} in your account couldn't be read by this version of the app and ${state.unreadable === 1 ? 'was' : 'were'} left as ${state.unreadable === 1 ? 'it is' : 'they are'}.`,
  ].filter(Boolean);

  return (
    <>
      <Section
        title="Account"
        footer={notes.length > 0
          ? <span className={state.problem ? 'error-text' : undefined}>{notes.join(' ')}</span>
          : 'What you log is saved on this device first and sent to your account when there is a connection. A workout in progress stays on this device until you finish it.'}
      >
        <ValueRow label="Signed in as" value={at.email} />
        <button className="row" disabled={state.busy} onClick={() => void sync()}>
          <span className="grow">
            Sync Now
            <span className="sub" role="status">{statusLine(state)}</span>
          </span>
          {state.busy
            ? <Spinner />
            : !state.problem && !state.waiting && state.lastSynced !== null
              ? <CircleCheck className="ok-text" size={20} aria-hidden />
              : <RefreshCw className="row-icon" size={20} aria-hidden />}
        </button>
        {state.held > 0 && (
          <div className="row held">
            <p>
              <b>{fmtCount(state.held, 'item')} that your account holds {state.held === 1 ? 'is' : 'are'} no longer on this device</b> — deleted here,
              or replaced by a backup. Removing them from the account takes them off your other devices too. Bringing them back
              makes this device take everything as the account has it.
            </p>
            <div className="held-actions">
              <button className="btn btn-tinted btn-inline" onClick={() => void keepRemoved()}>Bring Them Back</button>
              <button className="btn btn-tinted btn-inline destructive" onClick={() => void confirmRemovals()}>Remove From Account</button>
            </div>
          </div>
        )}
        <button className="row accent" onClick={() => void leave()}>Sign Out</button>
        <button className="row destructive" onClick={() => setAsking('delete')}>Delete Account…</button>
      </Section>
      <DataNote />

      {asking !== null && asking !== 'delete' && (
        <ConfirmDialog
          title={AT_STAKE[asking].title}
          message={AT_STAKE[asking].message}
          actions={[{ label: 'Sign Out Anyway', destructive: true, run: () => void signOut(true) }]}
          cancelLabel="Stay Signed In"
          onClose={() => setAsking(null)}
        />
      )}
      {asking === 'delete' && (
        <Sheet
          title="Delete Account"
          onClose={() => {
            setAsking(null);
            setPassword('');
            setRefusal(null);
          }}
        >
          <Section
            footer={refusal
              ? <span className="error-text" role="alert">{refusal}</span>
              : 'This deletes every workout, exercise, weigh-in, saved video and setting of yours from the database, then the login itself, and the copy on this device. It cannot be undone — download a backup first if you want to keep a copy.'}
          >
            <label className="row">
              <span className="auth-label">Password</span>
              <input
                className="field"
                type="password"
                autoComplete="current-password"
                data-autofocus
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          </Section>
          <button className="btn btn-primary spaced danger" disabled={!password || deleting} onClick={() => void erase()}>
            {deleting ? <Spinner /> : 'Delete Everything'}
          </button>
        </Sheet>
      )}
    </>
  );
}
