import { z } from 'zod';
import { ARGON_PARAMS, type ArgonParams } from '../../core/crypto/kdf';

/** Thrown when the environment is unusable. Never carries a secret or a connection string. */
export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/** Which driver `DATABASE_URL` selected, plus what that driver needs to open it. */
export type DbConfig =
  | { dialect: 'sqlite'; url: string; path: string }
  | { dialect: 'postgres'; url: string };

/**
 * The X-3 failure email, or nothing.
 *
 * Null is a first-class answer: a self-hosted instance with no provider sends no mail
 * and still logs people in. What is *not* allowed is half of it — see `loadConfig`.
 */
export type MailConfig = { apiKey: string; from: string };

export type Config = {
  port: number;
  db: DbConfig;
  jwtSecret: string;
  /** Null when no provider is configured, which is a supported way to run. */
  mail: MailConfig | null;
  /**
   * A-2: Argon2id cost is recorded per account at signup and returned by `/auth/salt`.
   * The server is authoritative — it records its own defaults rather than trusting a
   * client-supplied cost, which a malicious client could set low.
   */
  argonParams: ArgonParams;
  enrollmentSamples: number;
  scorePass: number;
  scoreGrey: number;
};

/** A-13 default: self-host and dev run on SQLite unless told otherwise. */
const DEFAULT_DATABASE_URL = 'sqlite://./cypherkey.db';

/** A-13: `JWT_SECRET` is >= 32 random bytes. There is deliberately no fallback. */
const MIN_JWT_SECRET_BYTES = 32;

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().max(65535).default(3000),
  DATABASE_URL: z.string().min(1).default(DEFAULT_DATABASE_URL),
  ENROLLMENT_SAMPLES: z.coerce.number().int().min(5).max(20).default(8),
  SCORE_PASS: z.coerce.number().min(0).max(1).default(0.62),
  SCORE_GREY: z.coerce.number().min(0).max(1).default(0.45),
  RESEND_API_KEY: z.string().optional(),
  MAIL_FROM: z.string().optional(),
});

/**
 * Splits `DATABASE_URL` into a driver choice (also used by drizzle-kit, which has no
 * business needing JWT_SECRET), without ever quoting the URL back
 * on failure — it carries a password.
 */
export function parseDatabaseUrl(url: string): DbConfig {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    return { dialect: 'postgres', url };
  }
  if (url.startsWith('sqlite://')) {
    return { dialect: 'sqlite', url, path: url.slice('sqlite://'.length) };
  }
  if (url.startsWith('file:')) {
    return { dialect: 'sqlite', url, path: url.slice('file:'.length) };
  }
  throw new ConfigError(
    `DATABASE_URL must begin with sqlite://, file:, postgres:// or postgresql://. Got scheme "${url.split(':', 1)[0]}".`,
  );
}

/**
 * Reads and validates the environment, returning a fully-defaulted config, or
 * throws `ConfigError` with a message that names the variable and never its value.
 */
export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
  const jwtSecret = env.JWT_SECRET;
  if (jwtSecret === undefined || jwtSecret === '') {
    throw new ConfigError(
      'JWT_SECRET is not set and there is no default. Generate one with: openssl rand -base64 48',
    );
  }
  const secretBytes = new TextEncoder().encode(jwtSecret).length;
  if (secretBytes < MIN_JWT_SECRET_BYTES) {
    throw new ConfigError(
      `JWT_SECRET must be at least ${MIN_JWT_SECRET_BYTES} bytes; got ${secretBytes}. Generate one with: openssl rand -base64 48`,
    );
  }

  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const names = [...new Set(parsed.error.issues.map((i) => i.path.join('.')))];
    throw new ConfigError(`Invalid environment: ${names.join(', ')}. See docs/02 A-13.`);
  }
  const e = parsed.data;

  if (e.SCORE_PASS <= e.SCORE_GREY) {
    throw new ConfigError(
      `SCORE_PASS (${e.SCORE_PASS}) must be greater than SCORE_GREY (${e.SCORE_GREY}).`,
    );
  }

  return {
    port: e.PORT,
    db: parseDatabaseUrl(e.DATABASE_URL),
    jwtSecret,
    mail: parseMail(blank(e.RESEND_API_KEY), blank(e.MAIL_FROM)),
    argonParams: ARGON_PARAMS,
    enrollmentSamples: e.ENROLLMENT_SAMPLES,
    scorePass: e.SCORE_PASS,
    scoreGrey: e.SCORE_GREY,
  };
}

/** An empty variable is an unset one. Deployment templates set both far too easily. */
function blank(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

/**
 * Both halves or neither, and refusing in between.
 *
 * Sending mail needs a key *and* an address the provider will accept as the sender, so
 * either alone is a configuration nobody meant. Refusing is deliberate and follows
 * `JWT_SECRET`: half-configured mail is the state where an operator believes the X-3
 * notice is going out and it is not, which is worse than not offering it at all. That is
 * the failure this variable already had — it was in Secret Manager's plan and read by
 * nothing.
 */
function parseMail(apiKey: string | undefined, from: string | undefined): MailConfig | null {
  if (apiKey === undefined && from === undefined) return null;
  if (apiKey === undefined) {
    throw new ConfigError('MAIL_FROM is set but RESEND_API_KEY is not, so no mail can be sent.');
  }
  if (from === undefined) {
    throw new ConfigError(
      'RESEND_API_KEY is set but MAIL_FROM is not. Set the verified sender address, e.g. MAIL_FROM="CypherKey <noreply@cypherkey.io>".',
    );
  }
  return { apiKey, from };
}

/** Loads the config, or prints the reason and exits non-zero. Used by the entrypoint only. */
export function loadConfigOrExit(env: Record<string, string | undefined> = Bun.env): Config {
  try {
    return loadConfig(env);
  } catch (err) {
    const message = err instanceof ConfigError ? err.message : String(err);
    console.error(`cypherkey: refusing to start.\n  ${message}`);
    process.exit(1);
  }
}
