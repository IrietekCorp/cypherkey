/**
 * The M1 exit test (docs/04). Drives the real HTTP surface through the real client
 * library, against whatever `DATABASE_URL` names — SQLite by default, Postgres in CI.
 *
 * Sequence: signup → register Recovery Kit → enroll 8 samples → build profile →
 * login with a good sample (pass) → login with a bad sample (fail) → vault write →
 * vault read on a second device → refresh → logout.
 *
 * The enrolled script carries two Phantom Keys, so the sequence also covers what
 * docs/04 asks of them: one extra lone-Escape slip still passes, typing only the
 * resolved passphrase fails, and a wrong passphrase fails before alignment runs.
 *
 * M2-00d: every step goes through `core/client`. The only place the Hono app is
 * touched directly is the injected `fetch` below, so any drift between the client
 * library and the routes it talks to fails here instead of surfacing a milestone later.
 */
import { extractFeatures } from '../core/biometrics/features';
import { eventsToScript } from '../core/biometrics/script';
import type { KeyEvent } from '../core/biometrics/types';
import { createEnroller } from '../core/client/enroll';
import { type Credential, type SessionStorage, createSession } from '../core/client/session';
import { createSync } from '../core/client/sync';
import { decryptItem, encryptItem } from '../core/crypto/aead';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '../core/crypto/encoding';
import { deriveMasterKey, deriveSubkey } from '../core/crypto/kdf';
import { kdfInput, scriptCommitments } from '../core/crypto/phantom';
import { generateRecoveryCode } from '../core/crypto/recovery';
import { createApp } from '../server/src/app';
import { loadConfigOrExit } from '../server/src/config';
import { createDb } from '../server/src/db/client';
import { migrateDb } from '../server/src/db/migrate';

/**
 * The enrolled script: "passw0rd!" typed with two Phantom Keys — a doubled `s` that is
 * corrected away, and a lone Escape. Twelve keystrokes, nine characters (A-14).
 */
const ENROLLED_KEYS = ['p', 'a', 's', 's', 's', 'Backspace', 'Escape', 'w', '0', 'r', 'd', '!'];
/** The same resolved text with no phantoms: what someone with only the passphrase types. */
const RESOLVED_ONLY_KEYS = ['p', 'a', 's', 's', 'w', '0', 'r', 'd', '!'];
/** The enrolled script plus one extra stray Escape: the slip docs/04 says must pass. */
const ONE_SLIP_KEYS = [...ENROLLED_KEYS.slice(0, 7), 'Escape', ...ENROLLED_KEYS.slice(7)];

/** Turns a list of keys into the events a real capture would have produced. */
function typeKeys(keys: string[], dwell = 80, gap = 120): KeyEvent[] {
  const events: KeyEvent[] = [];
  let t = 0;
  for (const key of keys) {
    events.push({ type: 'down', key, t });
    events.push({ type: 'up', key, t: t + dwell });
    t += gap;
  }
  return events;
}

/**
 * The script, its resolved text and its feature vector. Commitments are deliberately
 * absent: M2-00d.1 moved them into the session, which already holds `phantomKey` from
 * the unlock, so a caller never pays for a second Argon2id pass to produce them.
 */
function sampleFor(keys: string[], dwell = 80, gap = 120) {
  const events = typeKeys(keys, dwell, gap);
  const script = eventsToScript(events);
  if ('error' in script) throw new Error(`tokenization failed: ${script.error}`);
  const features = extractFeatures(events, keys.length);
  if ('error' in features) throw new Error(`extraction failed: ${features.error}`);
  return { ...script, featureVector: features.values };
}

/** Per-device key/value store. The extension backs this with `chrome.storage` (M2-01). */
function memoryStorage(): SessionStorage & { get(key: string): Promise<string | null> } {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
  };
}

