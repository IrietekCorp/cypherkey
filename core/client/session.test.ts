import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { decryptItem, encryptItem, unwrapKey, xor32 } from '../crypto/aead';
import { fromBase64Url, toBase64Url, utf8Encode } from '../crypto/encoding';
import * as kdf from '../crypto/kdf';
import { deriveMasterKey, deriveSubkey, randomBytes } from '../crypto/kdf';
import { generateRecoveryCode, recoveryKeyFromCode } from '../crypto/recovery';
import { type SessionStorage, createSession } from './session';

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
const FAST = { m: 256, t: 1, p: 1 } as const;
const PASSPHRASE = utf8Encode('correct horse battery staple');
/** A Medium-strictness credential: the KDF sees the resolved text, the script is committed. */
const CREDENTIAL = {
  resolved: 'correct horse battery staple',
  script: 'correct horse battery staple',
  strictness: 'medium',
} as const;
const WRONG_CREDENTIAL = { ...CREDENTIAL, resolved: 'not the right passphrase at all' };

/** In-memory storage double, so nothing here touches a real disk. */
function memoryStorage(): SessionStorage & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => void map.set(k, v),
    remove: async (k) => void map.delete(k),
    dump: () => Object.fromEntries(map),
  };
}

type Recorded = { path: string; method: string; headers: Record<string, string>; body: unknown };

/**
 * A mock server that implements just enough of A-5 to drive the client:
 * it holds a salt, a server share, and whatever the client registered.
 */
function mockServer(options: { band?: 'pass' | 'grey' | 'fail' } = {}) {
  const state = {
    userSalt: new Uint8Array(16).fill(3) as Uint8Array,
    serverShare: new Uint8Array(32).fill(0x5a),
    argonParams: FAST,
    stored: {} as Record<string, unknown>,
    calls: [] as Recorded[],
    band: options.band ?? ('pass' as 'pass' | 'grey' | 'fail'),
  };

  const fetchLike = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname + new URL(String(url)).search;
    const headers = Object.fromEntries(
      Object.entries((init?.headers ?? {}) as Record<string, string>),
    );
    const raw = typeof init?.body === 'string' ? init.body : undefined;
    const body = raw === undefined ? undefined : JSON.parse(raw);
    state.calls.push({ path, method: init?.method ?? 'GET', headers, body });

    const json = (status: number, value: unknown) =>
      new Response(JSON.stringify(value), {
        status,
        headers: { 'content-type': 'application/json' },
      });

    if (path.startsWith('/auth/salt')) {
      return json(200, {
        userSalt: toBase64Url(state.userSalt),
        argonParams: state.argonParams,
        deviceRegistered: state.stored.devicePub !== undefined,
      });
    }
    if (path === '/auth/signup') {
      Object.assign(state.stored, body);
      // The client picks the salt at signup; /auth/salt must hand back that same one.
      state.userSalt = fromBase64Url(String((body as Record<string, unknown>).userSalt));
      // A-9: signup mints a scope-`enroll` token, without which /enroll/* is a 401.
      return json(201, {
        userId: 'user-1',
        serverShare: toBase64Url(state.serverShare),
        enrollmentToken: 'enroll-token-1',
      });
    }
    if (path === '/auth/recovery-key') {
      Object.assign(state.stored, body);
      return json(200, { ok: true });
    }
    if (path === '/auth/login') {
      if (state.band === 'fail') return json(401, { error: 'rhythm_mismatch' });
      if (state.band === 'grey') return json(200, { stepUp: ['retype', 'recovery_code'] });
      return json(200, {
        accessToken: 'access-1',
        refreshToken: 'refresh-1',
        wrappedVaultKey: state.stored.wrappedVaultKey,
        serverShare: toBase64Url(state.serverShare),
      });
    }
    if (path === '/auth/recover/begin') {
      // M2-00f: read-only, and only after the verifier matches what was registered.
      if (body?.recoveryAuthHash !== state.stored.recoveryAuthHash) {
        return json(401, { error: 'invalid_credentials' });
      }
      return json(200, {
        recoveryWrappedVaultKey: state.stored.recoveryWrappedVaultKey,
        serverShare: toBase64Url(state.serverShare),
      });
    }
    if (path === '/auth/recover') {
      if (body?.recoveryAuthHash !== state.stored.recoveryAuthHash) {
        return json(401, { error: 'invalid_credentials' });
      }
      Object.assign(state.stored, { recovered: body });
      return json(200, {
        userId: 'user-1',
        serverShare: toBase64Url(state.serverShare),
        enrollmentToken: 'enroll-token-2',
      });
    }
    if (path === '/auth/step-up') {
      return json(200, {
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        wrappedVaultKey: state.stored.wrappedVaultKey,
        serverShare: toBase64Url(state.serverShare),
      });
    }
    return json(404, { error: 'not_found' });
  }) as unknown as typeof fetch;

  return { state, fetchLike };
}

