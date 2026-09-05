import { describe, expect, test } from 'bun:test';
import type { Applied, Conflict, Sync, VaultItemWire } from '../../../core/client/sync';
import { createCache, memoryStore } from './cache';
import { createSyncEngine } from './engine';
import { createQueue } from './queue';

const wire = (id: string, over: Partial<VaultItemWire> = {}): VaultItemWire => ({
  id,
  version: 0,
  ciphertext: `ct-${id}`,
  nonce: `nonce-${id}`,
  updatedAt: 1_788_000_000_000,
  ...over,
});

type PushResult = { cursor: number; applied: Applied[]; conflicts: Conflict[] };

/** A server double that records what it was sent and answers what the test queued. */
function fakeSync(
  options: {
    pulls?: Array<{ items: VaultItemWire[]; cursor: number }>;
    pushes?: PushResult[];
  } = {},
) {
  const pulls = [...(options.pulls ?? [])];
  const pushes = [...(options.pushes ?? [])];
  const seen = { pulls: [] as number[], pushes: [] as VaultItemWire[][] };
  let offline = false;

  const sync: Sync = {
    async pull(since) {
      if (offline) throw new Error('offline');
      seen.pulls.push(since);
      return pulls.shift() ?? { items: [], cursor: since };
    },
    async push(items) {
      if (offline) throw new Error('offline');
      seen.pushes.push(items);
      return (
        pushes.shift() ?? {
          cursor: 1,
          applied: items.map((i, n) => ({ id: i.id, version: i.version + 1, cursor: n + 1 })),
          conflicts: [],
        }
      );
    },
  };

  return {
    sync,
    seen,
    goOffline: () => {
      offline = true;
    },
    goOnline: () => {
      offline = false;
    },
  };
}

const build = (options: Parameters<typeof fakeSync>[0] = {}, store = memoryStore()) => {
  const server = fakeSync(options);
  const cache = createCache(store);
  const queue = createQueue(store);
  return {
    ...server,
    store,
    cache,
    queue,
    engine: createSyncEngine({ sync: server.sync, cache, queue }),
  };
};

describe('a 409 is a partial success', () => {
  /**
   * The clean items in a mixed batch were applied. Treating the 409 as failure drops
   * writes that actually landed — the client library made exactly this mistake once.
   */
  test('applied items leave the queue and conflicts are reported', async () => {
    const { engine, queue } = build({
      pushes: [
        {
          cursor: 9,
          applied: [{ id: 'a', version: 1, cursor: 9 }],
          conflicts: [{ id: 'b', server: { ...wire('b'), version: 7, cursor: 4 } }],
        },
      ],
    });

    await queue.enqueue(wire('a'));
    await queue.enqueue(wire('b'));
    const result = await engine.flush();

    expect(result.pushed).toBe(1);
    expect(result.conflicts).toHaveLength(1);
    // 'b' stays queued; 'a' does not.
    expect((await queue.all()).map((r) => r.item.id)).toEqual(['b']);
  });

  test('the server copy of a conflict is cached, so resolving needs no round trip', async () => {
    const { engine, queue, cache } = build({
      pushes: [
        {
          cursor: 9,
          applied: [],
          conflicts: [
            { id: 'b', server: { ...wire('b'), ciphertext: 'theirs', version: 7, cursor: 4 } },
          ],
        },
      ],
    });

    await queue.enqueue(wire('b'));
    await engine.flush();

    const cached = await cache.get('b');
    expect(cached?.wire.ciphertext).toBe('theirs');
    expect(cached?.version).toBe(7);
  });

  test('a conflict on an item the server never had is survivable', async () => {
    const { engine, queue } = build({
      pushes: [{ cursor: 1, applied: [], conflicts: [{ id: 'ghost', server: null }] }],
    });

    await queue.enqueue(wire('ghost'));
    const result = await engine.flush();
    expect(result.conflicts[0]?.server).toBeNull();
  });

  test('a clean push empties the queue', async () => {
    const { engine, queue } = build();
    await queue.enqueue(wire('a'));
    await engine.flush();
    expect(await queue.size()).toBe(0);
  });

  test('flushing an empty queue sends nothing', async () => {
    const { engine, seen } = build();
    expect(await engine.flush()).toEqual({ pushed: 0, conflicts: [] });
    expect(seen.pushes).toHaveLength(0);
  });
});