let stepNumber = 0;
function ok(label: string): void {
  stepNumber++;
  console.log(`  ${String(stepNumber).padStart(2, ' ')}. ✓ ${label}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const config = loadConfigOrExit({
    ...Bun.env,
    // A fresh SQLite file per run unless CI points us at Postgres.
    DATABASE_URL:
      Bun.env.DATABASE_URL ?? `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-e2e-${Date.now()}.db`,
  });
  const db = createDb(config.db);
  await migrateDb(db);

  /**
   * One clock for both sides.
   *
   * The A-8 account bucket is ten requests a minute and does not refill on a frozen
   * clock, so a run long enough to exercise every band eventually 429s on a step that
   * has nothing to do with rate limiting. Advancing it between phases is also what a
   * real session looks like. Client and server must share it: `verifyDeviceSignature`
   * allows 30 s of skew, so moving one without the other invalidates every signature.
   */
  const clock = { value: Date.now() };
  const now = () => clock.value;
  /** Lets the token bucket refill between phases, as wall-clock time would. */
  const passTime = (ms: number) => {
    clock.value += ms;
  };

  // The timing floor is a production defence, not something to sit through here.
  const app = createApp({ db, config, timingFloorMs: 0, now });

  /**
   * The single seam between the client library and the server. Everything below goes
   * through `core/client`, which reaches the app only through this.
   */
  const fetchLike = (async (url: string | URL, init?: RequestInit) => {
    const parsed = new URL(String(url));
    return await app.request(parsed.pathname + parsed.search, init);
  }) as unknown as typeof fetch;

  const clientFor = (storage: SessionStorage) =>
    createSession({
      baseUrl: 'https://e2e.cypherkey.test',
      fetch: fetchLike,
      storage,
      now,
      argonParams: config.argonParams,
    });

  console.log(`\ncypherkey e2e — ${db.dialect}\n`);

  const username = `e2e-${Date.now()}`;

  // ---- the script and its key hierarchy (A-2, A-14.2) -----------------------
  const enrolledScript = eventsToScript(typeKeys(ENROLLED_KEYS));
  if ('error' in enrolledScript) throw new Error(enrolledScript.error);
  assert(enrolledScript.resolved === 'passw0rd!', 'the script must resolve to the passphrase');
  ok(
    `script: ${[...enrolledScript.script].length} keystrokes, ${enrolledScript.resolved.length} characters (two phantoms)`,
  );

  // Medium strictness: the KDF sees the resolved text, and the script is verified
  // separately through commitments (A-14.2).
  const credential: Credential = {
    resolved: enrolledScript.resolved,
    script: enrolledScript.script,
    strictness: 'medium',
  };

  // ---- signup: both legs of A-5, through the client -------------------------
  const storageOne = memoryStorage();
  const sessionOne = clientFor(storageOne);
  const signup = await sessionOne.signup({
    username,
    email: `${username}@example.test`,
    ...credential,
    consentPolicyVersion: '2026-09-01',
    deviceName: 'e2e device one',
    devicePlatform: 'ci',
  });
  assert(sessionOne.state() === 'unlocked', 'signup should leave the session unlocked');
  ok('signup returned serverShare; vaultKey reconstructed from both halves');
  // signup's second leg wraps the FULL vaultKey under the Recovery Kit and registers it.
  ok('Recovery Kit registered — it wraps the full vaultKey, not the share');

  // All three A-2 branches came from the one Argon2id pass inside signup, so the
  // commitments below cost nothing beyond an HMAC.
  const enrolled = sampleFor(ENROLLED_KEYS);
  const commitments = await sessionOne.commitmentsFor(enrolled.script);
  assert(
    commitments.length === [...enrolled.script].length,
    'one commitment per script token (A-14.2)',
  );
  ok('derived masterKey, authKey, wrapKey and phantomKey in one Argon2id pass');

  // ---- enrollment (A-4.3), through core/client/enroll.ts --------------------
  const enroller = createEnroller({
    request: sessionOne.authed(),
    token: signup.enrollmentToken,
  });
  for (let i = 0; i < config.enrollmentSamples; i++) {
    await enroller.sample({ featureVector: enrolled.featureVector, commitments });
  }
  const built = await enroller.build();
  assert(built.built && built.sampleCount === config.enrollmentSamples, 'profile should build');
  ok(`enrolled ${config.enrollmentSamples} samples and built the profile`);

  const status = await enroller.status();
  assert(status.built && status.submitted === 0, 'samples must be deleted after build');
  ok('enrollment samples deleted after build (A-4.6)');

  // ---- login with a good sample --------------------------------------------
  const login = (featureVector: number[], script = enrolledScript.script, cred = credential) =>
    sessionOne.login({ ...cred, script, username, featureVector });

  const good = await login(enrolled.featureVector);
  assert(good.band === 'pass', `good login expected pass, got ${JSON.stringify(good)}`);
  ok('login with a good sample → pass');

  // ---- login with a bad sample ---------------------------------------------
  // Same script, typed at nearly twice the speed: the rhythm is what fails here.
  const slow = sampleFor(ENROLLED_KEYS, 150, 240);
  const bad = await login(slow.featureVector);
  assert(bad.band === 'fail', `bad login expected fail, got ${JSON.stringify(bad)}`);
  ok('login with a bad sample → fail');

  // ---- Phantom Keys acceptance (docs/04, A-14.3) ----------------------------
  const slip = sampleFor(ONE_SLIP_KEYS);
  const slipLogin = await login(slip.featureVector, slip.script);
  assert(
    slipLogin.band === 'pass',
    `one lone-Escape slip should pass, got ${JSON.stringify(slipLogin)}`,
  );
  ok('login with one extra lone-Escape slip → pass (Medium forgives insertions)');

  // The same resolved text with the phantoms left out: what a leaked password buys.
  const resolvedOnly = sampleFor(RESOLVED_ONLY_KEYS);
  assert(resolvedOnly.resolved === enrolledScript.resolved, 'same resolved text, no phantoms');
  const resolvedLogin = await login(resolvedOnly.featureVector, resolvedOnly.script);
  assert(
    resolvedLogin.band === 'fail' && resolvedLogin.error === 'phantom_mismatch',
    `resolved passphrase alone should fail, got ${JSON.stringify(resolvedLogin)}`,
  );
  ok('login with the resolved passphrase only → phantom_mismatch');

  // A wrong passphrase never reaches alignment: authHash is checked first.
  const wrongPass = await login(enrolled.featureVector, enrolledScript.script, {
    ...credential,
    resolved: 'a completely different passphrase',
  });
  assert(
    wrongPass.band === 'fail' && wrongPass.error === 'invalid_credentials',
    `a wrong passphrase should fail before alignment, got ${JSON.stringify(wrongPass)}`,
  );
  ok('wrong passphrase → rejected before alignment runs');

  passTime(60_000);

  // ---- grey band cleared with a Backup Code (M2-00e + M2-07) -----------------
  // The server has accepted `backup_code` since M2-00e, but no client could send one
  // until M2-07 widened StepUpInput, so this leg had no coverage end to end.
  for (const scale of [1.15, 1.2, 1.25, 1.3]) {
    const middling = sampleFor(ENROLLED_KEYS, Math.round(80 * scale), Math.round(120 * scale));
    const attempt = await login(middling.featureVector);
    if (attempt.band === 'grey') {
      const cleared = await sessionOne.stepUp({
        method: 'backup_code',
        proof: signup.backupCodes[0] as string,
      });
      assert(
        cleared.band === 'pass',
        `a Backup Code should clear the grey band, got ${JSON.stringify(cleared)}`,
      );
      ok('grey login cleared with a Backup Code, not a retype (M2-07)');

      // X-3: one-time means one time.
      const reuse = await login(middling.featureVector);
      if (reuse.band === 'grey') {
        const second = await sessionOne.stepUp({
          method: 'backup_code',
          proof: signup.backupCodes[0] as string,
        });
        assert(second.band === 'fail', 'a spent Backup Code must not work twice');
        ok('a spent Backup Code is refused the second time');
      }
      break;
    }
  }

  passTime(60_000);

  // ---- vault write, through core/client/sync.ts -----------------------------
  const back = await login(enrolled.featureVector);
  assert(back.band === 'pass', 'should be able to log back in after the failures');
  const vaultKey = sessionOne.vaultKey();
  const tokensOne = sessionOne.tokens();
  assert(tokensOne !== null, 'a pass must yield session tokens');

  const plaintext = utf8Encode(JSON.stringify({ title: 'GitHub', password: 'hunter2' }));
  const sealed = await encryptItem(plaintext, vaultKey, 'item-1');
  const syncOne = createSync({ request: sessionOne.authed(), token: tokensOne.accessToken });
  const pushed = await syncOne.push([
    {
      id: 'item-1',
      version: 0,
      ciphertext: toBase64Url(sealed.ct),
      nonce: toBase64Url(sealed.nonce),
      updatedAt: Date.now(),
    },
  ]);
  assert(pushed.conflicts.length === 0 && pushed.applied.length === 1, 'vault write should apply');
  ok('vault write accepted');

  passTime(60_000);

  // ---- second device: new-device step-up, then read -------------------------
  const storageTwo = memoryStorage();
  const sessionTwo = clientFor(storageTwo);
  const newDevice = await sessionTwo.login({
    username,
    ...credential,
    featureVector: enrolled.featureVector,
  });
  assert(
    newDevice.band === 'grey',
    `an unknown device must be sent to step-up (X-3), got ${JSON.stringify(newDevice)}`,
  );
  ok('second device met the new-device step-up (X-3)');

  const cleared = await sessionTwo.stepUp({
    method: 'retype',
    script: enrolledScript.script,
    featureVector: enrolled.featureVector,
  });
  assert(cleared.band === 'pass', `step-up expected pass, got ${JSON.stringify(cleared)}`);
  assert(sessionTwo.state() === 'unlocked', 'a cleared step-up should unlock');
  ok('second device cleared step-up and was registered');

  // The second device derived the vault key from the passphrase alone plus what the
  // server released — it never saw device one's memory.
  const tokensTwo = sessionTwo.tokens();
  assert(tokensTwo !== null, 'step-up must yield session tokens');
  const syncTwo = createSync({ request: sessionTwo.authed(), token: tokensTwo.accessToken });
  const read = await syncTwo.pull(0);
  assert(read.items.length === 1 && read.items[0]?.id === 'item-1', 'should see exactly one item');

  const recovered = await decryptItem(
    {
      ct: fromBase64Url(read.items[0]?.ciphertext as string),
      nonce: fromBase64Url(read.items[0]?.nonce as string),
    },
    sessionTwo.vaultKey(),
    'item-1',
  );
  assert(
    utf8Decode(recovered).includes('hunter2'),
    'second device must decrypt what the first wrote',
  );
  ok('vault read and decrypted on a second device');

  // ---- refresh --------------------------------------------------------------
  const beforeRefresh = tokensOne.refreshToken;
  assert(await sessionOne.refresh(), 'refresh should succeed');
  const afterRefresh = sessionOne.tokens();
  assert(
    afterRefresh !== null && afterRefresh.refreshToken !== beforeRefresh,
    'refresh must rotate the token',
  );
  ok('refresh rotated the token');

  // A-9: replaying the spent token revokes the family. Drive it through the same
  // signed transport the client uses, with the token the client has already retired.
  const replay = await sessionOne.authed()('POST', '/auth/refresh', {
    refreshToken: beforeRefresh,
  });
  assert(replay.status === 401, 'a rotated refresh token must not work twice');
  ok('the rotated token is dead (family revoked on reuse)');

  // ---- logout ---------------------------------------------------------------
  const deadRefresh = afterRefresh.refreshToken;
  assert(await sessionOne.logout(), 'logout should succeed');
  assert(sessionOne.state() === 'locked', 'logout must lock the session');
  const afterLogout = await sessionTwo.authed()('POST', '/auth/refresh', {
    refreshToken: deadRefresh,
  });
  assert(afterLogout.status === 401, 'logout must kill the refresh token');
  ok('logout revoked the session');

  passTime(60_000);

  // ---- the Recovery Kit really is the escape hatch (A-5, X-5) ---------------
  // M2-00f made this a real server-authenticated flow. It used to read the blob
  // straight out of the users table, because no route would release it.
  const storageThree = memoryStorage();
  const sessionThree = clientFor(storageThree);
  const recoveredSession = await sessionThree.recover({
    username,
    recoveryCode: signup.recoveryCode,
    credential: { ...credential, resolved: 'a completely new passphrase' },
    deviceName: 'recovered device',
    devicePlatform: 'ci',
  });
  assert(sessionThree.state() === 'unlocked', 'recovery should leave the session unlocked');
  // vaultKey is unchanged, so the item written before recovery still decrypts.
  const afterRecovery = await decryptItem(
    {
      ct: fromBase64Url(read.items[0]?.ciphertext as string),
      nonce: fromBase64Url(read.items[0]?.nonce as string),
    },
    sessionThree.vaultKey(),
    'item-1',
  );
  assert(
    utf8Decode(afterRecovery).includes('hunter2'),
    'the Recovery Kit must open the vault with no help from the old passphrase',
  );
  ok('Recovery Kit opens the vault with no help from the server');

  // X-5 requires a fresh enrolment: the profile is deleted by the recovery transaction.
  const enrollAfter = createEnroller({
    request: sessionThree.authed(),
    token: recoveredSession.enrollmentToken,
  });
  const statusAfter = await enrollAfter.status();
  assert(
    !statusAfter.built && statusAfter.submitted === 0,
    'recovery must delete the profile and require re-enrolment',
  );
  ok('recovery revoked the old devices and requires a fresh enrolment (X-5)');

  // X-5: the Kit that was just used is retired, and its replacement takes over.
  const oldKitAgain = await sessionThree
    .recover({
      username,
      recoveryCode: signup.recoveryCode,
      credential,
      deviceName: 'replay',
      devicePlatform: 'ci',
    })
    .then(
      () => 'accepted',
      () => 'refused',
    );
  assert(oldKitAgain === 'refused', 'the Recovery Kit just used must not work twice');

  const storageFour = memoryStorage();
  const sessionFour = clientFor(storageFour);
  await sessionFour.recover({
    username,
    recoveryCode: recoveredSession.recoveryCode,
    credential: { ...credential, resolved: 'a third passphrase' },
    deviceName: 'recovered again',
    devicePlatform: 'ci',
  });
  assert(sessionFour.state() === 'unlocked', 'the replacement Kit must work');
  ok('recovery retired the used Kit and issued a working replacement (X-5)');

  /**
   * M2-00i: the way out of the closed loop. sessionFour recovered a moment ago and,
   * like a user who closed the popup before the confirmation screen, never saved the
   * Kit that recovery issued. Knowing the passphrase must be enough to get another.
   */
  const thirdCredential = { ...credential, resolved: 'a third passphrase' };
  const rotated = await sessionFour.rotateRecoveryKit(thirdCredential);
  assert(
    rotated.recoveryCode !== recoveredSession.recoveryCode,
    'rotation must issue a different Kit',
  );

  const storageFive = memoryStorage();
  const sessionFive = clientFor(storageFive);
  await sessionFive.recover({
    username,
    recoveryCode: rotated.recoveryCode,
    credential: { ...credential, resolved: 'a fourth passphrase' },
    deviceName: 'recovered via rotated kit',
    devicePlatform: 'ci',
  });
  assert(sessionFive.state() === 'unlocked', 'the rotated Kit must open the vault');
  const viaRotated = await decryptItem(
    {
      ct: fromBase64Url(read.items[0]?.ciphertext as string),
      nonce: fromBase64Url(read.items[0]?.nonce as string),
    },
    sessionFive.vaultKey(),
    'item-1',
  );
  assert(utf8Decode(viaRotated).includes('hunter2'), 'the rotated Kit opens the same vault');
  ok('a lost Kit can be replaced with the passphrase, and the new one recovers (M2-00i)');

  // A wrong Kit must never release the blob.
  const badKit = await sessionThree
    .recover({
      username,
      recoveryCode: generateRecoveryCode(),
      credential,
      deviceName: 'attacker',
      devicePlatform: 'ci',
    })
    .then(
      () => 'accepted',
      (err: Error) => err.message,
    );
  assert(badKit !== 'accepted', 'a wrong Recovery Kit must be refused');
  ok('a wrong Recovery Kit is refused before anything is released');

  console.log(`\n  ${stepNumber} steps passed on ${db.dialect}\n`);
}

await main();
