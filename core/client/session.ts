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
import { generateRecoveryCode, recoveryKeyFromCode } from '../crypto/recovery';

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
};

/**
 * Bytes fed to Argon2id. Per A-14.2 this is the resolved passphrase, or
 * `resolved ‖ 0x00 ‖ script` in Strict. M1-17 builds it; the session never
 * needs to know which, which is why it takes bytes rather than a passphrase.
 */
export type Credential = { kdfInput: Uint8Array };

export type SignupInput = Credential & {
  username: string;
  email: string;
  consentPolicyVersion: string;
  deviceName: string;
  devicePlatform: string;
};

/** The recovery code is returned once and never stored (X-2 step 3). */
export type SignupResult = { userId: string; recoveryCode: string };

export type LoginInput = Credential & { username: string; featureVector: number[] };

export type LoginResult =
  | { band: 'pass' }
  | { band: 'grey'; stepUp: string[] }
  | { band: 'fail'; error: string };

export type Session = {
  state(): SessionState;
  signup(input: SignupInput): Promise<SignupResult>;
  login(input: LoginInput): Promise<LoginResult>;
  stepUp(method: string, proof: string): Promise<LoginResult>;
  unlockOffline(input: Credential): Promise<boolean>;
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
  let lastActivity = now();
  /** Held between a grey login and the step-up that resolves it. */
  let pending: { username: string } | null = null;

  /** Derives the A-2 branches, zeroing the master key as soon as its children exist. */
  async function deriveBranches(kdfInput: Uint8Array, salt: Uint8Array, params?: ArgonParams) {
    const master = await deriveMasterKey(kdfInput, salt, params ?? deps.argonParams);
    try {
      return {
        authKey: await deriveSubkey(master, 'cypherkey/auth/v1'),
        wrapKey: await deriveSubkey(master, 'cypherkey/wrap/v1'),
      };
    } finally {
      master.fill(0);
    }
  }

  async function request(
    method: string,
    path: string,
    body: unknown,
    signWith?: Uint8Array,
    deviceId?: string,
  ): Promise<{ status: number; body: unknown }> {
    const serialized = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string> = { 'content-type': 'application/json' };

    if (signWith !== undefined && deviceId !== undefined) {
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
    const priv = await unwrapKey(
      sealedFromJson(JSON.parse(stored)),
      wrap,
      'cypherkey/wrap/device-key/v1',
    );
    return { id, priv };
  }

  /** A-7: cache the full vault key wrapped under wrapKey, under its own context label. */
  async function cacheForOffline(vault: Uint8Array, wrap: Uint8Array): Promise<void> {
    const sealed = await wrapKey(vault, wrap, 'cypherkey/wrap/vault-key-offline/v1');
    await deps.storage.set(KEYS.offlineVaultKey, JSON.stringify(sealedToJson(sealed)));
  }

  /** Takes ownership of the derived keys and moves to unlocked. */
  function unlockWith(vault: Uint8Array, wrap: Uint8Array): void {
    vaultKeyBytes?.fill(0);
    wrapKeyBytes?.fill(0);
    vaultKeyBytes = vault;
    wrapKeyBytes = wrap;
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
    vaultShare.fill(0);
    await cacheForOffline(vault, wrap);
    unlockWith(vault, wrap);
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

    async signup(input) {
      const userSalt = randomBytes(SALT_BYTES);
      const { authKey, wrapKey: wrap } = await deriveBranches(input.kdfInput, userSalt);
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
        throw new Error(`signup failed with status ${created.status}`);
      }

      const payload = asRecord(created.body);
      const serverShare = fromBase64Url(requireString(payload.serverShare, 'serverShare'));
      const vault = xor32(vaultShare, serverShare);
      vaultShare.fill(0);

      // Leg two (A-5): the Recovery Kit wraps the FULL vault key, which the client can
      // only compute now that serverShare has arrived. Enrollment is refused until this
      // lands, so nobody ends up with a vault they cannot recover.
      const recoveryCode = generateRecoveryCode();
      const recoveryKey = await recoveryKeyFromCode(recoveryCode);
      const recoveryWrapped = await wrapKey(vault, recoveryKey, 'cypherkey/wrap/vault-key/v1');
      recoveryKey.fill(0);
      // Signed with the device key registered a moment ago (A-3). An anonymous write
      // here would let anyone swap the Recovery Kit for one they control.
      const registered = await request(
        'POST',
        '/auth/recovery-key',
        { recoveryWrappedVaultKey: sealedToJson(recoveryWrapped) },
        device.priv,
        deviceId,
      );
      if (registered.status !== 200) {
        vault.fill(0);
        wrap.fill(0);
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
      unlockWith(vault, wrap);

      return { userId: requireString(payload.userId, 'userId'), recoveryCode };
    },

    async login(input) {
      const { userSalt, argonParams } = await fetchSalt(input.username);
      const { authKey, wrapKey: wrap } = await deriveBranches(
        input.kdfInput,
        userSalt,
        argonParams,
      );
      await deps.storage.set(KEYS.userSalt, toBase64Url(userSalt));

      const device = await loadDevice(wrap);
      const body = {
        username: input.username,
        authHash: toBase64Url(authKey),
        featureVector: input.featureVector,
        deviceId: device?.id ?? null,
      };
      const response = await request('POST', '/auth/login', body, device?.priv, device?.id);
      authKey.fill(0);
      device?.priv.fill(0);

      if (response.status === 401) {
        wrap.fill(0);
        state = 'locked';
        const error = asRecord(response.body).error;
        return { band: 'fail', error: typeof error === 'string' ? error : 'unauthorized' };
      }
      if (response.status !== 200) {
        wrap.fill(0);
        state = 'locked';
        throw new Error(`login failed with status ${response.status}`);
      }

      const payload = asRecord(response.body);
      if (Array.isArray(payload.stepUp)) {
        // A-4.4 grey band: hold the wrap key so the step-up can complete without
        // re-deriving, but release nothing until it does.
        wrapKeyBytes?.fill(0);
        wrapKeyBytes = wrap;
        state = 'step-up-required';
        pending = { username: input.username };
        return {
          band: 'grey',
          stepUp: payload.stepUp.filter((m): m is string => typeof m === 'string'),
        };
      }

      try {
        await acceptPass(payload, wrap);
      } catch (err) {
        wrap.fill(0);
        state = 'locked';
        throw err;
      }
      return { band: 'pass' };
    },

    async stepUp(method, proof) {
      if (state !== 'step-up-required' || wrapKeyBytes === null || pending === null) {
        throw new Error('no step-up is pending');
      }
      const wrap = wrapKeyBytes;
      const device = await loadDevice(wrap);
      const response = await request(
        'POST',
        '/auth/step-up',
        { method, proof, username: pending.username },
        device?.priv,
        device?.id,
      );
      device?.priv.fill(0);

      if (response.status !== 200) {
        const error = asRecord(response.body).error;
        return { band: 'fail', error: typeof error === 'string' ? error : 'step_up_failed' };
      }
      await acceptPass(asRecord(response.body), wrap);
      return { band: 'pass' };
    },

    async unlockOffline(input) {
      const saltRaw = await deps.storage.get(KEYS.userSalt);
      const cached = await deps.storage.get(KEYS.offlineVaultKey);
      // A-7: offline unlock is only for a device that already unlocked online once.
      if (saltRaw === null || cached === null) return false;

      const { authKey, wrapKey: wrap } = await deriveBranches(
        input.kdfInput,
        fromBase64Url(saltRaw),
      );
      authKey.fill(0);
      try {
        const vault = await unwrapKey(
          sealedFromJson(JSON.parse(cached)),
          wrap,
          'cypherkey/wrap/vault-key-offline/v1',
        );
        unlockWith(vault, wrap);
        return true;
      } catch {
        // Wrong passphrase, or a tampered cache. Say nothing more than "no".
        wrap.fill(0);
        state = 'locked';
        return false;
      }
    },

    lock() {
      vaultKeyBytes?.fill(0);
      wrapKeyBytes?.fill(0);
      vaultKeyBytes = null;
      wrapKeyBytes = null;
      pending = null;
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
