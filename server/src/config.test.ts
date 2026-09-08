import { describe, expect, test } from 'bun:test';
import { ConfigError, loadConfig } from './config';

const SECRET_32 = 'x'.repeat(32);

function env(overrides: Record<string, string | undefined> = {}) {
  return { JWT_SECRET: SECRET_32, ...overrides };
}

describe('loadConfig — JWT_SECRET', () => {
  test('rejects a missing secret', () => {
    expect(() => loadConfig({})).toThrow(ConfigError);
    expect(() => loadConfig({})).toThrow(/JWT_SECRET is not set/);
  });

  test('rejects an empty secret — there is no fallback', () => {
    expect(() => loadConfig({ JWT_SECRET: '' })).toThrow(/JWT_SECRET is not set/);
  });

  test('rejects a secret shorter than 32 bytes', () => {
    expect(() => loadConfig(env({ JWT_SECRET: 'x'.repeat(31) }))).toThrow(/at least 32 bytes/);
  });

  test('accepts exactly 32 bytes', () => {
    expect(loadConfig(env()).jwtSecret).toBe(SECRET_32);
  });

  test('measures bytes, not code units — 31 multi-byte chars are enough', () => {
    // 31 × 2 bytes = 62 bytes, which passes even though .length is 31.
    expect(() => loadConfig(env({ JWT_SECRET: 'é'.repeat(31) }))).not.toThrow();
  });

  test('never echoes the secret in an error message', () => {
    const secret = 'super-secret-but-too-short';
    let message = '';
    try {
      loadConfig({ JWT_SECRET: secret });
    } catch (e) {
      message = String(e);
    }
    expect(message).not.toContain(secret);
    expect(message).toMatch(/at least 32 bytes/);
  });
});

describe('loadConfig — DATABASE_URL selects the driver', () => {
  test('defaults to SQLite per A-13', () => {
    const cfg = loadConfig(env());
    expect(cfg.db.dialect).toBe('sqlite');
    expect(cfg.db).toMatchObject({ path: './cypherkey.db' });
  });

  test('sqlite:// URL yields a sqlite path', () => {
    const cfg = loadConfig(env({ DATABASE_URL: 'sqlite://./tmp/x.db' }));
    expect(cfg.db).toEqual({ dialect: 'sqlite', url: 'sqlite://./tmp/x.db', path: './tmp/x.db' });
  });

  test('sqlite in-memory URL is supported', () => {
    expect(loadConfig(env({ DATABASE_URL: 'sqlite://:memory:' })).db).toMatchObject({
      dialect: 'sqlite',
      path: ':memory:',
    });
  });

  test('postgres:// and postgresql:// both select postgres', () => {
    for (const url of ['postgres://u:p@h:5432/d', 'postgresql://u:p@h:5432/d']) {
      expect(loadConfig(env({ DATABASE_URL: url })).db.dialect).toBe('postgres');
    }
  });

  test('rejects an unsupported scheme', () => {
    expect(() => loadConfig(env({ DATABASE_URL: 'mysql://h/d' }))).toThrow(/DATABASE_URL/);
  });

  test('never echoes the URL in an error message — it carries a password', () => {
    let message = '';
    try {
      loadConfig(env({ DATABASE_URL: 'mysql://user:hunter2@host/db' }));
    } catch (e) {
      message = String(e);
    }
    expect(message).not.toContain('hunter2');
  });
});

describe('loadConfig — A-13 defaults and ranges', () => {
  test('applies the documented defaults', () => {
    const cfg = loadConfig(env());
    expect(cfg.port).toBe(3000);
    expect(cfg.enrollmentSamples).toBe(8);
    expect(cfg.scorePass).toBe(0.62);
    expect(cfg.scoreGrey).toBe(0.45);
  });

  test('reads overrides', () => {
    const cfg = loadConfig(env({ PORT: '8080', ENROLLMENT_SAMPLES: '5', SCORE_PASS: '0.7' }));
    expect(cfg.port).toBe(8080);
    expect(cfg.enrollmentSamples).toBe(5);
    expect(cfg.scorePass).toBe(0.7);
  });

  test('holds ENROLLMENT_SAMPLES to 5..20', () => {
    expect(() => loadConfig(env({ ENROLLMENT_SAMPLES: '4' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ ENROLLMENT_SAMPLES: '21' }))).toThrow(ConfigError);
  });

  test('rejects a pass band at or below the grey band', () => {
    expect(() => loadConfig(env({ SCORE_PASS: '0.4', SCORE_GREY: '0.45' }))).toThrow(/SCORE_PASS/);
  });
});

describe('loadConfig - the mail provider is optional, and never half-set', () => {
  test('neither variable means no mail, which is a supported way to run', () => {
    expect(loadConfig(env()).mail).toBeNull();
  });

  test('both variables give a mail config', () => {
    const config = loadConfig(
      env({ RESEND_API_KEY: 're_key', MAIL_FROM: 'CypherKey <noreply@cypherkey.io>' }),
    );
    expect(config.mail).toEqual({
      apiKey: 're_key',
      from: 'CypherKey <noreply@cypherkey.io>',
    });
  });

  /**
   * The state worth refusing: an operator who set the key believes the X-3 notice is
   * going out. Starting anyway and sending nothing is how `RESEND_API_KEY` sat in the
   * deploy plan while no code read it.
   */
  test('a key with no sender refuses to start, and says which is missing', () => {
    expect(() => loadConfig(env({ RESEND_API_KEY: 're_key' }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ RESEND_API_KEY: 're_key' }))).toThrow(/MAIL_FROM is not/);
  });

  test('a sender with no key refuses too', () => {
    expect(() => loadConfig(env({ MAIL_FROM: 'noreply@cypherkey.io' }))).toThrow(
      /RESEND_API_KEY is not/,
    );
  });

  /** A deployment template that sets a variable to nothing has not set it. */
  test('empty strings are unset, not half-configured', () => {
    expect(loadConfig(env({ RESEND_API_KEY: '', MAIL_FROM: '  ' })).mail).toBeNull();
  });

  test('the failure message never quotes the key', () => {
    try {
      loadConfig(env({ RESEND_API_KEY: 're_the_actual_secret' }));
      throw new Error('expected a ConfigError');
    } catch (err) {
      expect((err as Error).message).not.toContain('re_the_actual_secret');
    }
  });
});
