import { FirebaseError, initializeApp } from 'firebase/app';
import {
  browserLocalPersistence, connectAuthEmulator, createUserWithEmailAndPassword, deleteUser, EmailAuthProvider,
  indexedDBLocalPersistence, initializeAuth, onAuthStateChanged, reauthenticateWithCredential, sendEmailVerification,
  sendPasswordResetEmail, signInWithEmailAndPassword, signOut,
} from 'firebase/auth';
import type { User } from 'firebase/auth';
import {
  collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, limit, orderBy, query, serverTimestamp,
  startAfter, Timestamp, where, writeBatch,
} from 'firebase/firestore/lite';
import type { QueryDocumentSnapshot } from 'firebase/firestore/lite';
import { CloudError } from './backend';
import type { Account, Backend, Trouble } from './backend';
import type { CloudConfig } from './config';
import type { RemoteDoc } from './records';
import type { OutgoingDoc, Remote } from './sync';

// Firebase behind the Backend interface: Authentication for the accounts,
// Firestore for the records. The only file that imports the Firebase SDK; it
// is loaded only by builds that have accounts.
//
// Firestore is used through its "lite" client: plain requests, no cache of its
// own and no live connection. The app's own database is the offline copy, and
// sync.ts decides what is sent and taken.

const PAGE = 400;

// How long an answer is waited for. The Firestore client sets no limit of its
// own, and a request that never comes back — a phone waking from sleep with a
// dead connection — would otherwise keep syncing, and signing out, waiting for good.
const ASK_MS = 60_000;
const WRITE_MS = 120_000;

function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new CloudError('offline', "The server didn't answer. Check the connection and try again.")), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const TROUBLES: Record<string, [Trouble, string]> = {
  'auth/invalid-credential': ['credentials', "That email and password don't match an account."],
  'auth/wrong-password': ['credentials', "That email and password don't match an account."],
  'auth/user-not-found': ['credentials', "That email and password don't match an account."],
  'auth/user-disabled': ['denied', 'This account has been switched off.'],
  'auth/email-already-in-use': ['emailInUse', 'There is already an account with that address. Sign in instead.'],
  'auth/weak-password': ['weakPassword', 'That password is too easy to guess. Choose a longer one.'],
  'auth/password-does-not-meet-requirements': ['weakPassword', 'That password is too easy to guess. Choose a longer one.'],
  'auth/invalid-email': ['badEmail', "That doesn't look like an email address."],
  'auth/missing-email': ['badEmail', 'Enter your email address.'],
  'auth/too-many-requests': ['tooManyTries', 'Too many tries. Wait a few minutes and try again.'],
  'auth/network-request-failed': ['offline', "Couldn't reach the server. Check the connection and try again."],
  'permission-denied': ['denied', "This account isn't on the guest list."],
  unauthenticated: ['denied', 'The login has expired. Sign in again.'],
  'resource-exhausted': ['quota', "Today's free allowance is used up. Syncing picks up again tomorrow."],
  unavailable: ['offline', "Couldn't reach the server. Check the connection and try again."],
  'deadline-exceeded': ['offline', "Couldn't reach the server. Check the connection and try again."],
};

/** Any failure as one the app knows how to talk about. */
function explain(error: unknown): CloudError {
  if (error instanceof CloudError) return error;
  const code = error instanceof FirebaseError ? error.code : '';
  const known = TROUBLES[code];
  if (known) return new CloudError(known[0], known[1]);
  // A request that never got an answer: the browser's own error, or — from the
  // Firestore client, which has no code for it — "unknown: Request failed…".
  const unanswered = error instanceof TypeError || (code === 'unknown' && /request failed/i.test((error as Error).message));
  if (unanswered) return new CloudError('offline', "Couldn't reach the server. Check the connection and try again.");
  return new CloudError('other', 'Something went wrong. Try again.');
}

async function attempt<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw explain(error);
  }
}

const accountOf = (user: User | null): Account | null =>
  (user && user.email ? { uid: user.uid, email: user.email, verified: user.emailVerified } : null);

