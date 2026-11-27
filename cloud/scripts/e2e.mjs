// Runs the browser tests of the version with accounts (web/tests/cloud)
// against the Firebase emulators: Authentication, Firestore with the real
// rules, and Hosting with the real headers.
//
//   npm run test:e2e                 everything
//   npm run test:e2e -- --grep sign  arguments after -- go to Playwright
//
// The app is built for a made-up project (web/.env.emulators) into its own
// folder, so neither the ordinary build nor a real project is touched.

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cloud = fileURLToPath(new URL('..', import.meta.url));
const web = fileURLToPath(new URL('../../web', import.meta.url));
const run = (command, args, cwd) => spawnSync(command, args, { cwd, stdio: 'inherit' }).status ?? 1;

if (run('npm', ['run', 'build:emulators'], web) !== 0) process.exit(1);

// The deployed configuration, headers and all, with one difference: the folder that is served.
const config = JSON.parse(readFileSync(new URL('../firebase.json', import.meta.url), 'utf8'));
config.hosting.public = '../web/dist-emulators';
const derived = new URL('../firebase.e2e.json', import.meta.url);
writeFileSync(derived, JSON.stringify(config, null, 2));

const playwright = ['npx', 'playwright', 'test', '--config', 'playwright.cloud.config.ts', ...process.argv.slice(2)]
  .map((part) => (/^[\w./:=@-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`)).join(' ');
let status = 1;
try {
  status = run('npx', [
    'firebase', '--config', 'firebase.e2e.json', 'emulators:exec', '--project', 'demo-gym-tracker',
    '--only', 'auth,firestore,hosting', `cd '${web}' && ${playwright}`,
  ], cloud);
} finally {
  rmSync(derived, { force: true });
}
process.exit(status);