function makeSession(
  server: ReturnType<typeof mockServer>,
  storage: SessionStorage,
  now = () => 1_788_000_000_000,
) {
  return createSession({
    baseUrl: 'https://api.cypherkey.test',
    fetch: server.fetchLike,
    storage,
    now,
    argonParams: FAST,
  });
}

const SIGNUP = {
  username: 'shawn',
  email: 'shawn@example.test',
  ...CREDENTIAL,
  consentPolicyVersion: '2026-09-01',
  deviceName: 'Laptop',
  devicePlatform: 'linux',
};

describe('signup (A-5 handshake, A-2 key hierarchy)', () => {
  let server: ReturnType<typeof mockServer>;
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    server = mockServer();
    storage = memoryStorage();
  });

  test('completes both legs and ends unlocked', async () => {
    const session = makeSession(server, storage);
    const result = await session.signup(SIGNUP);

    expect(result.userId).toBe('user-1');
    expect(session.state()).toBe('unlocked');
    expect(server.state.calls.map((c) => c.path)).toEqual(['/auth/signup', '/auth/recovery-key']);
  });

  test('signs the recovery-key call — that write must never be anonymous', async () => {
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);

    const call = server.state.calls.find((c) => c.path === '/auth/recovery-key');
    expect(call?.headers['x-cypherkey-signature']).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(call?.headers['x-cypherkey-device']).toBe(server.state.stored.devicePub as string);
  });

  test('registers the recovery blob in a second call, because serverShare is not known before the 201', async () => {
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);

    expect(server.state.calls[0]?.body).not.toHaveProperty('recoveryWrappedVaultKey');
    expect(server.state.calls[1]?.body).toHaveProperty('recoveryWrappedVaultKey');
  });

  test('what is wrapped under wrapKey is the share, and it XORs back to the vault key', async () => {
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);

    const master = await deriveMasterKey(PASSPHRASE, server.state.userSalt, FAST);
    const wrapKey = await deriveSubkey(master, 'cypherkey/wrap/v1');
    const wrapped = server.state.stored.wrappedVaultKey as { ct: string; nonce: string };
    const vaultShare = await unwrapKey(
      { ct: fromBase64Url(wrapped.ct), nonce: fromBase64Url(wrapped.nonce) },
      wrapKey,
    );

    expect(hex(xor32(vaultShare, server.state.serverShare))).toBe(hex(session.vaultKey()));
    expect(hex(vaultShare)).not.toBe(hex(session.vaultKey()));
  });

  test('the Recovery Kit wraps the FULL vault key, so it opens the vault without the server share', async () => {
    const session = makeSession(server, storage);
    const { recoveryCode } = await session.signup(SIGNUP);

    const recoveryKey = await recoveryKeyFromCode(recoveryCode);
    const blob = server.state.stored.recoveryWrappedVaultKey as { ct: string; nonce: string };
    const recovered = await unwrapKey(
      { ct: fromBase64Url(blob.ct), nonce: fromBase64Url(blob.nonce) },
      recoveryKey,
    );

    expect(hex(recovered)).toBe(hex(session.vaultKey()));
  });

  test('sends consent and the device public key, and never the passphrase or any derived key', async () => {
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    const body = server.state.calls[0]?.body as Record<string, unknown>;

    expect(body.consentPolicyVersion).toBe('2026-09-01');
    expect(typeof body.consentAt).toBe('number');
    expect(typeof body.devicePub).toBe('string');

    const master = await deriveMasterKey(PASSPHRASE, server.state.userSalt, FAST);
    const wrapKey = await deriveSubkey(master, 'cypherkey/wrap/v1');
    const wire = JSON.stringify(server.state.calls);
    expect(wire).not.toContain('correct horse');
    expect(wire).not.toContain(toBase64Url(master));
    expect(wire).not.toContain(toBase64Url(wrapKey));
    expect(wire).not.toContain(toBase64Url(session.vaultKey()));
  });

  test('stores the device private key wrapped, never in the clear', async () => {
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);

    const dump = JSON.stringify(storage.dump());
    const master = await deriveMasterKey(PASSPHRASE, server.state.userSalt, FAST);
    const wrapKey = await deriveSubkey(master, 'cypherkey/wrap/v1');
    expect(dump).not.toContain(toBase64Url(wrapKey));
    expect(dump).not.toContain(toBase64Url(session.vaultKey()));
    expect(Object.keys(storage.dump())).toContain('cypherkey.device.privWrapped');
  });
});

