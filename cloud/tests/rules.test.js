import { readFileSync } from 'node:fs';
import { assertFails, assertSucceeds, initializeTestEnvironment } from '@firebase/rules-unit-testing';
import {
  collection, deleteDoc, doc, getDoc, getDocs, orderBy, query, serverTimestamp, setDoc, Timestamp, updateDoc, where,
} from 'firebase/firestore';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

// firestore.rules against the Firestore emulator (`npm test` starts it): who
// gets in, that nobody reaches another person's records, and what a record
// has to look like. The people and addresses are made up.

const ALICE = { uid: 'alice', email: 'alice@example.com' };
const BOB = { uid: 'bob', email: 'bob@example.com' };
/** Has an account and a proven address, but nobody invited her. */
const CAROL = { uid: 'carol', email: 'carol@example.com' };

let env;

beforeAll(async () => {
  env = await initializeTestEnvironment({
    projectId: 'demo-gym-tracker',
    firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') },
  });
});

afterAll(() => env.cleanup());

beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, 'allowed', ALICE.email), {});
    await setDoc(doc(db, 'allowed', BOB.email), {});
    await setDoc(doc(db, 'users/alice/records/workouts_w1'), record({ p: '{"id":"w1","name":"Push"}' }, Timestamp.now()));
    await setDoc(doc(db, 'users/bob/records/workouts_w9'), record({ p: '{"id":"w9","name":"Legs"}' }, Timestamp.now()));
  });
});

