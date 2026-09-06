import { and, desc, eq, gt } from 'drizzle-orm';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';
import { type FailureNotice, renderFailureNotice } from './templates';

/**
 * Sending the X-3 failure notice, at most once an hour per account.
 *
 * The throttle is not a nicety. Without it, an attacker who knows a passphrase can turn
 * the lockout ladder into a mail flood: five failures a minute, each one an email, aimed
 * at the account's own inbox until the notice is indistinguishable from spam and the
 * real one is missed.
 *
 * It is recorded in `audit_log` rather than in `rate_limits`. The rate-limit table is
 * pruned of anything idle for ten minutes, which would silently let a second email
 * through at minute eleven — a throttle that quietly does not hold is worse than none.
 * "We emailed this user" is also a genuinely auditable event, so the row belongs there.
 */

export const NOTICE_EVENT = 'rhythm_fail_email';
export const THROTTLE_MS = 60 * 60_000;

/** Whatever actually puts mail on the wire. Injected so tests send nothing. */
export type Transport = (message: {
  to: string;
  subject: string;
  text: string;
}) => Promise<void>;

export type MailerDeps = {
  db: Db;
  transport: Transport;
  now?: () => number;
};

export type Mailer = {
  /** Returns whether an email was sent, so a caller can report honestly in tests. */
  notifyRhythmFailure(
    userId: string,
    email: string,
    notice?: FailureNotice,
  ): Promise<{ sent: boolean; reason?: 'throttled' | 'failed' }>;
};

async function sentWithinWindow(db: Db, userId: string, since: Date): Promise<boolean> {
  const rows =
    db.dialect === 'sqlite'
      ? await db.drizzle
          .select()
          .from(sqliteSchema.auditLog)
          .where(
            and(
              eq(sqliteSchema.auditLog.userId, userId),
              eq(sqliteSchema.auditLog.event, NOTICE_EVENT),
              gt(sqliteSchema.auditLog.createdAt, since),
            ),
          )
          .orderBy(desc(sqliteSchema.auditLog.createdAt))
          .limit(1)
      : await db.drizzle
          .select()
          .from(pgSchema.auditLog)
          .where(
            and(
              eq(pgSchema.auditLog.userId, userId),
              eq(pgSchema.auditLog.event, NOTICE_EVENT),
              gt(pgSchema.auditLog.createdAt, since),
            ),
          )
          .orderBy(desc(pgSchema.auditLog.createdAt))
          .limit(1);
  return rows.length > 0;
}

async function record(db: Db, userId: string, at: Date): Promise<void> {
  const row = {
    id: crypto.randomUUID(),
    userId,
    event: NOTICE_EVENT,
    // A-11: the audit log stores a hash, never an address. There is no IP to attribute
    // this to — it is our own send — so a fixed marker is honest and keeps the column
    // non-null without inventing a plausible-looking value.
    ipHash: 'system',
    deviceId: null,
    createdAt: at,
  };
  if (db.dialect === 'sqlite') await db.drizzle.insert(sqliteSchema.auditLog).values(row);
  else await db.drizzle.insert(pgSchema.auditLog).values(row);
}

export function createMailer(deps: MailerDeps): Mailer {
  const now = deps.now ?? Date.now;

  return {
    async notifyRhythmFailure(userId, email, notice) {
      const at = now();
      if (await sentWithinWindow(deps.db, userId, new Date(at - THROTTLE_MS))) {
        return { sent: false, reason: 'throttled' };
      }

      const { subject, text } = renderFailureNotice(notice);
      try {
        await deps.transport({ to: email, subject, text });
      } catch {
        // A login must not fail because a mail provider is down. The attempt is not
        // recorded, so the next failure will try again rather than being throttled out
        // by a send that never happened.
        return { sent: false, reason: 'failed' };
      }

      await record(deps.db, userId, new Date(at));
      return { sent: true };
    },
  };
}

/**
 * Resend over plain `fetch`.
 *
 * The `resend` package was not added: this is one POST, and the seam that matters is
 * `Transport`, which is already injected. A dependency here would buy typed errors for
 * a call whose only outcomes are "sent" and "did not send".
 */
export function resendTransport(apiKey: string, from: string, fetchImpl = fetch): Transport {
  return async (message) => {
    const response = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from,
        to: [message.to],
        subject: message.subject,
        text: message.text,
      }),
    });
    if (!response.ok) {
      // Deliberately not the body: a provider error can echo the recipient back, and
      // this string ends up in logs.
      throw new Error(`mail send failed with status ${response.status}`);
    }
  };
}

/** For self-hosting without a mail provider, and for every test. */
export const noopTransport: Transport = async () => {};