describe('login (A-5 online sequence)', () => {
  test('pass: fetches salt, signs the request, unwraps and XORs to the vault key', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const first = makeSession(server, storage);
    await first.signup(SIGNUP);
    const vaultKey = hex(first.vaultKey());
    first.lock();

    const session = makeSession(server, storage);
    const result = await session.login({
      username: 'shawn',
      ...CREDENTIAL,
      featureVector: [1, 2, 3],
    });

    expect(result.band).toBe('pass');
    expect(session.state()).toBe('unlocked');
    expect(hex(session.vaultKey())).toBe(vaultKey);

    const saltCall = server.state.calls.find((c) => c.path.startsWith('/auth/salt'));
    expect(saltCall?.path).toContain('username=shawn');
  });

  test('carries the A-3 signature in headers, never in the body', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    await makeSession(server, storage).signup(SIGNUP);
    const session = makeSession(server, storage);
    await session.login({
      username: 'shawn',
      ...CREDENTIAL,
      featureVector: [1],
    });

    const login = server.state.calls.find((c) => c.path === '/auth/login');
    expect(login?.headers['x-cypherkey-signature']).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(login?.headers['x-cypherkey-nonce']).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(login?.headers['x-cypherkey-ts']).toBe('1788000000000');
    expect(login?.body).not.toHaveProperty('deviceSig');
  });

  test('a fresh nonce per login, so a replayed request is detectable', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    await makeSession(server, storage).signup(SIGNUP);

    const nonces = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const s = makeSession(server, storage);
      await s.login({
        username: 'shawn',
        ...CREDENTIAL,
        featureVector: [1],
      });
      nonces.add(
        server.state.calls.filter((c) => c.path === '/auth/login').at(-1)?.headers[
          'x-cypherkey-nonce'
        ] as string,
      );
    }
    expect(nonces.size).toBe(5);
  });

  test('grey: reports the step-up options and stays locked', async () => {
    const server = mockServer({ band: 'grey' });
    const storage = memoryStorage();
    await makeSession(server, storage).signup(SIGNUP);

    const session = makeSession(server, storage);
    const result = await session.login({
      username: 'shawn',
      ...CREDENTIAL,
      featureVector: [1],
    });

    expect(result).toEqual({ band: 'grey', stepUp: ['retype', 'recovery_code'] });
    expect(session.state()).toBe('step-up-required');
    expect(() => session.vaultKey()).toThrow(/locked/i);
  });

  test('step-up after grey releases the vault key', async () => {
    const server = mockServer({ band: 'grey' });
    const storage = memoryStorage();
    const first = makeSession(server, storage);
    await first.signup(SIGNUP);
    const vaultKey = hex(first.vaultKey());

    const session = makeSession(server, storage);
    await session.login({
      username: 'shawn',
      ...CREDENTIAL,
      featureVector: [1],
    });
    const result = await session.stepUp({
      method: 'retype',
      script: CREDENTIAL.script,
      featureVector: [1],
    });

    expect(result.band).toBe('pass');
    expect(session.state()).toBe('unlocked');
    expect(hex(session.vaultKey())).toBe(vaultKey);
  });

  test('fail: stays locked and holds no key', async () => {
    const server = mockServer({ band: 'fail' });
    const storage = memoryStorage();
    await makeSession(server, storage).signup(SIGNUP);

    const session = makeSession(server, storage);
    const result = await session.login({
      username: 'shawn',
      ...CREDENTIAL,
      featureVector: [1],
    });

    expect(result).toEqual({ band: 'fail', error: 'rhythm_mismatch' });
    expect(session.state()).toBe('locked');
    expect(() => session.vaultKey()).toThrow(/locked/i);
  });

  test('a wrong passphrase cannot unwrap, even if the server were to answer pass', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    await makeSession(server, storage).signup(SIGNUP);

    const session = makeSession(server, storage);
    await expect(
      session.login({
        username: 'shawn',
        ...WRONG_CREDENTIAL,
        featureVector: [1],
      }),
    ).rejects.toThrow();
    expect(session.state()).toBe('locked');
  });
});

