import { type Sealed, unwrapKey, wrapKey, xor32 } from '../crypto/aead';
import { generateDeviceKey, signRequest } from '../crypto/device';
import { fromBase64Url, toBase64Url, utf8Encode } from '../crypto/encoding';
import {
  type ArgonParams,
  KEY_BYTES,
  SALT_BYTES,
  deriveMasterKey,
  deriveSubkey,
  randomBytes,
} from '../crypto/kdf';
import { type Strictness, kdfInput, scriptCommitments } from '../crypto/phantom';
import {
  generateRecoveryCode,
  recoveryAuthHashFromKey,
  recoveryKeyFromCode,
} from '../crypto/recovery';

/** A-5 step 6: the vault key lives in memory only, and only while unlocked. */
export type SessionState = 'locked' | 'unlocked' | 'step-up-required';

/** Opaque string key/value store. The extension backs this with `chrome.storage` (M2-01). */
export type SessionStorage = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
};

export type SessionDeps = {
  baseUrl: string;
  fetch: typeof fetch;
  storage: SessionStorage;
  /** Injected so tests never depend on the wall clock. */
  now?: () => number;
  /** A-5 step 6: default 15 minutes. */
  idleTimeoutMs?: number;
  /** Overridden only by tests; production uses the per-account params from `/auth/salt`. */
  argonParams?: ArgonParams;
  /**
   * The Argon2id step, injected so it can run somewhere other than the calling thread.
   * The extension supplies a Web Worker-backed implementation: a ~175 ms hash on a
   * popup's main thread janks the unlock screen and stalls the Rhythm Light's
   * per-keystroke pulse, which is the one piece of UI that must never stutter.
   *
   * Defaults to the direct call, so the server, the e2e and the tests are unaffected.
   * Whatever is supplied must be the same Argon2id — `hash-wasm` everywhere (A-2).
   */
  deriveKey?: typeof deriveMasterKey;
};

/**
 * What a capture produced, which is everything the A-2 hierarchy needs.
 *
 * The session takes this rather than pre-built KDF bytes because `phantomKey` is a
 * sibling of `authKey` and `wrapKey` under the same `masterKey`. A caller holding only
 * `kdfInput` cannot commit its script (A-14.2) without running Argon2id a second time
 * at m=64 MiB — doubling the cost of every unlock on the device least able to afford
 * it. Deriving all three branches from one Argon2id pass is the whole point.
 */
export type Credential = {
  /** The resolved passphrase text (A-14.1). */
  resolved: string;
  /** The script: one token per keystroke, phantoms included (A-14.1). */
  script: string;
  /** A-16. In Strict the script is folded into the KDF input; otherwise it is not. */
  strictness: Strictness;
};

export type SignupInput = Credential & {
  username: string;
  email: string;
  consentPolicyVersion: string;
  deviceName: string;
  devicePlatform: string;
};

/** The recovery code is returned once and never stored (X-2 step 3). */
export type SignupResult = {
  userId: string;
  recoveryCode: string;
  /** Scope-`enroll` bearer token from A-9. Enrollment cannot start without it. */
  enrollmentToken: string;
};

export type LoginInput = Credential & { username: string; featureVector: number[] };

/**
 * A-4.4 grey-band resolution. The only method the server accepts today is `retype`
 * (M2-00e adds Backup Codes); passkey and TOTP are M3. A retype is a second scored
 * sample, so it carries a vector and commitments exactly as a login does.
 */
export type StepUpInput = {
  method: 'retype';
  /** The retyped script, which may legitimately differ from the first attempt. */
  script: string;
  featureVector: number[];
};

/**
 * A device-signed, token-bearing request. Handed to the enrollment and sync clients so
 * they never need the device private key themselves — it stays wrapped under `wrapKey`
 * inside the session, and is unwrapped per call and zeroed straight afterwards.
 */
export type AuthedRequest = (
  method: string,
  path: string,
  body?: unknown,
  token?: string,
) => Promise<{ status: number; body: unknown }>;

export type LoginResult =
  | { band: 'pass' }
  | { band: 'grey'; stepUp: string[] }
  | { band: 'fail'; error: string };