export function connect(config: CloudConfig): Backend {
  const app = initializeApp({
    apiKey: config.apiKey, authDomain: config.authDomain, projectId: config.projectId, appId: config.appId,
  });
  // Named ways of staying signed in only: the sign-in windows and redirects of
  // other login methods are not loaded, and with them goes the need to allow frames.
  const auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  const db = getFirestore(app);
  if (config.authEmulator) connectAuthEmulator(auth, config.authEmulator, { disableWarnings: true });
  if (config.firestoreEmulator) {
    const [host, port] = config.firestoreEmulator.split(':');
    connectFirestoreEmulator(db, host, Number(port));
  }

  const signedIn = (): User => {
    if (!auth.currentUser) throw new CloudError('denied', 'The login has expired. Sign in again.');
    return auth.currentUser;
  };
  const records = (uid: string) => collection(db, 'users', uid, 'records');

  const remote = (uid: string): Remote => ({
    changedSince: (since) => attempt(async () => {
      const found: RemoteDoc[] = [];
      let last: QueryDocumentSnapshot | null = null;
      for (;;) {
        const after: ReturnType<typeof startAfter>[] = last ? [startAfter(last)] : [];
        const page = await within(ASK_MS, getDocs(query(records(uid), where('t', '>', Timestamp.fromMillis(since)), orderBy('t'), ...after, limit(PAGE))));
        for (const item of page.docs) {
          const data = item.data();
          const written = data.t instanceof Timestamp ? data.t.toMillis() : 0;
          const wellFormed = typeof data.k === 'string' && typeof data.p === 'string' && typeof data.v === 'number';
          found.push({
            key: item.id,
            kind: wellFormed ? data.k : '',
            payload: wellFormed ? data.p : '',
            deleted: data.d === true,
            // 0 is no format the app knows, so a malformed document is left alone like any it can't read.
            format: wellFormed ? data.v : 0,
            at: written,
          });
        }
        if (page.docs.length < PAGE) return found;
        last = page.docs[page.docs.length - 1];
      }
    }),
    write: (docs: OutgoingDoc[]) => attempt(async () => {
      const batch = writeBatch(db);
      for (const item of docs) {
        batch.set(doc(records(uid), item.key), { k: item.kind, p: item.payload, d: item.deleted, t: serverTimestamp(), v: 1 });
      }
      await within(WRITE_MS, batch.commit());
    }),
  });

  return {
    watch: (listener) => onAuthStateChanged(auth, (user) => listener(accountOf(user))),
    signIn: (email, password) => attempt(async () => {
      await within(ASK_MS, signInWithEmailAndPassword(auth, email, password));
    }),
    signUp: (email, password) => attempt(async () => {
      const { user } = await within(ASK_MS, createUserWithEmailAndPassword(auth, email, password));
      // The account exists from here on; a link that couldn't be sent can be asked for again.
      return within(ASK_MS, sendEmailVerification(user)).then(() => true, () => false);
    }),
    sendVerification: () => attempt(() => within(ASK_MS, sendEmailVerification(signedIn()))),
    refresh: () => attempt(async () => {
      const user = auth.currentUser;
      if (!user) return null;
      await within(ASK_MS, user.reload());
      // The proof that the address is confirmed travels in the token, so a fresh one is needed too.
      await within(ASK_MS, user.getIdToken(true));
      return accountOf(auth.currentUser);
    }),
    resetPassword: (email) => attempt(() => within(ASK_MS, sendPasswordResetEmail(auth, email))),
    signOut: () => attempt(() => signOut(auth)),
    invited: () => attempt(async () => (await within(ASK_MS, getDoc(doc(db, 'allowed', signedIn().email ?? '')))).exists()),
    remote,
    confirmPassword: (password) => attempt(async () => {
      const user = signedIn();
      await within(ASK_MS, reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email ?? '', password)));
    }),
    deleteEverything: () => attempt(async () => {
      const user = signedIn();
      for (;;) {
        const page = await within(ASK_MS, getDocs(query(records(user.uid), limit(PAGE))));
        if (page.docs.length === 0) break;
        const batch = writeBatch(db);
        for (const item of page.docs) batch.delete(item.ref);
        await within(WRITE_MS, batch.commit());
      }
      await within(ASK_MS, deleteUser(user));
    }),
  };
}
