import { useEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { CloudError } from '../../lib/cloud/backend';
import { cloudConfig } from '../../lib/cloud/config';
import { checkConfirmed, linkSent, resetPassword, sendVerification, signIn, signOutOnly, signUp, stage, tryAgain } from '../../lib/cloud/session';
import { useSignal } from '../../lib/signal';
import { Spinner } from '../../ui/controls';
import type { Note } from '../settings/shared';
import { DataNote } from './DataNote';

// What stands between opening the app and using it, in a copy that has
// accounts: signing in, confirming the address, and being on the guest list.

/** Shorter passwords are refused when an account is created. */
export const MIN_PASSWORD = 10;

const reason = (error: unknown) => (error instanceof CloudError ? error.message : 'Something went wrong. Try again.');

function Frame({ title, children }: { title: string; children: ReactNode }) {
  useEffect(() => {
    document.title = `${title} · Gym Tracker`;
  }, [title]);
  return (
    <main className="auth">
      <p className="auth-app">Gym Tracker</p>
      <h1>{title}</h1>
      {children}
    </main>
  );
}

const NoteLine = ({ note }: { note: Note | null }) =>
  (note ? <p className={note.isError ? 'auth-note error-text' : 'auth-note'} role={note.isError ? 'alert' : 'status'}>{note.text}</p> : null);

/** Runs one request at a time, and keeps what came of it for the line under the form. */
function useRequest() {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const run = async (work: () => Promise<string | null>) => {
    if (busy) return;
    setBusy(true);
    setNote(null);
    try {
      const said = await work();
      if (said) setNote({ text: said, isError: false });
    } catch (error) {
      setNote({ text: reason(error), isError: true });
    } finally {
      setBusy(false);
    }
  };
  return { busy, note, setNote, run };
}

type Mode = 'signIn' | 'create' | 'reset';

const TITLES: Record<Mode, string> = { signIn: 'Sign In', create: 'Create Account', reset: 'Reset Password' };

function SignIn() {
  const [mode, setMode] = useState<Mode>('signIn');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, note, setNote, run } = useRequest();

  const change = (next: Mode) => {
    setMode(next);
    setNote(null);
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    void run(async () => {
      if (mode === 'reset') {
        await resetPassword(email);
        // The same answer whether or not the address has an account: this form must not tell which addresses do.
        return 'If there is an account with that address, a link for setting a new password is on its way to it.';
      }
      if (mode === 'create') {
        if (password.length < MIN_PASSWORD) throw new CloudError('weakPassword', `Use at least ${MIN_PASSWORD} characters for the password.`);
        await signUp(email, password);
      } else {
        await signIn(email, password);
      }
      return null; // signed in: the screen changes by itself
    });
  };

  return (
    <Frame title={TITLES[mode]}>
      {mode === 'create' && (
        <p className="secondary">
          Accounts are by invitation. After you confirm your address, {cloudConfig?.operator || 'the person who runs this copy'} has to add it to the guest list.
        </p>
      )}
      {mode === 'reset' && <p className="secondary">Enter the address of your account, and a link for setting a new password is sent to it.</p>}
      <form onSubmit={submit}>
        <div className="card">
          <label className="row">
            <span className="auth-label">Email</span>
            <input
              className="field"
              type="email"
              name="email"
              autoComplete="username"
              autoCapitalize="none"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          {mode !== 'reset' && (
            <label className="row">
              <span className="auth-label">Password</span>
              <input
                className="field"
                type="password"
                name="password"
                autoComplete={mode === 'create' ? 'new-password' : 'current-password'}
                minLength={mode === 'create' ? MIN_PASSWORD : undefined}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
          )}
        </div>
        <NoteLine note={note} />
        <button className="btn btn-primary spaced" disabled={busy}>
          {busy ? <Spinner /> : mode === 'reset' ? 'Send Link' : TITLES[mode]}
        </button>
      </form>
      <div className="auth-links">
        {mode !== 'signIn' && <button className="bar-button" onClick={() => change('signIn')}>Sign In Instead</button>}
        {mode !== 'create' && <button className="bar-button" onClick={() => change('create')}>Create Account</button>}
        {mode === 'signIn' && <button className="bar-button" onClick={() => change('reset')}>Forgot Password?</button>}
      </div>
      <DataNote />
    </Frame>
  );
}

// Nothing on the device is deleted from these screens: the app hasn't opened, so nobody could be asked what they would lose.
const SignOutLink = () => <button className="bar-button" onClick={() => void signOutOnly()}>Sign Out</button>;

function ConfirmAddress({ email }: { email: string }) {
  const { busy, note, run } = useRequest();
  const sent = useSignal(linkSent);
  return (
    <Frame title="Confirm Your Address">
      {sent ? (
        <p className="secondary">
          A link was sent to <b>{email}</b>. Open it, then come back here. It can take a minute to arrive — look in the spam folder too.
        </p>
      ) : (
        <p className="secondary">
          Your account for <b>{email}</b> is there, but the link that confirms the address couldn't be sent just now. Tap Send It Again.
        </p>
      )}
      <NoteLine note={note} />
      <button
        className="btn btn-primary spaced"
        disabled={busy}
        onClick={() => void run(async () => {
          if (!(await checkConfirmed())) throw new CloudError('other', "That address isn't confirmed yet. Open the link in the email first.");
          return null;
        })}
      >
        {busy ? <Spinner /> : "I've Opened the Link"}
      </button>
      <div className="auth-links">
        <button
          className="bar-button"
          disabled={busy}
          onClick={() => void run(async () => {
            await sendVerification();
            return 'Sent again.';
          })}
        >
          Send It Again
        </button>
        <SignOutLink />
      </div>
    </Frame>
  );
}

function Waiting({ title, email, children }: { title: string; email: string; children: ReactNode }) {
  const { busy, note, run } = useRequest();
  return (
    <Frame title={title}>
      <p className="secondary">{children}</p>
      <p className="secondary">Signed in as <b>{email}</b>.</p>
      <NoteLine note={note} />
      <button
        className="btn btn-primary spaced"
        disabled={busy}
        onClick={() => void run(async () => {
          await tryAgain();
          return null;
        })}
      >
        {busy ? <Spinner /> : 'Try Again'}
      </button>
      <div className="auth-links"><SignOutLink /></div>
    </Frame>
  );
}

/** Shows the app to a signed-in, confirmed, invited person — and to anyone else, what is missing. */
export function Gate({ children }: { children: ReactNode }) {
  const at = useSignal(stage);
  switch (at.name) {
    case 'ready':
      return children;
    case 'signedOut':
      return <SignIn />;
    case 'unconfirmed':
      return <ConfirmAddress email={at.email} />;
    case 'notInvited':
      return (
        <Waiting title="Not on the Guest List Yet" email={at.email}>
          This address hasn't been invited to this copy of Gym Tracker. Ask {cloudConfig?.operator || 'the person who runs it'} to add it, then try again.
        </Waiting>
      );
    case 'stuck':
      return <Waiting title="Couldn't Load Your Data" email={at.email}>{at.message}</Waiting>;
    default:
      return (
        <main className="auth" aria-busy="true">
          <p className="auth-app">Gym Tracker</p>
          <p className="auth-loading"><Spinner />{at.name === 'opening' ? 'Loading your data…' : ''}</p>
        </main>
      );
  }
}