/** A record as the app writes it; `changes` replace fields, and a field set to undefined is left out. */
function record(changes = {}, t = serverTimestamp()) {
  const fields = { k: 'workouts', p: '{"id":"w2"}', d: false, t, v: 1, ...changes };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

/** The database as this person's signed-in app sees it. */
const as = (person, token = {}) =>
  env.authenticatedContext(person.uid, { email: person.email, email_verified: true, ...token }).firestore();
const stranger = () => env.unauthenticatedContext().firestore();

const records = (db, uid) => collection(db, `users/${uid}/records`);

describe('an invited person', () => {
  it('reads, adds, changes and deletes their own records', async () => {
    const db = as(ALICE);
    await assertSucceeds(getDoc(doc(db, 'users/alice/records/workouts_w1')));
    await assertSucceeds(setDoc(doc(db, 'users/alice/records/workouts_w2'), record()));
    await assertSucceeds(setDoc(doc(db, 'users/alice/records/workouts_w1'), record({ p: '', d: true })));
    await assertSucceeds(deleteDoc(doc(db, 'users/alice/records/workouts_w2')));
  });

  it('asks for what changed since a moment, which is how a device catches up', async () => {
    const changed = query(records(as(ALICE), 'alice'), where('t', '>', Timestamp.fromMillis(0)), orderBy('t'));
    const found = await assertSucceeds(getDocs(changed));
    expect(found.docs.map((item) => item.id)).toEqual(['workouts_w1']);
  });

  it("can't read another person's records, one by one or as a list", async () => {
    const db = as(ALICE);
    await assertFails(getDoc(doc(db, 'users/bob/records/workouts_w9')));
    await assertFails(getDocs(records(db, 'bob')));
    await assertFails(getDocs(query(records(db, 'bob'), where('t', '>', Timestamp.fromMillis(0)))));
  });

  it("can't add to, change or delete another person's records", async () => {
    const db = as(ALICE);
    await assertFails(setDoc(doc(db, 'users/bob/records/workouts_w2'), record()));
    await assertFails(setDoc(doc(db, 'users/bob/records/workouts_w9'), record()));
    await assertFails(updateDoc(doc(db, 'users/bob/records/workouts_w9'), { d: true, t: serverTimestamp() }));
    await assertFails(deleteDoc(doc(db, 'users/bob/records/workouts_w9')));
  });

  it('gets nowhere by claiming another id in the path while signed in as themselves', async () => {
    // The token says alice; the address and the list say bob is invited too. Only the token's id counts.
    const db = env.authenticatedContext('alice', { email: BOB.email, email_verified: true }).firestore();
    await assertFails(getDoc(doc(db, 'users/bob/records/workouts_w9')));
  });
});

describe('getting in', () => {
  it('takes a login', async () => {
    const db = stranger();
    await assertFails(getDoc(doc(db, 'users/alice/records/workouts_w1')));
    await assertFails(getDocs(records(db, 'alice')));
    await assertFails(setDoc(doc(db, 'users/alice/records/workouts_w2'), record()));
    await assertFails(deleteDoc(doc(db, 'users/alice/records/workouts_w1')));
  });

  it('takes an invitation to write: an account alone can store nothing, not even in a space of its own', async () => {
    const db = as(CAROL);
    await assertFails(setDoc(doc(db, 'users/carol/records/workouts_w2'), record()));
    await assertFails(setDoc(doc(db, 'users/alice/records/workouts_w2'), record()));
    await assertFails(getDoc(doc(db, 'users/alice/records/workouts_w1')));
    await assertFails(getDocs(records(db, 'alice')));
    // Its own space it may look into; there is nothing there.
    const own = await assertSucceeds(getDocs(records(db, 'carol')));
    expect(own.size).toBe(0);
  });

  it('takes a proven address: signing up with an invited address is not enough', async () => {
    const db = as(ALICE, { email_verified: false });
    await assertFails(getDoc(doc(db, 'users/alice/records/workouts_w1')));
    await assertFails(setDoc(doc(db, 'users/alice/records/workouts_w2'), record()));
  });

  it('takes an address at all', async () => {
    const db = env.authenticatedContext('alice', {}).firestore();
    await assertFails(getDoc(doc(db, 'users/alice/records/workouts_w1')));
  });

  it('ends when the address is taken off the list — but what is theirs they can still fetch and delete', async () => {
    await env.withSecurityRulesDisabled((context) => deleteDoc(doc(context.firestore(), 'allowed', ALICE.email)));
    const db = as(ALICE);
    await assertFails(setDoc(doc(db, 'users/alice/records/workouts_w2'), record()));
    await assertFails(setDoc(doc(db, 'users/alice/records/workouts_w1'), record({ p: '{"id":"w1","name":"Changed"}' })));
    await assertFails(updateDoc(doc(db, 'users/alice/records/workouts_w1'), { d: true, p: '', t: serverTimestamp() }));
    await assertSucceeds(getDoc(doc(db, 'users/alice/records/workouts_w1')));
    await assertSucceeds(getDocs(records(db, 'alice')));
    await assertSucceeds(deleteDoc(doc(db, 'users/alice/records/workouts_w1')));
    // Nobody else's, as ever.
    await assertFails(getDoc(doc(db, 'users/bob/records/workouts_w9')));
    await assertFails(deleteDoc(doc(db, 'users/bob/records/workouts_w9')));
  });

  it('gives a login with an unproven address nothing at all, its own records included', async () => {
    const db = as(ALICE, { email_verified: false });
    await assertFails(getDocs(records(db, 'alice')));
    await assertFails(deleteDoc(doc(db, 'users/alice/records/workouts_w1')));
  });
});

describe('the guest list', () => {
  it('tells a person whether they are on it', async () => {
    await assertSucceeds(getDoc(doc(as(ALICE), 'allowed', ALICE.email)));
    const answer = await assertSucceeds(getDoc(doc(as(CAROL), 'allowed', CAROL.email)));
    expect(answer.exists()).toBe(false);
  });

  it('tells nobody about anyone else', async () => {
    await assertFails(getDoc(doc(as(ALICE), 'allowed', BOB.email)));
    await assertFails(getDocs(collection(as(ALICE), 'allowed')));
    await assertFails(getDoc(doc(stranger(), 'allowed', ALICE.email)));
    await assertFails(getDoc(doc(as(ALICE, { email_verified: false }), 'allowed', ALICE.email)));
  });

  it("can't be written by the app — not to invite oneself, not to remove another", async () => {
    await assertFails(setDoc(doc(as(CAROL), 'allowed', CAROL.email), {}));
    await assertFails(setDoc(doc(as(ALICE), 'allowed', CAROL.email), {}));
    await assertFails(deleteDoc(doc(as(ALICE), 'allowed', BOB.email)));
    await assertFails(setDoc(doc(stranger(), 'allowed', 'someone@example.com'), {}));
  });
});

describe('what a record has to look like', () => {
  const write = (key, fields) => setDoc(doc(as(ALICE), `users/alice/records/${key}`), fields);

  it('is one of the known kinds, under a name that starts with its kind', async () => {
    for (const kind of ['exercises', 'workouts', 'bodyWeights', 'videos', 'settings', 'meta']) {
      await assertSucceeds(write(`${kind}_a1`, record({ k: kind })));
    }
    await assertFails(write('secrets_a1', record({ k: 'secrets' })));
    await assertFails(write('workouts_a1', record({ k: 'exercises' })));
    await assertFails(write('a1', record()));
    await assertFails(write('workouts_', record()));
    await assertFails(write('workouts_a b', record()));
    await assertFails(write(`workouts_${'a'.repeat(101)}`, record()));
  });

  it('carries exactly the five fields', async () => {
    await assertFails(write('workouts_w2', record({ owner: 'bob' })));
    for (const field of ['k', 'p', 'd', 't', 'v']) {
      await assertFails(write('workouts_w2', record({ [field]: undefined })));
    }
  });

  it('holds its content as text of a bounded size', async () => {
    await assertSucceeds(write('workouts_w2', record({ p: 'x'.repeat(200_000) })));
    await assertFails(write('workouts_w2', record({ p: 'x'.repeat(200_001) })));
    // At three bytes a character, the longest text allowed still fits a document.
    await assertSucceeds(write('workouts_w2', record({ p: '語'.repeat(200_000) })));
    await assertFails(write('workouts_w2', record({ p: { id: 'w2' } })));
    await assertFails(write('workouts_w2', record({ p: 5 })));
  });

  it("is stamped with the server's time, not one the device made up", async () => {
    await assertFails(write('workouts_w2', record({}, Timestamp.fromMillis(Date.now() + 86_400_000))));
    await assertFails(write('workouts_w2', record({}, Timestamp.fromMillis(0))));
    await assertFails(write('workouts_w2', record({}, 'now')));
  });

  it('says whether it is deleted, and which format it is in', async () => {
    await assertFails(write('workouts_w2', record({ d: 'yes' })));
    await assertFails(write('workouts_w2', record({ v: 2 })));
    await assertFails(write('workouts_w2', record({ v: '1' })));
  });

  it('is held to the same on a change as on a first write', async () => {
    const mine = doc(as(ALICE), 'users/alice/records/workouts_w1');
    await assertSucceeds(updateDoc(mine, { p: '{"id":"w1","name":"Pull"}', t: serverTimestamp() }));
    await assertFails(updateDoc(mine, { p: '{"id":"w1","name":"Pull"}' })); // the old time stays
    await assertFails(updateDoc(mine, { k: 'secrets', t: serverTimestamp() }));
    await assertFails(updateDoc(mine, { extra: true, t: serverTimestamp() }));
  });
});

describe('everything else', () => {
  it('is closed, to everyone', async () => {
    await assertFails(getDoc(doc(as(ALICE), 'users/alice')));
    await assertFails(setDoc(doc(as(ALICE), 'users/alice'), { name: 'Alice' }));
    await assertFails(setDoc(doc(as(ALICE), 'users/alice/other/x'), record()));
    await assertFails(getDocs(collection(as(ALICE), 'users')));
    await assertFails(setDoc(doc(as(ALICE), 'anything/else'), {}));
    await assertFails(getDoc(doc(stranger(), 'anything/else')));
  });
});
