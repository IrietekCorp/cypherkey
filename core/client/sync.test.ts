import { describe, expect, test } from 'bun:test';
import type { AuthedRequest } from './session';
import { createSync } from './sync';

type Call = { method: string; path: string; body?: unknown; token?: string };

function recorder(replies: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const request: AuthedRequest = async (method, path, body, token) => {
    calls.push({ method, path, body, token });
    const next = replies.shift();
    if (next === undefined) throw new Error(`unexpected call to ${path}`);
    return next;
  };
  return { calls, request };
}

const TOKEN = 'access-token-xyz';

const ITEM = {
  id: 'item-1',
  cursor: 4,
  version: 2,
  ciphertext: 'Y2lwaGVy',
  nonce: 'bm9uY2U',
  updatedAt: 1_700_000_000_000,
  deletedAt: null,
};

describe('createSync', () => {
  test('pull asks for everything after the cursor it is given', async () => {
    const { calls, request } = recorder([{ status: 200, body: { items: [ITEM], cursor: 4 } }]);
    const sync = createSync({ request, token: TOKEN });

    const result = await sync.pull(2);

    expect(result).toEqual({ items: [ITEM], cursor: 4 });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/vault/changes?since=2');
    expect(calls[0]?.token).toBe(TOKEN);
  });

  test('pull from zero is a full sync', async () => {
    const { calls, request } = recorder([{ status: 200, body: { items: [], cursor: 0 } }]);
    const sync = createSync({ request, token: TOKEN });

    expect(await sync.pull(0)).toEqual({ items: [], cursor: 0 });
    expect(calls[0]?.path).toBe('/vault/changes?since=0');
  });

  test('push sends the batch and reports what landed', async () => {
    const { calls, request } = recorder([
      {
        status: 200,
        body: { cursor: 9, applied: [{ id: 'item-1', version: 3, cursor: 9 }], conflicts: [] },
      },
    ]);
    const sync = createSync({ request, token: TOKEN });

    const result = await sync.push([ITEM]);

    expect(result.cursor).toBe(9);
    expect(result.applied).toEqual([{ id: 'item-1', version: 3, cursor: 9 }]);
    expect(result.conflicts).toEqual([]);
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.body).toEqual({ items: [ITEM] });
  });

  /**
   * A-6: the server answers a mixed batch with 409 and applies the clean items anyway.
   * Treating that as a failure would silently drop writes that actually landed.
   */
  test('a 409 is a partial success, not an error', async () => {
    const { request } = recorder([
      {
        status: 409,
        body: {
          cursor: 9,
          applied: [{ id: 'item-1', version: 3, cursor: 9 }],
          conflicts: [{ id: 'item-2', server: { ...ITEM, id: 'item-2', version: 7 } }],
        },
      },
    ]);
    const sync = createSync({ request, token: TOKEN });

    const result = await sync.push([ITEM, { ...ITEM, id: 'item-2' }]);

    expect(result.applied).toHaveLength(1);
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.id).toBe('item-2');
    // The server copy comes back so the client can resolve without another round trip.
    expect(result.conflicts[0]?.server?.version).toBe(7);
  });

  test('a conflict on an item the server never had reports a null server copy', async () => {
    const { request } = recorder([
      {
        status: 409,
        body: { cursor: 3, applied: [], conflicts: [{ id: 'ghost', server: null }] },
      },
    ]);
    const sync = createSync({ request, token: TOKEN });

    const result = await sync.push([ITEM]);
    expect(result.conflicts[0]).toEqual({ id: 'ghost', server: null });
  });

  test('an empty push is refused before it reaches the network', async () => {
    const { calls, request } = recorder([]);
    const sync = createSync({ request, token: TOKEN });

    // The server's batch schema requires at least one item; failing here gives a clear
    // message instead of an opaque 400.
    expect(sync.push([])).rejects.toThrow('nothing to push');
    expect(calls).toHaveLength(0);
  });

  test('a real failure still throws, carrying the server reason', async () => {
    const { request } = recorder([{ status: 401, body: { error: 'unauthorized' } }]);
    const sync = createSync({ request, token: TOKEN });
    expect(sync.pull(0)).rejects.toThrow('unauthorized');
  });

  /** Absence test: sync moves ciphertext, never keys and never plaintext. */
  test('pushes ciphertext and nothing that could decrypt it', async () => {
    const { calls, request } = recorder([
      { status: 200, body: { cursor: 1, applied: [], conflicts: [] } },
    ]);
    const sync = createSync({ request, token: TOKEN });
    await sync.push([ITEM]);

    const sent = JSON.stringify(calls[0]?.body);
    for (const forbidden of ['vaultKey', 'wrapKey', 'plaintext', 'password', 'kdfInput']) {
      expect(sent).not.toContain(forbidden);
    }
  });
});