describe('the vault key actually works', () => {
  test('an item encrypted after signup decrypts after a later login', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const first = makeSession(server, storage);
    await first.signup(SIGNUP);
    const sealed = await encryptItem(utf8Encode('hunter2'), first.vaultKey(), 'item-1');
    first.lock();

    const session = makeSession(server, storage);
    await session.login({
      username: 'shawn',
      ...CREDENTIAL,
      featureVector: [1],
    });
    const plaintext = await decryptItem(sealed, session.vaultKey(), 'item-1');

    expect(new TextDecoder().decode(plaintext)).toBe('hunter2');
  });
});

describe('lock() zeroes key material (AGENTS §7)', () => {
  test('the vault key buffer is zero-filled, not merely dropped', async () => {
    const server = mockServer();
    const session = makeSession(server, memoryStorage());
    await session.signup(SIGNUP);

    const held = session.vaultKey();
    expect(held.some((b) => b !== 0)).toBe(true);

    session.lock();
    expect(hex(held)).toBe('00'.repeat(32));
    expect(session.state()).toBe('locked');
    expect(() => session.vaultKey()).toThrow(/locked/i);
  });

  test('locking twice is safe', async () => {
    const server = mockServer();
    const session = makeSession(server, memoryStorage());
    await session.signup(SIGNUP);
    session.lock();
    expect(() => session.lock()).not.toThrow();
  });

  test('idle past the timeout locks on the next check', async () => {
    const server = mockServer();
    let clock = 1_788_000_000_000;
    const session = createSession({
      baseUrl: 'https://api.cypherkey.test',
      fetch: server.fetchLike,
      storage: memoryStorage(),
      now: () => clock,
      argonParams: FAST,
      idleTimeoutMs: 15 * 60_000,
    });
    await session.signup(SIGNUP);

    clock += 14 * 60_000;
    session.checkIdle();
    expect(session.state()).toBe('unlocked');

    clock += 2 * 60_000;
    session.checkIdle();
    expect(session.state()).toBe('locked');
  });

  test('activity postpones the idle lock', async () => {
    const server = mockServer();
    let clock = 1_788_000_000_000;
    const session = createSession({
      baseUrl: 'https://api.cypherkey.test',
      fetch: server.fetchLike,
      storage: memoryStorage(),
      now: () => clock,
      argonParams: FAST,
      idleTimeoutMs: 15 * 60_000,
    });
    await session.signup(SIGNUP);

    clock += 14 * 60_000;
    session.touch();
    clock += 14 * 60_000;
    session.checkIdle();
    expect(session.state()).toBe('unlocked');
  });
});