/**
 * A-16: crossing into or out of Strict changes `kdfInput` and therefore `masterKey`.
 * The caller supplies the script again because the new key cannot be derived from
 * anything the unlocked session is holding.
 */
export type StrictnessChange = {
  level: Strictness;
  resolved: string;
  script: string;
  /** Must carry a step-up cleared in the last five minutes. */
  accessToken: string;
};

/**
 * X-5 recovery. The Kit is typed once and never stored; the new credential replaces
 * the lost one. `vaultKey` itself does not change, so the vault is never re-encrypted.
 */
export type RecoverInput = {
  username: string;
  /** The 33-character Recovery Kit code, as printed. */
  recoveryCode: string;
  /** The new passphrase, as a credential — the same shape a login takes. */
  credential: Credential;
  deviceName: string;
  devicePlatform: string;
};

export type RecoverResult = {
  userId: string;
  enrollmentToken: string;
  /**
   * X-5: a replacement Recovery Kit, shown once. The old one stopped working when the
   * recovery committed, so this must be presented before the flow can be considered
   * finished — an unsaved Kit is an account with no way back.
   */
  recoveryCode: string;
};

export type Session = {
  state(): SessionState;
  signup(input: SignupInput): Promise<SignupResult>;
  login(input: LoginInput): Promise<LoginResult>;
  stepUp(input: StepUpInput): Promise<LoginResult>;
  /** Session tokens from the last pass. Null while locked or awaiting step-up. */
  tokens(): { accessToken: string; refreshToken: string } | null;
  /**
   * X-5: proves possession of the Recovery Kit, then replaces the passphrase. Leaves
   * the session unlocked and enrolment pending — the profile is deleted server-side.
   */
  recover(input: RecoverInput): Promise<RecoverResult>;
  /** A-9 rotation: exchanges the refresh token for a new pair. */
  refresh(): Promise<boolean>;
  /** Revokes the refresh family server-side, then locks. */
  logout(): Promise<boolean>;
  /** Device-signed request helper for `createEnroller` and `createSync`. */
  authed(): AuthedRequest;
  /**
   * A-14.2 commitments for a script, using the `phantomKey` already derived by the
   * unlock. Enrollment needs these and is not a login, so it cannot get them any other
   * way without paying for Argon2id again.
   */
  commitmentsFor(script: string): Promise<string[]>;
  unlockOffline(input: Credential): Promise<boolean>;
  changeStrictness(input: StrictnessChange): Promise<{ keyVersion: number } | { error: string }>;
  lock(): void;
  touch(): void;
  checkIdle(): void;
  vaultKey(): Uint8Array;
};

const KEYS = {
  deviceId: 'cypherkey.device.id',
  devicePub: 'cypherkey.device.pub',
  devicePrivWrapped: 'cypherkey.device.privWrapped',
  userSalt: 'cypherkey.user.salt',
  argonParams: 'cypherkey.user.argon',
  offlineVaultKey: 'cypherkey.vault.offline',
} as const;

const DEFAULT_IDLE_MS = 15 * 60_000;
const NONCE_BYTES = 16;

const sealedToJson = (s: Sealed) => ({ ct: toBase64Url(s.ct), nonce: toBase64Url(s.nonce) });

function sealedFromJson(value: unknown): Sealed {
  if (typeof value !== 'object' || value === null) throw new Error('malformed wrapped key');
  const { ct, nonce } = value as Record<string, unknown>;
  if (typeof ct !== 'string' || typeof nonce !== 'string') throw new Error('malformed wrapped key');
  return { ct: fromBase64Url(ct), nonce: fromBase64Url(nonce) };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('malformed server response');
  return value as Record<string, unknown>;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`malformed server response: ${field}`);
  return value;
}

/**
 * The client-side session state machine of A-5. Pure TypeScript, no DOM: everything
 * that touches the outside world — the network, persistence, the clock — is injected.
 */
