/**
 * The M1 exit test (docs/04). Drives the real HTTP surface with real client crypto,
 * against whatever `DATABASE_URL` names — SQLite by default, Postgres in CI.
 *
 * Sequence: signup → register Recovery Kit → enroll 8 samples → build profile →
 * login with a good sample (pass) → login with a bad sample (fail) → vault write →
 * vault read on a second device → refresh → logout.
 *
 * Not yet covered, and the reason the M1 exit criterion is not met: the Phantom
 * Keys cases. docs/04 also requires signing up with a two-phantom script and a
 * second attempt using only the resolved passphrase failing. Those need M1-16,
 * M1-17 and M1-17b, and M1-17b owns adding them here.
 */
import { decryptItem, encryptItem, unwrapKey, wrapKey, xor32 } from '../core/crypto/aead';
import { generateDeviceKey, signRequest } from '../core/crypto/device';
import { fromBase64Url, toBase64Url, utf8Decode, utf8Encode } from '../core/crypto/encoding';
import { deriveMasterKey, deriveSubkey, randomBytes } from '../core/crypto/kdf';
import { generateRecoveryCode, recoveryKeyFromCode } from '../core/crypto/recovery';
import { createApp } from '../server/src/app';
import { loadConfigOrExit } from '../server/src/config';
import { createDb } from '../server/src/db/client';
import { migrateDb } from '../server/src/db/migrate';

const SCRIPT_LEN = 12;
const VECTOR_LEN = 3 * SCRIPT_LEN + 5;
const BASELINE = 100;
const at = (v: number) => Array.from({ length: VECTOR_LEN }, () => v);

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
  const passphrase = utf8Encode('correct horse battery staple');
  const userSalt = randomBytes(16);

  // ---- client-side key hierarchy (A-2) -------------------------------------
  const masterKey = await deriveMasterKey(passphrase, userSalt, config.argonParams);
  const authKey = await deriveSubkey(masterKey, 'cypherkey/auth/v1');
  const wrapKeyBytes = await deriveSubkey(masterKey, 'cypherkey/wrap/v1');
  masterKey.fill(0);
  ok('derived masterKey, authKey and wrapKey');

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
      { featureVector: at(BASELINE) },
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
      featureVector: at(BASELINE),
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
  const bad = await call(
    'POST',
    '/auth/login',
    {
      username,
      authHash: toBase64Url(authKey),
      featureVector: at(BASELINE + 40),
    },
    { priv: deviceOne.priv, id: deviceOneId },
  );
  assert(
    bad.status === 401 && bad.body.band === 'fail',
    `bad login expected fail, got ${bad.status}`,
  );
  ok('login with a bad sample → fail');

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
      featureVector: at(BASELINE),
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
      featureVector: at(BASELINE),
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
  const twoMaster = await deriveMasterKey(passphrase, userSalt, config.argonParams);
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
  console.log(`\n  ${stepNumber} steps passed on ${db.dialect}.`);
  console.log('  Not covered yet: the Phantom Keys cases from docs/04 — they need M1-16/17/17b.\n');
}

main().catch(async (error) => {
  console.error(`\ne2e failed: ${(error as Error).message}\n`);
  process.exit(1);
});
