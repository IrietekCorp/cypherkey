import { integer, primaryKey, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// docs/02 A-9, SQLite dialect. This file and ./pg.ts differ ONLY in this header;
// schema/parity.test.ts fails the build if their shapes drift apart.
const table = sqliteTable;
const txt = (n: string) => text(n);
const json = <T>(n: string) => text(n, { mode: 'json' }).$type<T>();
const ts = (n: string) => integer(n, { mode: 'timestamp_ms' });
const bool = (n: string) => integer(n, { mode: 'boolean' });
const int = (n: string) => integer(n);
const num = (n: string) => real(n);
const userRef = (n: string) =>
  text(n).references((): typeof users.id => users.id, { onDelete: 'cascade' });

/** Wrapped-key blob as stored: base64url ciphertext and nonce (`core/crypto/aead.ts`). */
export type WrappedKey = { ct: string; nonce: string };
/** Per-user tuning: Strictness (A-16) and any per-user band overrides (M3). */
export type Thresholds = { strictness?: 'strict' | 'medium' | 'relaxed' };

// Byte-valued columns are stored base64url as text so one schema serves both dialects
// without a custom type. Array columns are JSON. See docs/02 A-9.

export const users = table('users', {
  id: txt('id').primaryKey(),
  username: txt('username').notNull().unique(),
  email: txt('email').notNull(),
  userSalt: txt('user_salt').notNull(),
  /** A-2: Argon2id cost is recorded per account and returned by `GET /auth/salt`,
   *  so raising the global default never locks an existing user out. */
  argonParams: json<{ m: number; t: number; p: number }>('argon_params').notNull(),
  authHash: txt('auth_hash').notNull(),
  wrappedVaultKey: json<WrappedKey>('wrapped_vault_key').notNull(),
  recoveryWrappedVaultKey: json<WrappedKey>('recovery_wrapped_vault_key'),
  serverShare: txt('server_share').notNull(),
  keyVersion: int('key_version').notNull().default(1),
  biometricEnabled: bool('biometric_enabled').notNull().default(true),
  biometricPausedUntil: ts('biometric_paused_until'),
  thresholdsJson: json<Thresholds>('thresholds_json'),
  consentAt: ts('consent_at').notNull(),
  consentPolicyVersion: txt('consent_policy_version').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const devices = table('devices', {
  id: txt('id').primaryKey(),
  userId: userRef('user_id').notNull(),
  publicKey: txt('public_key').notNull(),
  name: txt('name').notNull(),
  platform: txt('platform').notNull(),
  trustedAt: ts('trusted_at'),
  lastSeenAt: ts('last_seen_at'),
  revokedAt: ts('revoked_at'),
});

export const biometricProfiles = table('biometric_profiles', {
  userId: userRef('user_id').primaryKey(),
  scriptLen: int('script_len').notNull(),
  means: json<number[]>('means').notNull(),
  stds: json<number[]>('stds').notNull(),
  weights: json<number[]>('weights').notNull(),
  scriptCommitments: json<string[]>('script_commitments').notNull(),
  sampleCount: int('sample_count').notNull(),
  version: int('version').notNull().default(1),
  updatedAt: ts('updated_at').notNull(),
});

export const enrollmentSamples = table('enrollment_samples', {
  id: txt('id').primaryKey(),
  userId: userRef('user_id').notNull(),
  featureVector: json<number[]>('feature_vector').notNull(),
  /** A-14: the script commitments for this sample. The first sample fixes the
   *  canonical sequence; every later one must match it exactly, so the profile is
   *  built from one script rather than several. Deleted with the sample at build. */
  scriptCommitments: json<string[]>('script_commitments').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const authScoreHistory = table('auth_score_history', {
  id: txt('id').primaryKey(),
  userId: userRef('user_id').notNull(),
  deviceId: txt('device_id'),
  score: num('score').notNull(),
  band: txt('band').$type<'pass' | 'grey' | 'fail'>().notNull(),
  createdAt: ts('created_at').notNull(),
});

// Item ids are chosen by the client, so they are only unique within an account.
// A global primary key would let one account claim an id and lock every other
// account out of it — a cross-tenant denial of service. The key is (user_id, id).
export const vaultItems = table(
  'vault_items',
  {
    id: txt('id').notNull(),
    userId: userRef('user_id').notNull(),
    /** A-6: position in this user's monotonic change log. `GET ?since=` filters on it. */
    cursor: int('cursor').notNull(),
    version: int('version').notNull(),
    ciphertext: txt('ciphertext').notNull(),
    nonce: txt('nonce').notNull(),
    updatedAt: ts('updated_at').notNull(),
    deletedAt: ts('deleted_at'),
  },
  (t) => [primaryKey({ columns: [t.userId, t.id] })],
);

export const vaultCursors = table('vault_cursors', {
  userId: userRef('user_id').primaryKey(),
  cursor: int('cursor').notNull().default(0),
});

export const refreshTokens = table('refresh_tokens', {
  id: txt('id').primaryKey(),
  userId: userRef('user_id').notNull(),
  deviceId: txt('device_id'),
  tokenHash: txt('token_hash').notNull().unique(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
  replacedBy: txt('replaced_by'),
});

export const nonces = table('nonces', {
  nonce: txt('nonce').primaryKey(),
  userId: userRef('user_id').notNull(),
  seenAt: ts('seen_at').notNull(),
});

export const stepUpFactors = table('step_up_factors', {
  id: txt('id').primaryKey(),
  userId: userRef('user_id').notNull(),
  type: txt('type').$type<'totp' | 'recovery_codes' | 'passkey'>().notNull(),
  secretEnc: txt('secret_enc').notNull(),
  createdAt: ts('created_at').notNull(),
});

export const lockouts = table('lockouts', {
  userId: userRef('user_id').primaryKey(),
  failedCount: int('failed_count').notNull().default(0),
  lockedUntil: ts('locked_until'),
});

/**
 * Token buckets for A-8's per-IP and per-account rate limiting. The key is an HMAC
 * of the scope and value under the server secret, so neither an IP nor a username
 * is ever stored here in the clear.
 */
export const rateLimits = table('rate_limits', {
  key: txt('key').primaryKey(),
  tokens: num('tokens').notNull(),
  updatedAt: ts('updated_at').notNull(),
});

export const auditLog = table('audit_log', {
  id: txt('id').primaryKey(),
  userId: txt('user_id'),
  event: txt('event').notNull(),
  ipHash: txt('ip_hash').notNull(),
  deviceId: txt('device_id'),
  createdAt: ts('created_at').notNull(),
});

/** Every table in the schema, for the dialect-parity test and for drizzle-kit. */
export const tables = {
  users,
  devices,
  biometricProfiles,
  enrollmentSamples,
  authScoreHistory,
  vaultItems,
  vaultCursors,
  refreshTokens,
  nonces,
  stepUpFactors,
  lockouts,
  rateLimits,
  auditLog,
} as const;
