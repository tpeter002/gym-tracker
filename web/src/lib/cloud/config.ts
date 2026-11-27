// Whether this build has accounts, and where they live.
//
// Without the settings below the app is what it has always been: everything
// in this browser, no login. With them (see cloud/README.md) it asks for a
// login and keeps each account in step across that person's devices.

export interface CloudConfig {
  apiKey: string;
  authDomain: string;
  projectId: string;
  appId: string;
  /** Local emulators in place of the real services, for the tests: "http://localhost:9099" and "localhost:8089". */
  authEmulator: string;
  firestoreEmulator: string;
  /** Who runs this copy and how to reach them, for the note on where data is kept. */
  operator: string;
  /** Where the database is, in words, for the same note. */
  region: string;
}

const env = import.meta.env;
const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

export const cloudConfig: CloudConfig | null = text(env.VITE_FIREBASE_PROJECT_ID) && text(env.VITE_FIREBASE_API_KEY)
  ? {
    apiKey: text(env.VITE_FIREBASE_API_KEY),
    authDomain: text(env.VITE_FIREBASE_AUTH_DOMAIN),
    projectId: text(env.VITE_FIREBASE_PROJECT_ID),
    appId: text(env.VITE_FIREBASE_APP_ID),
    authEmulator: text(env.VITE_FIREBASE_AUTH_EMULATOR),
    firestoreEmulator: text(env.VITE_FIREBASE_FIRESTORE_EMULATOR),
    operator: text(env.VITE_OPERATOR),
    region: text(env.VITE_DATA_REGION),
  }
  : null;
