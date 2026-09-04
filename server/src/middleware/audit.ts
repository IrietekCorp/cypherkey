import type { MiddlewareHandler } from 'hono';
import { bearerToken, verifyToken } from '../auth/token';
import type { Config } from '../config';
import type { Db } from '../db/client';
import * as pgSchema from '../db/schema/pg';
import * as sqliteSchema from '../db/schema/sqlite';
import { clientIp, saltedId } from './identity';

/** Auth surface worth an audit row. Vault traffic is deliberately not logged. */
const AUDITED = /^\/(auth|enroll|user)\//;

export type AuditDeps = { db: Db; config: Config; now?: () => number };

/**
 * Records that an auth event happened, from which salted IP, on which device.
 *
 * It records the shape of the event and never its content: no body, no headers, no
 * score. Band-level detail already lives in `auth_score_history` per A-4.6, and
 * duplicating it here would put a second copy of the biometric signal in a table
 * that has no reason to hold one.
 */
export function auditLog(deps: AuditDeps): MiddlewareHandler {
  const { db, config } = deps;
  const now = deps.now ?? Date.now;

  return async (c, next) => {
    await next();

    const url = new URL(c.req.url);
    if (!AUDITED.test(url.pathname)) return;

    // Best effort: an unauthenticated call has no subject, and that is fine.
    const token = bearerToken(c.req.raw.headers);
    const claims = token === null ? null : verifyToken(token, config.jwtSecret, 'access', now());

    const row = {
      id: crypto.randomUUID(),
      userId: claims?.sub ?? null,
      event: `${c.req.method} ${url.pathname} ${c.res.status}`,
      ipHash: saltedId(config.jwtSecret, 'ip', clientIp(c.req.raw.headers)),
      deviceId: c.req.raw.headers.get('x-cypherkey-device'),
      createdAt: new Date(now()),
    };

    try {
      if (db.dialect === 'sqlite') await db.drizzle.insert(sqliteSchema.auditLog).values(row);
      else await db.drizzle.insert(pgSchema.auditLog).values(row);
    } catch {
      // An audit write must never turn a successful request into a failed one.
    }
  };
}
