import { afterAll, describe, expect, test } from 'bun:test';
import { toBase64Url } from '../../../core/crypto/encoding';
import { randomBytes } from '../../../core/crypto/kdf';
import { type Config, loadConfig } from '../config';
import { type Db, createDb } from '../db/client';
import { migrateDb } from '../db/migrate';
import * as schema from '../db/schema/sqlite';
import { NOTICE_EVENT, THROTTLE_MS, createMailer, noopTransport, resendTransport } from './client';
import { SUBJECT, renderFailureNotice } from './templates';

const open: Db[] = [];
afterAll(async () => {
  await Promise.all(open.map((d) => d.close()));
});

const CLOCK = { value: 1_788_000_000_000 };

/** A database with one user, and a transport that records rather than sends. */
async function harness() {
  CLOCK.value = 1_788_000_000_000;
  const config: Config = loadConfig({
    JWT_SECRET: 'x'.repeat(32),
    DATABASE_URL: `sqlite://${Bun.env.TMPDIR ?? '/tmp'}/ck-mail-${Bun.nanoseconds()}.db`,
  });
  const db = createDb(config.db);
  if (db.dialect !== 'sqlite') throw new Error('these tests are sqlite-only by design');
  open.push(db);
  await migrateDb(db);

  const userId = crypto.randomUUID();
  await db.drizzle.insert(schema.users).values({
    id: userId,
    username: 'shawn',
    email: 'shawn@example.test',
    authHash: 'hash',
    userSalt: toBase64Url(randomBytes(16)),
    argonParams: { m: 256, t: 1, p: 1 },
    wrappedVaultKey: { ct: 'x', nonce: 'y' },
    serverShare: toBase64Url(randomBytes(32)),
    createdAt: new Date(CLOCK.value),
    consentAt: new Date(CLOCK.value),
    consentPolicyVersion: '2026-09-01',
  });

  const sent: Array<{ to: string; subject: string; text: string }> = [];
  const mailer = createMailer({
    db,
    transport: async (message) => {
      sent.push(message);
    },
    now: () => CLOCK.value,
  });

  return { db, mailer, sent, userId, email: 'shawn@example.test' };
}

describe('the throttle', () => {
  test('a failure sends one email', async () => {
    const h = await harness();
    const result = await h.mailer.notifyRhythmFailure(h.userId, h.email);

    expect(result.sent).toBe(true);
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.to).toBe(h.email);
  });

  /**
   * Without this, an attacker who knows a passphrase turns the lockout ladder into a
   * mail flood: five failures a minute, each an email, until the notice is
   * indistinguishable from spam and the real one is missed.
   */
  test('a second failure within the hour sends nothing', async () => {
    const h = await harness();
    await h.mailer.notifyRhythmFailure(h.userId, h.email);

    const second = await h.mailer.notifyRhythmFailure(h.userId, h.email);
    expect(second).toEqual({ sent: false, reason: 'throttled' });
    expect(h.sent).toHaveLength(1);
  });

  test('ten rapid failures still send one', async () => {
    const h = await harness();
    for (let i = 0; i < 10; i++) {
      CLOCK.value += 5_000;
      await h.mailer.notifyRhythmFailure(h.userId, h.email);
    }
    expect(h.sent).toHaveLength(1);
  });

  test('after the hour, the next failure sends again', async () => {
    const h = await harness();
    await h.mailer.notifyRhythmFailure(h.userId, h.email);

    CLOCK.value += THROTTLE_MS + 1_000;
    const later = await h.mailer.notifyRhythmFailure(h.userId, h.email);

    expect(later.sent).toBe(true);
    expect(h.sent).toHaveLength(2);
  });

  test('just short of the hour still throttles', async () => {
    const h = await harness();
    await h.mailer.notifyRhythmFailure(h.userId, h.email);

    CLOCK.value += THROTTLE_MS - 1_000;
    expect((await h.mailer.notifyRhythmFailure(h.userId, h.email)).sent).toBe(false);
  });

  /**
   * The throttle lives in `audit_log`, not `rate_limits`, because that table is pruned
   * of anything idle for ten minutes — which would silently let a second email through
   * at minute eleven. A throttle that quietly does not hold is worse than none.
   */
  test('it survives eleven minutes of idleness', async () => {
    const h = await harness();
    await h.mailer.notifyRhythmFailure(h.userId, h.email);

    CLOCK.value += 11 * 60_000;
    expect((await h.mailer.notifyRhythmFailure(h.userId, h.email)).sent).toBe(false);
  });

  test('the send is recorded as an auditable event', async () => {
    const h = await harness();
    await h.mailer.notifyRhythmFailure(h.userId, h.email);

    const rows = await h.db.drizzle.select().from(schema.auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.event).toBe(NOTICE_EVENT);
    expect(rows[0]?.userId).toBe(h.userId);
  });

  test('two accounts are throttled independently', async () => {
    const h = await harness();
    const other = crypto.randomUUID();
    await h.db.drizzle.insert(schema.users).values({
      id: other,
      username: 'other',
      email: 'other@example.test',
      authHash: 'hash',
      userSalt: toBase64Url(randomBytes(16)),
      argonParams: { m: 256, t: 1, p: 1 },
      wrappedVaultKey: { ct: 'x', nonce: 'y' },
      serverShare: toBase64Url(randomBytes(32)),
      createdAt: new Date(CLOCK.value),
      consentAt: new Date(CLOCK.value),
      consentPolicyVersion: '2026-09-01',
    });

    await h.mailer.notifyRhythmFailure(h.userId, h.email);
    await h.mailer.notifyRhythmFailure(other, 'other@example.test');
    expect(h.sent).toHaveLength(2);
  });
});