describe('unlockOffline (A-7)', () => {
  test('opens the vault from the cached blob with no network at all', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const first = makeSession(server, storage);
    await first.signup(SIGNUP);
    const vaultKey = hex(first.vaultKey());
    first.lock();

    const offlineFetch = (async () => {
      throw new Error('network used during offline unlock');
    }) as unknown as typeof fetch;
    const session = createSession({
      baseUrl: 'https://api.cypherkey.test',
      fetch: offlineFetch,
      storage,
      now: () => 1_788_000_000_000,
      argonParams: FAST,
    });

    expect(await session.unlockOffline({ ...CREDENTIAL })).toBe(true);
    expect(hex(session.vaultKey())).toBe(vaultKey);
  });

  test('a wrong passphrase does not open it, and leaves the session locked', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    await makeSession(server, storage).signup(SIGNUP);

    const session = makeSession(server, storage);
    expect(await session.unlockOffline(WRONG_CREDENTIAL)).toBe(false);
    expect(session.state()).toBe('locked');
  });

  test('refuses when this device has never unlocked online', async () => {
    const server = mockServer();
    const session = makeSession(server, memoryStorage());
    expect(await session.unlockOffline({ ...CREDENTIAL })).toBe(false);
  });

  test('the cached blob is bound to its own context, so it cannot stand in for the share', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);

    const master = await deriveMasterKey(PASSPHRASE, server.state.userSalt, FAST);
    const wrapKey = await deriveSubkey(master, 'cypherkey/wrap/v1');
    const cached = JSON.parse(storage.dump()['cypherkey.vault.offline'] as string);
    const blob = { ct: fromBase64Url(cached.ct), nonce: fromBase64Url(cached.nonce) };

    await expect(unwrapKey(blob, wrapKey, 'cypherkey/wrap/vault-key/v1')).rejects.toThrow();
    expect(hex(await unwrapKey(blob, wrapKey, 'cypherkey/wrap/vault-key-offline/v1'))).toBe(
      hex(session.vaultKey()),
    );
  });
});

describe('nothing secret is logged or persisted in the clear', () => {
  test('no session operation writes to the console', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug', 'trace'] as const).map((m) =>
      spyOn(console, m).mockImplementation(() => {}),
    );
    try {
      const server = mockServer();
      const storage = memoryStorage();
      const session = makeSession(server, storage);
      await session.signup(SIGNUP);
      session.lock();
      await session.login({
        username: 'shawn',
        ...CREDENTIAL,
        featureVector: [1],
      });
      await session.unlockOffline({ ...CREDENTIAL });
      session.lock();
      for (const s of spies) expect(s).not.toHaveBeenCalled();
    } finally {
      for (const s of spies) s.mockRestore();
    }
  });

  test('storage holds no passphrase, master key, wrap key or vault key', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    const vaultKey = toBase64Url(session.vaultKey());

    const master = await deriveMasterKey(PASSPHRASE, server.state.userSalt, FAST);
    const dump = JSON.stringify(storage.dump());
    expect(dump).not.toContain('correct horse');
    expect(dump).not.toContain(toBase64Url(master));
    expect(dump).not.toContain(toBase64Url(await deriveSubkey(master, 'cypherkey/wrap/v1')));
    expect(dump).not.toContain(toBase64Url(await deriveSubkey(master, 'cypherkey/auth/v1')));
    expect(dump).not.toContain(vaultKey);
  });

  test('no request body or header ever carries a feature vector back out as a key', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    session.lock();
    // Distinctive nine-digit values on purpose. An earlier version of this test looked
    // for "11", which appears by chance inside the random base64url nonce and signature
    // roughly one run in ten — a flaky absence test is worse than none, because it
    // trains everyone to ignore the one check that would catch a real leak.
    const VECTOR = [987654321, 876543219, 765432198];
    await session.login({ username: 'shawn', ...CREDENTIAL, featureVector: VECTOR });

    const login = server.state.calls.find((c) => c.path === '/auth/login');
    expect((login?.body as Record<string, unknown>).featureVector).toEqual(VECTOR);

    const headers = JSON.stringify(login?.headers);
    for (const value of VECTOR) expect(headers).not.toContain(String(value));
  });
});

