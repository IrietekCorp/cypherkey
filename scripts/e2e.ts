/**
 * The M1 exit test (docs/04). Drives the real HTTP surface with real client crypto,
 * against whatever `DATABASE_URL` names — SQLite by default, Postgres in CI.
 *
 * Sequence: signup → register Recovery Kit → enroll 8 samples → build profile →
 * login with a good sample (pass) → login with a bad sample (fail) → vault write →
 * vault read on a second device → refresh → logout.
 *
 * The enrolled script carries two Phantom Keys, so the sequence also covers what
 * docs/04 asks of them: one extra lone-Escape slip still passes, typing only the
 * resolved passphrase fails, and a wrong passphrase fails before alignment runs.
 */
import { extractFeatures } from '../core/biometrics/features';
import { eventsToScript } from '../core/biometrics/script';
import type { KeyEvent } from '../core/biometrics/types';
import { decryptItem, encryptItem, unwrapKey, wrapKey, xor32 } from '../core/crypto/aead';
import { generateDeviceKey, signRequest } from '../core/crypto/device';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '../core/crypto/encoding';
import { deriveMasterKey, deriveSubkey, randomBytes } from '../core/crypto/kdf';
import { kdfInput, scriptCommitments } from '../core/crypto/phantom';
import { generateRecoveryCode, recoveryKeyFromCode } from '../core/crypto/recovery';
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