export function createSession(deps: SessionDeps): Session {
  const now = deps.now ?? Date.now;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_MS;

  let state: SessionState = 'locked';
  let vaultKeyBytes: Uint8Array | null = null;
  let wrapKeyBytes: Uint8Array | null = null;
  /**
   * A-14.2. Memory only, for the life of the unlock — never stored, never sent. It is
   * held so enrollment and a grey-band retype can commit a script without a second
   * Argon2id pass.
   */
  let phantomKeyBytes: Uint8Array | null = null;
  let lastActivity = now();
  /** Held while unlocked so a re-key can re-wrap it without another round trip. */
  let vaultShareBytes: Uint8Array | null = null;
  /**
   * Held between a grey login and the step-up that resolves it. `/auth/step-up`
   * re-verifies the passphrase, so the hash has to survive the round trip. It lives in
   * memory only for the length of the grey band and is dropped by `lock()`.
   */
  let pending: { username: string; authHash: string } | null = null;
  let sessionTokens: { accessToken: string; refreshToken: string } | null = null;
  /**
   * X-3: a device the server does not know is generated here, used to sign the login,
   * and only persisted once the step-up clears — which is also when the server
   * registers it, from the public key in the signature header. Until then it is
   * provisional and a failed attempt simply discards it.
   */
  let provisionalDevice: { id: string; priv: Uint8Array } | null = null;

  /**
   * Derives all three A-2 branches from a single Argon2id pass, zeroing the master key
   * as soon as its children exist. `phantomKey` is derived here rather than on demand
   * because re-deriving it later would mean a second Argon2id at m=64 MiB.
   */
  async function deriveBranches(cred: Credential, salt: Uint8Array, params?: ArgonParams) {
    const master = await (deps.deriveKey ?? deriveMasterKey)(
      kdfInput(cred.resolved, cred.script, cred.strictness),
      salt,
      params ?? deps.argonParams,
    );
    try {
      return {
        authKey: await deriveSubkey(master, 'cypherkey/auth/v1'),
        wrapKey: await deriveSubkey(master, 'cypherkey/wrap/v1'),
        phantomKey: await deriveSubkey(master, 'cypherkey/phantom/v1'),
      };
    } finally {
      master.fill(0);
    }
  }

  async function request(
    method: string,
    path: string,
    body: unknown,
    signWith?: Uint8Array | null,
    deviceId?: string,
    accessToken?: string,
  ): Promise<{ status: number; body: unknown }> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (accessToken !== undefined) headers.authorization = `Bearer ${accessToken}`;

    if (signWith !== undefined && signWith !== null && deviceId !== undefined) {
      // A-3: the signature and its inputs travel in headers. They cannot live in the
      // body, because the signing string covers sha256(body).
      const nonce = randomBytes(NONCE_BYTES);
      const ts = now();
      const signature = await signRequest(signWith, {
        nonce,
        ts,
        method,
        path,
        body: serialized === undefined ? new Uint8Array(0) : utf8Encode(serialized),
      });
      headers['x-cypherkey-device'] = deviceId;
      headers['x-cypherkey-nonce'] = toBase64Url(nonce);
      headers['x-cypherkey-ts'] = String(ts);
      headers['x-cypherkey-signature'] = signature;
    }

    const response = await deps.fetch(`${deps.baseUrl}${path}`, {
      method,
      headers,
      body: serialized,
    });
    return { status: response.status, body: await response.json() };
  }

  /** Loads this device's identity, unwrapping the private key with the live wrap key (A-3). */
  async function loadDevice(wrap: Uint8Array): Promise<{ id: string; priv: Uint8Array } | null> {
    const id = await deps.storage.get(KEYS.deviceId);
    const stored = await deps.storage.get(KEYS.devicePrivWrapped);
    if (id === null || stored === null) return null;
    try {
      const priv = await unwrapKey(
        sealedFromJson(JSON.parse(stored)),
        wrap,
        'cypherkey/wrap/device-key/v1',
      );
      return { id, priv };
    } catch {
      // The stored key will not unwrap under this wrap key, which means the passphrase
      // is wrong. Sign nothing and let the server answer 401 — the alternative is an
      // unhandled decryption error on every typo.
      return null;
    }
  }

  /** A-7: cache the full vault key wrapped under wrapKey, under its own context label. */
  async function cacheForOffline(vault: Uint8Array, wrap: Uint8Array): Promise<void> {
    const sealed = await wrapKey(vault, wrap, 'cypherkey/wrap/vault-key-offline/v1');
    await deps.storage.set(KEYS.offlineVaultKey, JSON.stringify(sealedToJson(sealed)));
  }

  /** Takes ownership of the derived keys and moves to unlocked. */
  function unlockWith(vault: Uint8Array, wrap: Uint8Array, phantom?: Uint8Array): void {
    vaultKeyBytes?.fill(0);
    wrapKeyBytes?.fill(0);
    vaultKeyBytes = vault;
    wrapKeyBytes = wrap;
    if (phantom !== undefined) {
      phantomKeyBytes?.fill(0);
      phantomKeyBytes = phantom;
    }
    state = 'unlocked';
    pending = null;
    lastActivity = now();
  }

  /** Turns a pass payload into a held vault key. Shared by login and step-up. */
  async function acceptPass(payload: Record<string, unknown>, wrap: Uint8Array): Promise<void> {
    const share = fromBase64Url(requireString(payload.serverShare, 'serverShare'));
    if (share.length !== KEY_BYTES) throw new Error('malformed server response: serverShare');
    const vaultShare = await unwrapKey(sealedFromJson(payload.wrappedVaultKey), wrap);
    const vault = xor32(vaultShare, share);
    await cacheForOffline(vault, wrap);
    unlockWith(vault, wrap);
    // Kept so a Strictness re-key can re-wrap it without another round trip.
    vaultShareBytes = vaultShare;
    if (provisionalDevice !== null) {
      const sealedPriv = await wrapKey(
        provisionalDevice.priv,
        wrap,
        'cypherkey/wrap/device-key/v1',
      );
      await deps.storage.set(KEYS.deviceId, provisionalDevice.id);
      await deps.storage.set(KEYS.devicePub, provisionalDevice.id);
      await deps.storage.set(KEYS.devicePrivWrapped, JSON.stringify(sealedToJson(sealedPriv)));
      provisionalDevice.priv.fill(0);
      provisionalDevice = null;
    }
    const access = payload.accessToken;
    const refresh = payload.refreshToken;
    sessionTokens =
      typeof access === 'string' && typeof refresh === 'string'
        ? { accessToken: access, refreshToken: refresh }
        : null;
  }

  async function fetchSalt(username: string) {
    const { body } = await request(
      'GET',
      `/auth/salt?username=${encodeURIComponent(username)}`,
      undefined,
    );
    const record = asRecord(body);
    return {
      userSalt: fromBase64Url(requireString(record.userSalt, 'userSalt')),
      argonParams: record.argonParams as ArgonParams | undefined,
    };
  }

  return {
    state: () => state,

    vaultKey() {
      if (state !== 'unlocked' || vaultKeyBytes === null) {
        throw new Error('session is locked');
      }
      lastActivity = now();
      return vaultKeyBytes;
    },

    tokens: () => sessionTokens,

    /**
     * Signs with this device's key and attaches a bearer token. The private key is
     * unwrapped per call and zeroed immediately, so the enrollment and sync clients
     * never hold key material of their own.
     */
    authed(): AuthedRequest {
      return async (method, path, body, token) => {
        if (wrapKeyBytes === null) throw new Error('session is locked');
        const device = await loadDevice(wrapKeyBytes);
        if (device === null) throw new Error('this device has no registered key');
        try {
          return await request(method, path, body, device.priv, device.id, token);
        } finally {
          device.priv.fill(0);
        }
      };
    },

    /**
     * A-9: refresh tokens rotate, and reuse of a spent one revokes the whole family.
     * The route is device-signed but takes no bearer token — the refresh token is the
     * credential.
     */
    /**
     * X-5. Two calls, because the client cannot compute the new wrapped key until it
     * has unwrapped the old one, and the server cannot re-wrap on its behalf. Both
     * calls prove possession of the Kit; the first one writes nothing.
     */
    async recover(input) {
      const recoveryKey = await recoveryKeyFromCode(input.recoveryCode);
      const recoveryAuthHash = toBase64Url(await recoveryAuthHashFromKey(recoveryKey));

      const begun = await request('POST', '/auth/recover/begin', {
        username: input.username,
        recoveryAuthHash,
      });
      if (begun.status !== 200) {
        recoveryKey.fill(0);
        throw new Error(`recovery failed with status ${begun.status}`);
      }

      const payload = asRecord(begun.body);
      const serverShare = fromBase64Url(requireString(payload.serverShare, 'serverShare'));
      // A-5: the Kit wraps the FULL vault key, not the client's share of it.
      const vault = await unwrapKey(
        sealedFromJson(payload.recoveryWrappedVaultKey),
        recoveryKey,
        'cypherkey/wrap/vault-key/v1',
      );
      recoveryKey.fill(0);

      // The new passphrase gets a new salt, and therefore an entirely new hierarchy.
      const userSalt = randomBytes(SALT_BYTES);
      const {
        authKey,
        wrapKey: wrap,
        phantomKey: phantom,
      } = await deriveBranches(input.credential, userSalt);
      const vaultShare = xor32(vault, serverShare);
      const rewrapped = await wrapKey(vaultShare, wrap, 'cypherkey/wrap/vault-key/v1');

      // A replacement Kit, wrapping the same unchanged vaultKey. The old Kit is retired
      // by the same transaction that accepts this one.
      const nextRecoveryCode = generateRecoveryCode();
      const nextRecoveryKey = await recoveryKeyFromCode(nextRecoveryCode);
      const nextRecoveryWrapped = await wrapKey(
        vault,
        nextRecoveryKey,
        'cypherkey/wrap/vault-key/v1',
      );
      const nextRecoveryAuthHash = toBase64Url(await recoveryAuthHashFromKey(nextRecoveryKey));
      nextRecoveryKey.fill(0);

      const device = await generateDeviceKey();
      const deviceId = toBase64Url(device.pub);
      const done = await request('POST', '/auth/recover', {
        username: input.username,
        recoveryAuthHash,
        newAuthHash: toBase64Url(authKey),
        newUserSalt: toBase64Url(userSalt),
        newWrappedVaultKey: sealedToJson(rewrapped),
        devicePub: deviceId,
        deviceName: input.deviceName,
        devicePlatform: input.devicePlatform,
        newRecoveryWrappedVaultKey: sealedToJson(nextRecoveryWrapped),
        newRecoveryAuthHash: nextRecoveryAuthHash,
      });
      authKey.fill(0);
      if (done.status !== 200) {
        vault.fill(0);
        wrap.fill(0);
        phantom.fill(0);
        device.priv.fill(0);
        throw new Error(`recovery failed with status ${done.status}`);
      }

      const devicePrivWrapped = await wrapKey(device.priv, wrap, 'cypherkey/wrap/device-key/v1');
      device.priv.fill(0);
      await deps.storage.set(KEYS.deviceId, deviceId);
      await deps.storage.set(KEYS.devicePub, deviceId);
      await deps.storage.set(
        KEYS.devicePrivWrapped,
        JSON.stringify(sealedToJson(devicePrivWrapped)),
      );
      await deps.storage.set(KEYS.userSalt, toBase64Url(userSalt));
      await cacheForOffline(vault, wrap);
      unlockWith(vault, wrap, phantom);
      vaultShareBytes = vaultShare;

      const result = asRecord(done.body);
      return {
        userId: requireString(result.userId, 'userId'),
        enrollmentToken: requireString(result.enrollmentToken, 'enrollmentToken'),
        recoveryCode: nextRecoveryCode,
      };
    },

    async refresh() {
      if (sessionTokens === null || wrapKeyBytes === null) return false;
      const device = await loadDevice(wrapKeyBytes);
      const response = await request(
        'POST',
        '/auth/refresh',
        { refreshToken: sessionTokens.refreshToken },
        device?.priv,
        device?.id,
      );
      device?.priv.fill(0);
      if (response.status !== 200) return false;

      const payload = asRecord(response.body);
      sessionTokens = {
        accessToken: requireString(payload.accessToken, 'accessToken'),
        refreshToken: requireString(payload.refreshToken, 'refreshToken'),
      };
      lastActivity = now();
      return true;
    },

    async logout() {
      if (sessionTokens === null || wrapKeyBytes === null) {
        this.lock();
        return false;
      }
      const device = await loadDevice(wrapKeyBytes);
      const response = await request(
        'POST',
        '/auth/logout',
        {},
        device?.priv,
        device?.id,
        sessionTokens.accessToken,
      );
      device?.priv.fill(0);
      // Whatever the server said, this client is done holding key material.
      this.lock();
      return response.status === 200;
    },

    async commitmentsFor(script) {
      if (phantomKeyBytes === null) {
        throw new Error('session is locked');
      }
      return (await scriptCommitments(phantomKeyBytes, script)).map(toBase64Url);
    },

    async signup(input) {
      const userSalt = randomBytes(SALT_BYTES);
      const { authKey, wrapKey: wrap, phantomKey: phantom } = await deriveBranches(input, userSalt);
      const device = await generateDeviceKey();
      const deviceId = toBase64Url(device.pub);

      // Leg one: the client wraps a random share; only the server can complete the key.
      const vaultShare = randomBytes(KEY_BYTES);
      const wrappedVaultKey = await wrapKey(vaultShare, wrap, 'cypherkey/wrap/vault-key/v1');

      const created = await request('POST', '/auth/signup', {
        username: input.username,
        email: input.email,
        authHash: toBase64Url(authKey),
        userSalt: toBase64Url(userSalt),
        wrappedVaultKey: sealedToJson(wrappedVaultKey),
        devicePub: toBase64Url(device.pub),
        deviceName: input.deviceName,
        devicePlatform: input.devicePlatform,
        consentAt: now(),
        consentPolicyVersion: input.consentPolicyVersion,
      });
      authKey.fill(0);
      if (created.status !== 201) {
        vaultShare.fill(0);
        wrap.fill(0);
        phantom.fill(0);
        throw new Error(`signup failed with status ${created.status}`);
      }

      const payload = asRecord(created.body);
      const serverShare = fromBase64Url(requireString(payload.serverShare, 'serverShare'));
      const vault = xor32(vaultShare, serverShare);

      // Leg two (A-5): the Recovery Kit wraps the FULL vault key, which the client can
      // only compute now that serverShare has arrived. Enrollment is refused until this
      // lands, so nobody ends up with a vault they cannot recover.
      const recoveryCode = generateRecoveryCode();
      const recoveryKey = await recoveryKeyFromCode(recoveryCode);
      const recoveryWrapped = await wrapKey(vault, recoveryKey, 'cypherkey/wrap/vault-key/v1');
      // M2-00f: the verifier that lets the server authenticate a recovery. A second
      // HKDF branch, so what proves possession is never what unwraps.
      const recoveryAuthHash = toBase64Url(await recoveryAuthHashFromKey(recoveryKey));
      recoveryKey.fill(0);
      // Signed with the device key registered a moment ago (A-3). An anonymous write
      // here would let anyone swap the Recovery Kit for one they control.
      const registered = await request(
        'POST',
        '/auth/recovery-key',
        { recoveryWrappedVaultKey: sealedToJson(recoveryWrapped), recoveryAuthHash },
        device.priv,
        deviceId,
      );
      if (registered.status !== 200) {
        vault.fill(0);
        wrap.fill(0);
        phantom.fill(0);
        throw new Error(`recovery-key registration failed with status ${registered.status}`);
      }

      const devicePrivWrapped = await wrapKey(device.priv, wrap, 'cypherkey/wrap/device-key/v1');
      device.priv.fill(0);
      await deps.storage.set(KEYS.deviceId, deviceId);
      await deps.storage.set(KEYS.devicePub, toBase64Url(device.pub));
      await deps.storage.set(
        KEYS.devicePrivWrapped,
        JSON.stringify(sealedToJson(devicePrivWrapped)),
      );
      await deps.storage.set(KEYS.userSalt, toBase64Url(userSalt));
      await cacheForOffline(vault, wrap);
      unlockWith(vault, wrap, phantom);
      vaultShareBytes = vaultShare;

      return {
        userId: requireString(payload.userId, 'userId'),
        recoveryCode,
        enrollmentToken: requireString(payload.enrollmentToken, 'enrollmentToken'),
      };
    },

    async login(input) {
      const { userSalt, argonParams } = await fetchSalt(input.username);
      const {
        authKey,
        wrapKey: wrap,
        phantomKey: phantom,
      } = await deriveBranches(input, userSalt, argonParams);
      await deps.storage.set(KEYS.userSalt, toBase64Url(userSalt));

      let device = await loadDevice(wrap);
      // Only a genuinely unprovisioned install mints a key. A device record that failed
      // to unwrap means a wrong passphrase, not a new device.
      const provisioned = (await deps.storage.get(KEYS.deviceId)) !== null;
      if (device === null && !provisioned) {
        // A first login on a new install: the server learns this device's public key
        // from the signature header, and registers it when step-up clears.
        const generated = await generateDeviceKey();
        provisionalDevice = { id: toBase64Url(generated.pub), priv: generated.priv };
        device = { id: provisionalDevice.id, priv: provisionalDevice.priv };
      }
      const authHash = toBase64Url(authKey);
      // A-14.2: computed here from the branch we already hold, not asked of the caller.
      const commitments = (await scriptCommitments(phantom, input.script)).map(toBase64Url);
      const body = {
        username: input.username,
        authHash,
        featureVector: input.featureVector,
        commitments,
        deviceId: device?.id ?? null,
      };
      const response = await request('POST', '/auth/login', body, device?.priv, device?.id);
      authKey.fill(0);
      // A provisional key is still needed to sign the step-up that registers it.
      if (provisionalDevice === null) device?.priv.fill(0);

      if (response.status === 401) {
        wrap.fill(0);
        phantom.fill(0);
        provisionalDevice?.priv.fill(0);
        provisionalDevice = null;
        state = 'locked';
        const error = asRecord(response.body).error;
        return { band: 'fail', error: typeof error === 'string' ? error : 'unauthorized' };
      }
      if (response.status !== 200) {
        wrap.fill(0);
        phantom.fill(0);
        state = 'locked';
        throw new Error(`login failed with status ${response.status}`);
      }

      const payload = asRecord(response.body);
      if (Array.isArray(payload.stepUp)) {
        // A-4.4 grey band: hold the wrap key so the step-up can complete without
        // re-deriving, but release nothing until it does.
        wrapKeyBytes?.fill(0);
        wrapKeyBytes = wrap;
        phantomKeyBytes?.fill(0);
        phantomKeyBytes = phantom;
        state = 'step-up-required';
        pending = { username: input.username, authHash };
        return {
          band: 'grey',
          stepUp: payload.stepUp.filter((m): m is string => typeof m === 'string'),
        };
      }

      try {
        await acceptPass(payload, wrap);
        phantomKeyBytes?.fill(0);
        phantomKeyBytes = phantom;
      } catch (err) {
        wrap.fill(0);
        phantom.fill(0);
        state = 'locked';
        throw err;
      }
      return { band: 'pass' };
    },

    async stepUp(input) {
      if (state !== 'step-up-required' || wrapKeyBytes === null || pending === null) {
        throw new Error('no step-up is pending');
      }
      const wrap = wrapKeyBytes;
      const device = provisionalDevice ?? (await loadDevice(wrap));
      const response = await request(
        'POST',
        '/auth/step-up',
        {
          username: pending.username,
          authHash: pending.authHash,
          method: input.method,
          featureVector: input.featureVector,
          commitments: await this.commitmentsFor(input.script),
        },
        device?.priv,
        device?.id,
      );

      if (response.status !== 200) {
        device?.priv.fill(0);
        provisionalDevice = null;
        const error = asRecord(response.body).error;
        return { band: 'fail', error: typeof error === 'string' ? error : 'step_up_failed' };
      }
      await acceptPass(asRecord(response.body), wrap);
      return { band: 'pass' };
    },

    /**
     * Moves the account to another Strictness (A-16).
     *
     * Medium and Relaxed differ only in server-side tolerance, so that is a settings
     * edit. Crossing into or out of Strict changes `kdfInput` and therefore
     * `masterKey`, so the client re-derives all three branches, re-wraps the vault
     * share under the new wrap key, re-commits the script under the new phantom key,
     * and hands the lot to the server in one call.
     *
     * `vaultKey` itself never changes, so the Recovery Kit blob stays valid and the
     * vault is never re-encrypted — A-1 principle 4 in practice.
     */
    async changeStrictness(input) {
      if (state !== 'unlocked' || wrapKeyBytes === null || vaultShareBytes === null) {
        return { error: 'locked' };
      }

      const current = await request(
        'GET',
        '/user/settings',
        undefined,
        null,
        undefined,
        input.accessToken,
      );
      if (current.status !== 200) return { error: 'settings_unavailable' };
      const settings = asRecord(current.body);
      const from = (asRecord(settings.thresholds).strictness ?? 'medium') as Strictness;

      if (from === input.level) return { keyVersion: Number(settings.keyVersion ?? 0) };

      // Medium to Relaxed and back moves no keys at all.
      if (from !== 'strict' && input.level !== 'strict') {
        const patched = await request(
          'PATCH',
          '/user/settings',
          { thresholds: { strictness: input.level } },
          null,
          undefined,
          input.accessToken,
        );
        if (patched.status !== 200) return { error: `settings_${patched.status}` };
        return { keyVersion: Number(asRecord(patched.body).keyVersion ?? 0) };
      }

      const saltRaw = await deps.storage.get(KEYS.userSalt);
      if (saltRaw === null) return { error: 'unknown_salt' };

      const {
        authKey,
        wrapKey: nextWrap,
        phantomKey: nextPhantom,
      } = await deriveBranches(
        { resolved: input.resolved, script: input.script, strictness: input.level },
        fromBase64Url(saltRaw),
      );

      const rewrapped = await wrapKey(vaultShareBytes, nextWrap, 'cypherkey/wrap/vault-key/v1');
      const commitments = (await scriptCommitments(nextPhantom, input.script)).map(toBase64Url);

      const device = await loadDevice(wrapKeyBytes);
      const response = await request(
        'POST',
        '/user/rekey',
        {
          strictness: input.level,
          authHash: toBase64Url(authKey),
          wrappedVaultKey: sealedToJson(rewrapped),
          commitments,
        },
        device?.priv,
        device?.id,
        input.accessToken,
      );
      authKey.fill(0);

      if (response.status !== 200) {
        device?.priv.fill(0);
        nextWrap.fill(0);
        nextPhantom.fill(0);
        return { error: `rekey_${response.status}` };
      }

      // Everything stored under the old wrap key has to move with it.
      if (device !== null) {
        const devicePrivWrapped = await wrapKey(
          device.priv,
          nextWrap,
          'cypherkey/wrap/device-key/v1',
        );
        device.priv.fill(0);
        await deps.storage.set(
          KEYS.devicePrivWrapped,
          JSON.stringify(sealedToJson(devicePrivWrapped)),
        );
      }
      await cacheForOffline(vaultKeyBytes as Uint8Array, nextWrap);
      wrapKeyBytes.fill(0);
      wrapKeyBytes = nextWrap;
      // Strictness changed the master key, so every commitment made from here on must
      // use the new branch.
      phantomKeyBytes?.fill(0);
      phantomKeyBytes = nextPhantom;

      return { keyVersion: Number(asRecord(response.body).keyVersion ?? 0) };
    },

    async unlockOffline(input) {
      const saltRaw = await deps.storage.get(KEYS.userSalt);
      const cached = await deps.storage.get(KEYS.offlineVaultKey);
      // A-7: offline unlock is only for a device that already unlocked online once.
      if (saltRaw === null || cached === null) return false;

      const {
        authKey,
        wrapKey: wrap,
        phantomKey: phantom,
      } = await deriveBranches(input, fromBase64Url(saltRaw));
      authKey.fill(0);
      try {
        const vault = await unwrapKey(
          sealedFromJson(JSON.parse(cached)),
          wrap,
          'cypherkey/wrap/vault-key-offline/v1',
        );
        unlockWith(vault, wrap, phantom);
        return true;
      } catch {
        // Wrong passphrase, or a tampered cache. Say nothing more than "no".
        wrap.fill(0);
        phantom.fill(0);
        state = 'locked';
        return false;
      }
    },

    lock() {
      vaultKeyBytes?.fill(0);
      wrapKeyBytes?.fill(0);
      vaultShareBytes?.fill(0);
      phantomKeyBytes?.fill(0);
      vaultKeyBytes = null;
      wrapKeyBytes = null;
      vaultShareBytes = null;
      phantomKeyBytes = null;
      pending = null;
      sessionTokens = null;
      provisionalDevice?.priv.fill(0);
      provisionalDevice = null;
      state = 'locked';
    },

    touch() {
      lastActivity = now();
    },

    checkIdle() {
      if (state === 'unlocked' && now() - lastActivity >= idleTimeoutMs) {
        this.lock();
      }
    },
  };
}