/**
 * M2-00d. The client library shipped through all of M1 unable to log in to the server
 * it ships with, because `commitments` became required on `/auth/login` in M1-17b and
 * nothing checked that the two agreed. These tests pin the wire format itself.
 */
describe('wire format agreement with the server (M2-00d)', () => {
  let server: ReturnType<typeof mockServer>;
  let storage: ReturnType<typeof memoryStorage>;

  beforeEach(() => {
    server = mockServer();
    storage = memoryStorage();
  });

  test('login sends the commitments the server requires', async () => {
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    await session.login({
      username: 'shawn',
      ...CREDENTIAL,
      featureVector: [1, 2, 3],
    });

    const login = server.state.calls.find((c) => c.path === '/auth/login');
    const sent = (login?.body as Record<string, unknown>).commitments as string[];
    // A-14.2: one commitment per script token, computed by the session from the
    // phantomKey it already derived — the caller never supplies these.
    expect(sent).toHaveLength([...CREDENTIAL.script].length);
    expect(sent.every((c) => typeof c === 'string' && c.length > 0)).toBe(true);
    // Repeated tokens commit identically; that equality pattern is the disclosed leak.
    expect(new Set(sent).size).toBe(new Set([...CREDENTIAL.script]).size);
  });

  test('step-up posts a scored retype, not an opaque proof', async () => {
    const grey = mockServer({ band: 'grey' });
    const session = makeSession(grey, storage);
    await session.signup(SIGNUP);
    const result = await session.login({
      username: 'shawn',
      ...CREDENTIAL,
      featureVector: [1],
    });
    expect(result.band).toBe('grey');

    await session.stepUp({ method: 'retype', script: CREDENTIAL.script, featureVector: [9] });

    const stepUp = grey.state.calls.find((c) => c.path === '/auth/step-up');
    // The server's schema is username + authHash + method + featureVector + commitments.
    expect(Object.keys(stepUp?.body as object).sort()).toEqual([
      'authHash',
      'commitments',
      'featureVector',
      'method',
      'username',
    ]);
    expect((stepUp?.body as Record<string, unknown>).method).toBe('retype');
  });

  test('signup returns the enrollment token, without which enrollment cannot start', async () => {
    const session = makeSession(server, storage);
    const result = await session.signup(SIGNUP);
    expect(result.enrollmentToken).toBe('enroll-token-1');
  });

  test('tokens are held after a pass and dropped on lock', async () => {
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    await session.login({
      username: 'shawn',
      ...CREDENTIAL,
      featureVector: [1],
    });

    expect(session.tokens()).toEqual({ accessToken: 'access-1', refreshToken: 'refresh-1' });
    session.lock();
    expect(session.tokens()).toBeNull();
  });

  test('authed() signs with the device key and carries the bearer token', async () => {
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    const request = session.authed();

    await request('GET', '/enroll/status', undefined, 'enroll-token-1');

    const call = server.state.calls.find((c) => c.path === '/enroll/status');
    expect(call?.headers.authorization).toBe('Bearer enroll-token-1');
    // A-3: the device signature and its inputs travel in headers, never in the body.
    expect(call?.headers['x-cypherkey-signature']).toBeDefined();
    expect(call?.headers['x-cypherkey-device']).toBeDefined();
    expect(call?.headers['x-cypherkey-nonce']).toBeDefined();
  });

  test('authed() refuses to sign while locked', async () => {
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    const request = session.authed();
    session.lock();

    expect(request('GET', '/enroll/status', undefined, 'tok')).rejects.toThrow('locked');
  });
});