describe('key_version invalidates the cache', () => {
  /**
   * A Strict re-key or a recovery re-wraps the vault key, so every cached blob on this
   * device is undecryptable. Surfacing that as a decryption error would look like
   * corruption; the cache is dropped and re-pulled instead.
   */
  test('a bump clears the cache and re-syncs from zero', async () => {
    const { engine, cache, seen } = build({ pulls: [{ items: [], cursor: 0 }] });
    await cache.setKeyVersion(1);
    await cache.put({ id: 'a', wire: { ciphertext: 'old', nonce: 'n' }, cursor: 5, version: 2 });
    await cache.setCursor(5);

    const { reset } = await engine.open(2);

    expect(reset).toBe(true);
    expect(await cache.items()).toHaveLength(0);
    // Pulled from zero, not from the stale cursor.
    expect(seen.pulls).toEqual([0]);
  });

  test('queued writes are discarded too, since they are wrapped under the old key', async () => {
    const { engine, cache, queue } = build();
    await cache.setKeyVersion(1);
    await queue.enqueue(wire('a'));

    await engine.open(2);
    expect(await queue.size()).toBe(0);
  });

  test('the same key version keeps the cache and resumes from its cursor', async () => {
    const { engine, cache, seen } = build();
    await cache.setKeyVersion(3);
    await cache.put({ id: 'a', wire: { ciphertext: 'ct', nonce: 'n' }, cursor: 5, version: 2 });
    await cache.setCursor(5);

    const { reset } = await engine.open(3);

    expect(reset).toBe(false);
    expect(await cache.items()).toHaveLength(1);
    expect(seen.pulls).toEqual([5]);
  });

  test('a first sync is not treated as a mismatch', async () => {
    const { engine, cache } = build();
    const { reset } = await engine.open(1);
    expect(reset).toBe(false);
    expect(await cache.keyVersion()).toBe(1);
  });
});

