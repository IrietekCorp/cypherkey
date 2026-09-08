import type { AuthedRequest } from './session';

/**
 * Client for `/vault/changes` (A-6). The server stores opaque ciphertext and orders it
 * with a per-user cursor; it can never merge, because it cannot read either side. So a
 * version mismatch comes back as a conflict carrying the server copy, and the caller
 * resolves it with the vault key it already holds.
 */
export type SyncDeps = {
  /** From `session.authed()`; signs each request with the device key (A-3). */
  request: AuthedRequest;
  /**
   * A session access token from `session.tokens()`, or a function returning the current
   * one.
   *
   * A `Sync` outlives its token. Access tokens last fifteen minutes (A-8) and a client
   * holds one of these for as long as the vault is open, so a fixed string goes stale
   * mid-session and every call after that is a 401. The function form is what a caller
   * that can refresh should pass.
   */
  token: string | (() => string);
};

/** An item exactly as it travels: ciphertext and nonce, never plaintext. */
export type VaultItemWire = {
  id: string;
  cursor?: number;
  version: number;
  ciphertext: string;
  nonce: string;
  updatedAt: number;
  deletedAt?: number | null;
};

export type Applied = { id: string; version: number; cursor: number };
export type Conflict = { id: string; server: VaultItemWire | null };

export type Sync = {
  pull(since: number): Promise<{ items: VaultItemWire[]; cursor: number }>;
  push(
    items: VaultItemWire[],
  ): Promise<{ cursor: number; applied: Applied[]; conflicts: Conflict[] }>;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null) throw new Error('malformed server response');
  return value as Record<string, unknown>;
}

function raise(path: string, status: number, body: unknown): never {
  const reason = asRecord(body).error;
  throw new Error(typeof reason === 'string' ? reason : `${path} failed with status ${status}`);
}

function num(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`malformed server response: ${field}`);
  }
  return value;
}

function array(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`malformed server response: ${field}`);
  return value;
}

export function createSync(deps: SyncDeps): Sync {
  const { request } = deps;
  const token = () => (typeof deps.token === 'string' ? deps.token : deps.token());

  return {
    async pull(since) {
      const { status, body } = await request(
        'GET',
        `/vault/changes?since=${since}`,
        undefined,
        token(),
      );
      if (status !== 200) raise('/vault/changes', status, body);
      const r = asRecord(body);
      return {
        items: array(r.items, 'items') as VaultItemWire[],
        cursor: num(r.cursor, 'cursor'),
      };
    },

    async push(items) {
      // The server's batch schema requires at least one item; an empty push would come
      // back as an opaque 400 that reads like an auth problem.
      if (items.length === 0) throw new Error('nothing to push');

      const { status, body } = await request('POST', '/vault/changes', { items }, token());
      // A-6: 409 means some items conflicted, and the clean ones in the same batch were
      // still applied. It is a partial success and the caller needs both lists.
      if (status !== 200 && status !== 409) raise('/vault/changes', status, body);

      const r = asRecord(body);
      return {
        cursor: num(r.cursor, 'cursor'),
        applied: array(r.applied, 'applied') as Applied[],
        conflicts: array(r.conflicts, 'conflicts') as Conflict[],
      };
    },
  };
}
