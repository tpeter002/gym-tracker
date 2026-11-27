import type { Remote } from './sync';

// What the app asks of the service that holds the accounts. firebase.ts is
// the one that answers; nothing else knows it is Firebase.

/** Who is signed in. */
export interface Account {
  uid: string;
  email: string;
  /** Whether the address has been confirmed through the link sent to it. */
  verified: boolean;
}

export type Trouble =
  /** The email and password don't belong together. */
  | 'credentials'
  | 'emailInUse'
  | 'weakPassword'
  | 'badEmail'
  | 'tooManyTries'
  /** The service couldn't be reached. */
  | 'offline'
  /** The service is there and says no: not invited, or no longer. */
  | 'denied'
  /** The free plan's allowance for the day is used up. */
  | 'quota'
  | 'other';

/** Something the service refused or couldn't do. `message` is written for the person using the app. */
export class CloudError extends Error {
  constructor(readonly trouble: Trouble, message: string) {
    super(message);
  }
}

export interface Backend {
  /** Calls `listener` with who is signed in: once at the start, then at every change — in this tab or another. */
  watch(listener: (account: Account | null) => void): () => void;
  signIn(email: string, password: string): Promise<void>;
  /** Creates the account and sends the link that confirms the address. false: the account is there, but the link could not be sent. */
  signUp(email: string, password: string): Promise<boolean>;
  sendVerification(): Promise<void>;
  /** Asks the service afresh about the signed-in account — has the address been confirmed since? */
  refresh(): Promise<Account | null>;
  resetPassword(email: string): Promise<void>;
  signOut(): Promise<void>;
  /** Whether the signed-in address is on the guest list. */
  invited(): Promise<boolean>;
  /** The signed-in account's records. */
  remote(uid: string): Remote;
  /** Asks for the password again: a deletion is only carried out for a login that is fresh. Changes nothing. */
  confirmPassword(password: string): Promise<void>;
  /** Deletes every record of the signed-in account, then the login itself. May stop part-way when the connection does. */
  deleteEverything(): Promise<void>;
}