/** The script, its resolved text, its feature vector and its commitments. */
async function sampleFor(keys: string[], phantomKey: Uint8Array, dwell = 80, gap = 120) {
  const events = typeKeys(keys, dwell, gap);
  const script = eventsToScript(events);
  if ('error' in script) throw new Error(`tokenization failed: ${script.error}`);
  const features = extractFeatures(events, keys.length);
  if ('error' in features) throw new Error(`extraction failed: ${features.error}`);
  return {
    ...script,
    featureVector: features.values,
    commitments: (await scriptCommitments(phantomKey, script.script)).map(toBase64Url),
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
  // The timing floor is a production defence, not something to sit through here.
  const app = createApp({ db, config, timingFloorMs: 0 });

  console.log(`\ncypherkey e2e — ${db.dialect}\n`);

  const username = `e2e-${Date.now()}`;
  const userSalt = randomBytes(16);

  // ---- client-side key hierarchy (A-2, A-14.2) -----------------------------
  const enrolledScript = eventsToScript(typeKeys(ENROLLED_KEYS));
  if ('error' in enrolledScript) throw new Error(enrolledScript.error);
  assert(enrolledScript.resolved === 'passw0rd!', 'the script must resolve to the passphrase');
  ok(
    `script: ${[...enrolledScript.script].length} keystrokes, ${enrolledScript.resolved.length} characters (two phantoms)`,
  );

  // Medium strictness: the KDF sees the resolved text, and the script is verified
  // separately through commitments (A-14.2).
  const masterKey = await deriveMasterKey(
    kdfInput(enrolledScript.resolved, enrolledScript.script, 'medium'),
    userSalt,
    config.argonParams,
  );
  const authKey = await deriveSubkey(masterKey, 'cypherkey/auth/v1');
  const wrapKeyBytes = await deriveSubkey(masterKey, 'cypherkey/wrap/v1');
  const phantomKey = await deriveSubkey(masterKey, 'cypherkey/phantom/v1');
  masterKey.fill(0);
  ok('derived masterKey, authKey, wrapKey and phantomKey');

  const enrolled = await sampleFor(ENROLLED_KEYS, phantomKey);

  const deviceOne = await generateDeviceKey();
  const deviceOneId = toBase64Url(deviceOne.pub);

  const call = async (
    method: string,
    path: string,
    body: unknown,
    signer: { priv: Uint8Array; id: string } | null,
    token?: string,
  ) => {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (token !== undefined) headers.authorization = `Bearer ${token}`;
    if (signer !== null) {
      const nonce = randomBytes(16);
      const ts = Date.now();
      headers['x-cypherkey-device'] = signer.id;
      headers['x-cypherkey-nonce'] = toBase64Url(nonce);
      headers['x-cypherkey-ts'] = String(ts);
      headers['x-cypherkey-signature'] = await signRequest(signer.priv, {
        nonce,
        ts,
        method,
        path,
        body: utf8Encode(serialized ?? ''),
      });
    }
    const res = await app.request(path, {
      method,
      headers,
      ...(serialized === undefined ? {} : { body: serialized }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  // ---- signup (A-5 handshake) ----------------------------------------------
  const vaultShare = randomBytes(32);
  const wrappedVaultKey = await wrapKey(vaultShare, wrapKeyBytes, 'cypherkey/wrap/vault-key/v1');
  const signup = await call(
    'POST',
    '/auth/signup',
    {
      username,
      email: `${username}@example.test`,
      authHash: toBase64Url(authKey),
      userSalt: toBase64Url(userSalt),
      wrappedVaultKey: {
        ct: toBase64Url(wrappedVaultKey.ct),
        nonce: toBase64Url(wrappedVaultKey.nonce),
      },
      devicePub: deviceOneId,
      deviceName: 'e2e device one',
      devicePlatform: 'ci',
      consentAt: Date.now(),
      consentPolicyVersion: '2026-09-01',
    },
    null,
  );
  assert(signup.status === 201, `signup expected 201, got ${signup.status}`);
  const serverShare = fromBase64Url(signup.body.serverShare as string);
  const enrollmentToken = signup.body.enrollmentToken as string;
  const vaultKey = xor32(vaultShare, serverShare);
  ok('signup returned serverShare; vaultKey reconstructed from both halves');

  // ---- Recovery Kit (second leg of signup) ---------------------------------
  const recoveryCode = generateRecoveryCode();
  const recoveryKey = await recoveryKeyFromCode(recoveryCode);
  const recoveryWrapped = await wrapKey(vaultKey, recoveryKey, 'cypherkey/wrap/vault-key/v1');
  const recovery = await call(
    'POST',
    '/auth/recovery-key',
    {
      recoveryWrappedVaultKey: {
        ct: toBase64Url(recoveryWrapped.ct),
        nonce: toBase64Url(recoveryWrapped.nonce),
      },
    },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(recovery.status === 200, `recovery-key expected 200, got ${recovery.status}`);
  ok('Recovery Kit registered — it wraps the full vaultKey, not the share');

  // ---- enrollment (A-4.3) ---------------------------------------------------
  for (let i = 0; i < config.enrollmentSamples; i++) {
    const res = await call(
      'POST',
      '/enroll/sample',
      { featureVector: enrolled.featureVector, commitments: enrolled.commitments },
      { priv: deviceOne.priv, id: deviceOneId },
      enrollmentToken,
    );
    assert(res.status === 200, `enroll sample ${i} expected 200, got ${res.status}`);
  }
  const built = await call(
    'POST',
    '/enroll/build',
    {},
    { priv: deviceOne.priv, id: deviceOneId },
    enrollmentToken,
  );
  assert(built.status === 200, `enroll build expected 200, got ${built.status}`);
  ok(`enrolled ${config.enrollmentSamples} samples and built the profile`);

  const samplesLeft = await call(
    'GET',
    '/enroll/status',
    undefined,
    { priv: deviceOne.priv, id: deviceOneId },
    enrollmentToken,
  );
  assert(
    samplesLeft.body.built === true && samplesLeft.body.submitted === 0,
    'samples must be deleted after build',
  );
  ok('enrollment samples deleted after build (A-4.6)');

  // ---- login with a good sample --------------------------------------------
  const good = await call(
    'POST',
    '/auth/login',
    {
      username,
      authHash: toBase64Url(authKey),
      featureVector: enrolled.featureVector,
      commitments: enrolled.commitments,
    },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(
    good.status === 200 && good.body.band === 'pass',
    `good login expected pass, got ${good.status} ${good.body.band}`,
  );
  const accessToken = good.body.accessToken as string;
  const refreshToken = good.body.refreshToken as string;
  ok('login with a good sample → pass');

  // ---- login with a bad sample ---------------------------------------------
  // Same script, typed at nearly twice the speed: the rhythm is what fails here.
  const slowSample = await sampleFor(ENROLLED_KEYS, phantomKey, 150, 240);
  const bad = await call(
    'POST',
    '/auth/login',
    {
      username,
      authHash: toBase64Url(authKey),
      featureVector: slowSample.featureVector,
      commitments: enrolled.commitments,
    },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(
    bad.status === 401 && bad.body.band === 'fail',
    `bad login expected fail, got ${bad.status}`,
  );
  ok('login with a bad sample → fail');

  // ---- Phantom Keys acceptance (docs/04, A-14.3) ----------------------------
  const slip = await sampleFor(ONE_SLIP_KEYS, phantomKey);
  const slipLogin = await call(
    'POST',
    '/auth/login',
    {
      username,
      authHash: toBase64Url(authKey),
      featureVector: slip.featureVector,
      commitments: slip.commitments,
    },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(
    slipLogin.status === 200 && slipLogin.body.band === 'pass',
    `one lone-Escape slip should pass, got ${slipLogin.status} ${String(slipLogin.body.band ?? slipLogin.body.error)}`,
  );
  ok('login with one extra lone-Escape slip → pass (Medium forgives insertions)');

  // The same resolved text with the phantoms left out: what a leaked password buys.
  const resolvedOnly = await sampleFor(RESOLVED_ONLY_KEYS, phantomKey);
  assert(resolvedOnly.resolved === enrolledScript.resolved, 'same resolved text, no phantoms');
  const resolvedLogin = await call(
    'POST',
    '/auth/login',
    {
      username,
      authHash: toBase64Url(authKey),
      featureVector: resolvedOnly.featureVector,
      commitments: resolvedOnly.commitments,
    },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(
    resolvedLogin.status === 401 && resolvedLogin.body.error === 'phantom_mismatch',
    `resolved passphrase alone should fail, got ${resolvedLogin.status} ${String(resolvedLogin.body.error)}`,
  );
  ok('login with the resolved passphrase only → phantom_mismatch');

  // A wrong passphrase never reaches alignment: authHash is checked first.
  const wrongPass = await call(
    'POST',
    '/auth/login',
    {
      username,
      authHash: toBase64Url(randomBytes(32)),
      featureVector: enrolled.featureVector,
      commitments: enrolled.commitments,
    },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(
    wrongPass.status === 401 && wrongPass.body.error === 'invalid_credentials',
    `a wrong passphrase should fail before alignment, got ${String(wrongPass.body.error)}`,
  );
  ok('wrong passphrase → rejected before alignment runs');

  // ---- vault write ----------------------------------------------------------
  const plaintext = utf8Encode(JSON.stringify({ title: 'GitHub', password: 'hunter2' }));
  const sealed = await encryptItem(plaintext, vaultKey, 'item-1');
  const write = await call(
    'POST',
    '/vault/changes',
    {
      items: [
        {
          id: 'item-1',
          version: 0,
          ciphertext: toBase64Url(sealed.ct),
          nonce: toBase64Url(sealed.nonce),
          updatedAt: Date.now(),
        },
      ],
    },
    { priv: deviceOne.priv, id: deviceOneId },
    accessToken,
  );
  assert(write.status === 200, `vault write expected 200, got ${write.status}`);
  ok('vault write accepted');

  // ---- second device: new-device step-up, then read -------------------------
  const deviceTwo = await generateDeviceKey();
  const deviceTwoId = toBase64Url(deviceTwo.pub);

  const newDevice = await call(
    'POST',
    '/auth/login',
    {
      username,
      authHash: toBase64Url(authKey),
      featureVector: enrolled.featureVector,
      commitments: enrolled.commitments,
    },
    { priv: deviceTwo.priv, id: deviceTwoId },
  );
  assert(newDevice.body.newDevice === true, 'an unknown device must be sent to step-up (X-3)');
  ok('second device met the new-device step-up (X-3)');

  const cleared = await call(
    'POST',
    '/auth/step-up',
    {
      username,
      authHash: toBase64Url(authKey),
      method: 'retype',
      featureVector: enrolled.featureVector,
      commitments: enrolled.commitments,
    },
    { priv: deviceTwo.priv, id: deviceTwoId },
  );
  assert(cleared.status === 200, `step-up expected 200, got ${cleared.status}`);
  const twoAccess = cleared.body.accessToken as string;
  ok('second device cleared step-up and was registered');

  // The second device derives the vault key from the passphrase alone plus what
  // the server released — it never saw device one's memory.
  const twoWrapped = cleared.body.wrappedVaultKey as { ct: string; nonce: string };
  const twoShare = fromBase64Url(cleared.body.serverShare as string);
  const twoMaster = await deriveMasterKey(
    kdfInput(enrolledScript.resolved, enrolledScript.script, 'medium'),
    userSalt,
    config.argonParams,
  );
  const twoWrapKey = await deriveSubkey(twoMaster, 'cypherkey/wrap/v1');
  twoMaster.fill(0);
  const twoVaultKey = xor32(
    await unwrapKey(
      { ct: fromBase64Url(twoWrapped.ct), nonce: fromBase64Url(twoWrapped.nonce) },
      twoWrapKey,
    ),
    twoShare,
  );

  const read = await call(
    'GET',
    '/vault/changes?since=0',
    undefined,
    { priv: deviceTwo.priv, id: deviceTwoId },
    twoAccess,
  );
  assert(read.status === 200, `vault read expected 200, got ${read.status}`);
  const items = read.body.items as Array<{ id: string; ciphertext: string; nonce: string }>;
  assert(
    items.length === 1 && items[0]?.id === 'item-1',
    'second device should see exactly the one item',
  );

  const recovered = await decryptItem(
    {
      ct: fromBase64Url(items[0]?.ciphertext as string),
      nonce: fromBase64Url(items[0]?.nonce as string),
    },
    twoVaultKey,
    'item-1',
  );
  assert(
    utf8Decode(recovered).includes('hunter2'),
    'second device must decrypt what the first wrote',
  );
  ok('vault read and decrypted on a second device');

  // ---- refresh --------------------------------------------------------------
  const refreshed = await call(
    'POST',
    '/auth/refresh',
    { refreshToken },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(refreshed.status === 200, `refresh expected 200, got ${refreshed.status}`);
  assert(refreshed.body.refreshToken !== refreshToken, 'refresh must rotate the token');
  ok('refresh rotated the token');

  const reused = await call(
    'POST',
    '/auth/refresh',
    { refreshToken },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(reused.status === 401, 'a rotated refresh token must not work twice');
  ok('the rotated token is dead (family revoked on reuse)');

  // ---- logout ---------------------------------------------------------------
  const loggedOut = await call(
    'POST',
    '/auth/logout',
    {},
    { priv: deviceOne.priv, id: deviceOneId },
    accessToken,
  );
  assert(loggedOut.status === 200, `logout expected 200, got ${loggedOut.status}`);
  const afterLogout = await call(
    'POST',
    '/auth/refresh',
    { refreshToken: refreshed.body.refreshToken },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(afterLogout.status === 401, 'logout must kill the refresh token');
  ok('logout revoked the session');

  // ---- the Recovery Kit really is the escape hatch (A-5, X-5) ---------------
  const viaKit = await unwrapKey(
    { ct: recoveryWrapped.ct, nonce: recoveryWrapped.nonce },
    await recoveryKeyFromCode(recoveryCode),
  );
  assert(
    toBase64Url(viaKit) === toBase64Url(vaultKey),
    'the Recovery Kit must open the vault without the server share',
  );
  ok('Recovery Kit opens the vault with no help from the server');

  await db.close();
  console.log(
    `\n  ${stepNumber} steps passed on ${db.dialect}. The M1 exit sequence is complete.\n`,
  );
}

main().catch(async (error) => {
  console.error(`\ne2e failed: ${(error as Error).message}\n`);
  process.exit(1);
});