describe('a wrong passphrase is a 401, not a crash (M2-00d)', () => {
  test('a device key that will not unwrap does not throw out of login', async () => {
    const server = mockServer({ band: 'fail' });
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    session.lock();

    // The wrong passphrase derives a different wrapKey, so the stored device private
    // key cannot be unwrapped. That must surface as a rejected login, because a user
    // mistyping their passphrase is the most ordinary event there is.
    const result = await session.login({
      username: 'shawn',
      ...WRONG_CREDENTIAL,
      featureVector: [1],
    });

    expect(result.band).toBe('fail');
    expect(session.state()).toBe('locked');
  });

  test('an unsigned login is still sent, so the server decides', async () => {
    const server = mockServer({ band: 'fail' });
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    session.lock();

    await session.login({
      username: 'shawn',
      ...WRONG_CREDENTIAL,
      featureVector: [1],
    });

    const login = server.state.calls.filter((c) => c.path === '/auth/login').at(-1);
    expect(login).toBeDefined();
    // Nothing was signed, because nothing could be: no signature headers went out.
    expect(login?.headers['x-cypherkey-signature']).toBeUndefined();
  });
});

/**
 * M2-00d.1. `phantomKey` is a sibling of `authKey` and `wrapKey` under one `masterKey`,
 * so a caller asked to supply commitments had to run Argon2id a second time at
 * m=64 MiB just to derive it. On a popup or a phone that is the difference between one
 * unlock and two. The session derives all three at once and keeps the phantom branch
 * in memory for as long as it is unlocked.
 */