describe('a provider outage does not become a login failure', () => {
  test('a throwing transport is reported, not raised', async () => {
    const h = await harness();
    const failing = createMailer({
      db: h.db,
      transport: async () => {
        throw new Error('provider down');
      },
      now: () => CLOCK.value,
    });

    expect(await failing.notifyRhythmFailure(h.userId, h.email)).toEqual({
      sent: false,
      reason: 'failed',
    });
  });

  /** A send that never happened must not throttle out the next one. */
  test('a failed send is not recorded, so the next failure retries', async () => {
    const h = await harness();
    let attempts = 0;
    const flaky = createMailer({
      db: h.db,
      transport: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('provider down');
      },
      now: () => CLOCK.value,
    });

    await flaky.notifyRhythmFailure(h.userId, h.email);
    const second = await flaky.notifyRhythmFailure(h.userId, h.email);

    expect(second.sent).toBe(true);
    expect(attempts).toBe(2);
  });
});

describe('what the email may say', () => {
  /**
   * A mailbox is not a trusted place: read on phones, forwarded, backed up
   * unencrypted, and often the very account an attacker compromises first. A score in
   * particular would tell an attacker how close they got, which is a hill-climbing
   * signal.
   */
  test('it carries no score, vector, device or address', () => {
    const { text } = renderFailureNotice({ approximateLocation: 'Germany' });
    for (const forbidden of ['score', 'vector', 'device', 'IP', '0.', 'keystroke']) {
      expect(text).not.toContain(forbidden);
    }
    expect(text).not.toMatch(/\d+\.\d+/);
  });

  test('location is coarse, and optional', () => {
    expect(renderFailureNotice({ approximateLocation: 'Germany' }).text).toContain('in Germany');
    // With nothing known, it says nothing rather than inventing precision.
    expect(renderFailureNotice().text).toContain('from somewhere');
  });

  test('it says what happened and that nothing was opened', () => {
    const { text } = renderFailureNotice();
    expect(text).toContain('typed your CypherKey passphrase correctly, and was refused');
    expect(text).toContain('vault was not opened');
  });

  /** X-3 calls it a feature: the point is that the product worked. */
  test('it frames the refusal as the product working', () => {
    expect(renderFailureNotice().text).toContain('A stolen passphrase on its own is not enough');
  });

  test('it tells a legitimate user they need do nothing', () => {
    const { text } = renderFailureNotice();
    expect(text).toContain('You do not need to do anything');
    expect(text).toContain('Backup');
  });

  test('it tells a victim what to change', () => {
    const { text } = renderFailureNotice();
    expect(text).toContain('Change it from');
    expect(text).toContain('anywhere else you have used it');
  });

  test('the subject says enough to be opened', () => {
    expect(SUBJECT).toContain('passphrase');
  });
});

describe('transports', () => {
  test('the noop transport sends nothing and is what tests use', async () => {
    await expect(noopTransport({ to: 'a@b.c', subject: 's', text: 't' })).resolves.toBeUndefined();
  });

  test('the Resend transport posts the message', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const transport = resendTransport('key-1', 'noreply@cypherkey.io', (async (
      url: string | URL,
      init?: RequestInit,
    ) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch);

    await transport({ to: 'a@b.c', subject: 'hello', text: 'body' });

    expect(calls[0]?.url).toContain('api.resend.com');
    expect(calls[0]?.body).toMatchObject({ to: ['a@b.c'], subject: 'hello', text: 'body' });
  });

  /** A provider error can echo the recipient back, and this string ends up in logs. */
  test('a provider error reports a status and not the body', async () => {
    const transport = resendTransport(
      'key-1',
      'noreply@cypherkey.io',
      (async () =>
        new Response('{"error":"a@b.c is suppressed"}', {
          status: 422,
        })) as unknown as typeof fetch,
    );

    expect(transport({ to: 'a@b.c', subject: 's', text: 't' })).rejects.toThrow(
      'failed with status 422',
    );
    expect(transport({ to: 'a@b.c', subject: 's', text: 't' })).rejects.not.toThrow('suppressed');
  });
});

describe('the login route sends only on a fail', () => {
  /**
   * A grey band is as often a bad day as an attacker. Emailing about it would teach
   * people to ignore the notice, which is exactly when the one that matters arrives.
   */
  test('the wiring is on the fail branch alone', async () => {
    const source = await Bun.file(`${import.meta.dir}/../routes/login.ts`).text();

    const failBranch = source.slice(source.indexOf("if (result === 'fail')"));
    const greyBranch = failBranch.slice(failBranch.indexOf("if (result === 'grey')"));

    expect(failBranch).toContain('notifyRhythmFailure');
    expect(greyBranch).not.toContain('notifyRhythmFailure');
    // And exactly once in the whole route, so a pass cannot acquire one by accident.
    expect(source.split('notifyRhythmFailure').length - 1).toBe(1);
  });

  test('a missing mailer is not an error', async () => {
    const source = await Bun.file(`${import.meta.dir}/../routes/login.ts`).text();
    // Optional-chained: a self-hosted instance without mail still logs people in.
    expect(source).toContain('deps.mailer?.notifyRhythmFailure');
  });
});