describe('the offline queue', () => {
  test('a write made offline is queued and reported as such', async () => {
    const { engine, queue, goOffline } = build();
    goOffline();

    const result = await engine.save(wire('a'));

    expect(result.queued).toBe(true);
    expect(await queue.size()).toBe(1);
  });

  test('the write is still readable from the cache while offline', async () => {
    const { engine, cache, goOffline } = build();
    goOffline();
    await engine.save(wire('a', { ciphertext: 'mine' }));

    expect((await cache.get('a'))?.wire.ciphertext).toBe('mine');
  });

  test('reconnecting replays the queue oldest first', async () => {
    const { engine, seen, goOffline, goOnline } = build();
    goOffline();
    await engine.save(wire('a'));
    await engine.save(wire('b'));
    await engine.save(wire('c'));
    goOnline();

    await engine.flush();

    expect(seen.pushes).toHaveLength(1);
    expect(seen.pushes[0]?.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  /** A popup closes the moment it loses focus; an edit typed earlier must survive. */
  test('a queued write survives a restart', async () => {
    const store = memoryStore();
    const first = build({}, store);
    first.goOffline();
    await first.engine.save(wire('a'));

    // A new engine over the same store is what reopening the popup looks like.
    const second = build({}, store);
    expect(await second.queue.size()).toBe(1);

    await second.engine.flush();
    expect(second.seen.pushes[0]?.map((i) => i.id)).toEqual(['a']);
  });

  test('editing the same item twice while offline pushes only the latest', async () => {
    const { engine, seen, goOffline, goOnline } = build();
    goOffline();
    await engine.save(wire('a', { ciphertext: 'first' }));
    await engine.save(wire('a', { ciphertext: 'second' }));
    goOnline();

    await engine.flush();

    // Replaying both would push a stale version and manufacture a conflict with
    // ourselves.
    expect(seen.pushes[0]).toHaveLength(1);
    expect(seen.pushes[0]?.[0]?.ciphertext).toBe('second');
  });
});

describe('pulling', () => {
  test('cursor paging resumes rather than refetching', async () => {
    const { engine, cache, seen } = build({
      pulls: [
        { items: [wire('a', { cursor: 1 }), wire('b', { cursor: 2 })], cursor: 2 },
        { items: [wire('c', { cursor: 3 })], cursor: 3 },
      ],
    });

    await engine.pull();
    expect(await cache.cursor()).toBe(2);

    await engine.pull();
    expect(seen.pulls).toEqual([0, 2]);
    expect(await cache.items()).toHaveLength(3);
  });

  test('items arrive in cursor order regardless of how they were stored', async () => {
    const { engine, cache } = build({
      pulls: [{ items: [wire('c', { cursor: 3 }), wire('a', { cursor: 1 })], cursor: 3 }],
    });

    await engine.pull();
    expect((await cache.items()).map((i) => i.id)).toEqual(['a', 'c']);
  });
});

describe('what the cache is allowed to hold', () => {
  /** A-7: ciphertext only. A cache of plaintext would outlive the idle lock. */
  test('nothing stored is readable', async () => {
    const { engine, store, goOffline } = build();
    goOffline();
    await engine.save(wire('a', { ciphertext: 'ZW5jcnlwdGVk', nonce: 'bm9uY2U' }));

    const dumped = JSON.stringify(store.dump());
    expect(dumped).toContain('ZW5jcnlwdGVk');
    for (const plaintext of ['hunter2', 'password', 'GitHub', 'username']) {
      expect(dumped).not.toContain(plaintext);
    }
  });

  test('an unparseable row is dropped rather than wedging every read', async () => {
    const store = memoryStore();
    const cache = createCache(store);
    await store.set('cypherkey.cache.item.broken', 'not json');
    await cache.put({ id: 'good', wire: { ciphertext: 'ct', nonce: 'n' }, cursor: 1, version: 0 });

    expect((await cache.items()).map((i) => i.id)).toEqual(['good']);
    expect(await store.get('cypherkey.cache.item.broken')).toBeNull();
  });

  test('clearing removes items and rewinds the cursor but keeps the key version', async () => {
    const cache = createCache(memoryStore());
    await cache.setKeyVersion(4);
    await cache.put({ id: 'a', wire: { ciphertext: 'ct', nonce: 'n' }, cursor: 2, version: 0 });
    await cache.setCursor(2);

    await cache.clear();

    expect(await cache.items()).toHaveLength(0);
    expect(await cache.cursor()).toBe(0);
    expect(await cache.keyVersion()).toBe(4);
  });
});

describe('opening offline', () => {
  /** A-7: a device that has unlocked before works from its cache. */
  test('an unreachable server does not stop the vault opening', async () => {
    const store = memoryStore();
    const seeded = build({}, store);
    await seeded.cache.setKeyVersion(1);
    await seeded.cache.put({
      id: 'a',
      wire: { ciphertext: 'ct', nonce: 'n' },
      cursor: 1,
      version: 0,
    });

    const offlineRun = build({}, store);
    offlineRun.goOffline();
    const result = await offlineRun.engine.open(1);

    expect(result.pulled).toBe(false);
    expect(result.reset).toBe(false);
    // The cache survived, so there is something to show.
    expect(await offlineRun.cache.items()).toHaveLength(1);
  });

  test('a key-version bump still clears, even when the pull then fails', async () => {
    const store = memoryStore();
    const seeded = build({}, store);
    await seeded.cache.setKeyVersion(1);
    await seeded.cache.put({
      id: 'a',
      wire: { ciphertext: 'ct', nonce: 'n' },
      cursor: 1,
      version: 0,
    });

    const run = build({}, store);
    run.goOffline();
    const result = await run.engine.open(2);

    // Those blobs are undecryptable now whether or not we can reach the server, so
    // keeping them would only produce decryption errors that look like corruption.
    expect(result.reset).toBe(true);
    expect(await run.cache.items()).toHaveLength(0);
  });
});