describe('one Argon2id pass per unlock (M2-00d.1)', () => {
  test('login runs the KDF exactly once, not once per branch', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);
    session.lock();

    const spy = spyOn(kdf, 'deriveMasterKey');
    await session.login({ ...CREDENTIAL, username: 'shawn', featureVector: [1] });
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('commitments need no further derivation once unlocked', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);

    const spy = spyOn(kdf, 'deriveMasterKey');
    const commitments = await session.commitmentsFor(CREDENTIAL.script);
    expect(spy).not.toHaveBeenCalled();
    expect(commitments).toHaveLength([...CREDENTIAL.script].length);
    spy.mockRestore();
  });

  test('commitmentsFor refuses while locked rather than re-deriving silently', async () => {
    const server = mockServer();
    const session = makeSession(server, memoryStorage());
    await session.signup(SIGNUP);
    session.lock();

    expect(session.commitmentsFor(CREDENTIAL.script)).rejects.toThrow('locked');
  });

  /** Absence test: the phantom branch is memory-only, like the vault key. */
  test('phantomKey is never written to storage', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    await session.signup(SIGNUP);

    const stored = JSON.stringify(storage.dump());
    expect(stored).not.toContain('phantom');
    // Only the salt, the device identity and the offline vault blob may persist.
    expect(Object.keys(storage.dump()).sort()).toEqual([
      'cypherkey.device.id',
      'cypherkey.device.privWrapped',
      'cypherkey.device.pub',
      'cypherkey.user.salt',
      'cypherkey.vault.offline',
    ]);
  });

  test('a grey login keeps the phantom branch so the retype can be committed', async () => {
    const grey = mockServer({ band: 'grey' });
    const session = makeSession(grey, memoryStorage());
    await session.signup(SIGNUP);
    session.lock();

    await session.login({ ...CREDENTIAL, username: 'shawn', featureVector: [1] });
    expect(session.state()).toBe('step-up-required');

    const spy = spyOn(kdf, 'deriveMasterKey');
    await session.stepUp({ method: 'retype', script: CREDENTIAL.script, featureVector: [2] });
    // The retype is committed from the branch the grey login already held.
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

/**
 * M2-00f. Recovery is server-authenticated: the Kit is proved before the server
 * releases the wrapped vault key, and `begin` writes nothing.
 */
describe('recovery (X-5)', () => {
  test('signup registers a verifier alongside the wrapped key', async () => {
    const server = mockServer();
    const session = makeSession(server, memoryStorage());
    await session.signup(SIGNUP);

    const call = server.state.calls.find((c) => c.path === '/auth/recovery-key');
    const body = call?.body as Record<string, unknown>;
    expect(body.recoveryWrappedVaultKey).toBeDefined();
    expect(typeof body.recoveryAuthHash).toBe('string');
  });

  test('the verifier is not the key that unwraps the vault', async () => {
    const server = mockServer();
    const session = makeSession(server, memoryStorage());
    const { recoveryCode } = await session.signup(SIGNUP);

    const call = server.state.calls.find((c) => c.path === '/auth/recovery-key');
    const sent = (call?.body as Record<string, unknown>).recoveryAuthHash as string;
    const recoveryKey = await recoveryKeyFromCode(recoveryCode);
    // If these matched, registering the verifier would hand the server the wrap key.
    expect(sent).not.toBe(toBase64Url(recoveryKey));
  });

  test('a correct Kit recovers the vault key and leaves the session unlocked', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    const { recoveryCode } = await session.signup(SIGNUP);
    const original = toBase64Url(session.vaultKey());
    session.lock();

    const result = await session.recover({
      username: 'shawn',
      recoveryCode,
      credential: { ...CREDENTIAL, resolved: 'a brand new passphrase' },
      deviceName: 'Recovered laptop',
      devicePlatform: 'linux',
    });

    expect(result.enrollmentToken).toBe('enroll-token-2');
    expect(session.state()).toBe('unlocked');
    // The vault key itself never changes, so nothing needs re-encrypting.
    expect(toBase64Url(session.vaultKey())).toBe(original);
  });

  test('the new passphrase re-wraps the share; the old one is not sent', async () => {
    const server = mockServer();
    const session = makeSession(server, memoryStorage());
    const { recoveryCode } = await session.signup(SIGNUP);
    session.lock();

    await session.recover({
      username: 'shawn',
      recoveryCode,
      credential: { ...CREDENTIAL, resolved: 'a brand new passphrase' },
      deviceName: 'Recovered laptop',
      devicePlatform: 'linux',
    });

    const call = server.state.calls.find((c) => c.path === '/auth/recover');
    const body = call?.body as Record<string, unknown>;
    expect(body.newAuthHash).toBeDefined();
    expect(body.newUserSalt).toBeDefined();
    expect(body.newWrappedVaultKey).toBeDefined();
    // Absence: the Kit, the passphrase and the vault key never travel.
    const sent = JSON.stringify(body);
    expect(sent).not.toContain(recoveryCode);
    expect(sent).not.toContain('a brand new passphrase');
    expect(sent).not.toContain('correct horse');
  });

  test('a wrong Kit fails before anything is released', async () => {
    const server = mockServer();
    const session = makeSession(server, memoryStorage());
    await session.signup(SIGNUP);
    session.lock();

    expect(
      session.recover({
        username: 'shawn',
        recoveryCode: generateRecoveryCode(),
        credential: CREDENTIAL,
        deviceName: 'Attacker',
        devicePlatform: 'linux',
      }),
    ).rejects.toThrow('401');

    // No /auth/recover call was ever made: begin refused first.
    expect(server.state.calls.some((c) => c.path === '/auth/recover')).toBe(false);
  });

  test('recovery registers a fresh device key', async () => {
    const server = mockServer();
    const storage = memoryStorage();
    const session = makeSession(server, storage);
    const { recoveryCode } = await session.signup(SIGNUP);
    const before = storage.dump()['cypherkey.device.id'];
    session.lock();

    await session.recover({
      username: 'shawn',
      recoveryCode,
      credential: { ...CREDENTIAL, resolved: 'a brand new passphrase' },
      deviceName: 'Recovered laptop',
      devicePlatform: 'linux',
    });

    expect(storage.dump()['cypherkey.device.id']).not.toBe(before);
  });
});
