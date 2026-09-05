import type { Conflict, Sync, VaultItemWire } from '../../../core/client/sync';
import type { Cache } from './cache';
import type { Queue } from './queue';

/**
 * Pull, push, and the offline queue in between.
 *
 * The two rules that are easy to get wrong and expensive to get wrong:
 *
 * 1. **A 409 from `push` is a partial success.** The clean items in a mixed batch were
 *    applied; only the conflicting ones came back. Treating it as failure silently
 *    drops writes that actually landed, and the client library made exactly that
 *    mistake once already.
 * 2. **A `key_version` bump invalidates the whole cache.** A Strict re-key (A-16) or a
 *    recovery (M2-00f) re-wraps the vault key, so every blob this device cached is
 *    undecryptable. Surfacing that as a decryption error would look like corruption;
 *    the cache is dropped and re-pulled from zero instead.
 */

export type SyncEngine = {
  /**
   * Reconciles the cache against the account's current key version, then pulls.
   *
   * Returns whether the cache had to be discarded, and whether the pull actually
   * happened — opening the vault on a train must show what is cached rather than
   * failing, so a pull that cannot reach the server is reported, not thrown.
   */
  open(keyVersion: number): Promise<{ reset: boolean; pulled: boolean }>;
  /** Records a local write and pushes it, queueing it if the push cannot happen. */
  save(item: VaultItemWire): Promise<{ queued: boolean; conflicts: Conflict[] }>;
  /** Sends everything queued, oldest first. Safe to call repeatedly. */
  flush(): Promise<{ pushed: number; conflicts: Conflict[] }>;
  /** Fetches everything after the cached cursor. */
  pull(): Promise<{ received: number }>;
};

export type EngineDeps = { sync: Sync; cache: Cache; queue: Queue };

export function createSyncEngine({ sync, cache, queue }: EngineDeps): SyncEngine {
  /** Writes what the server returned into the cache and advances the cursor. */
  const absorb = async (items: VaultItemWire[], cursor: number): Promise<void> => {
    for (const item of items) {
      await cache.put({
        id: item.id,
        wire: { ciphertext: item.ciphertext, nonce: item.nonce },
        cursor: item.cursor ?? 0,
        version: item.version,
        deletedAt: item.deletedAt ?? null,
      });
    }
    await cache.setCursor(cursor);
  };

  const pull: SyncEngine['pull'] = async () => {
    const since = await cache.cursor();
    const { items, cursor } = await sync.pull(since);
    await absorb(items, cursor);
    return { received: items.length };
  };

  return {
    async open(keyVersion) {
      const cached = await cache.keyVersion();
      // 0 means "nothing cached yet", which is not a mismatch.
      const reset = cached !== 0 && cached !== keyVersion;
      if (reset) {
        // Every blob here is wrapped under a key this device no longer has. Queued
        // writes go too: they were encrypted under the old key and the server would
        // store ciphertext nobody can read.
        await cache.clear();
        await queue.clear();
      }
      await cache.setKeyVersion(keyVersion);
      try {
        await pull();
        return { reset, pulled: true };
      } catch {
        // Offline. A-7 says a device that has unlocked before can work from its cache,
        // so this is a normal state rather than a failure to report upward.
        return { reset, pulled: false };
      }
    },

    async save(item) {
      // Cache first, so the edit survives whatever happens to the network.
      await cache.put({
        id: item.id,
        wire: { ciphertext: item.ciphertext, nonce: item.nonce },
        cursor: (await cache.get(item.id))?.cursor ?? 0,
        version: item.version,
        deletedAt: item.deletedAt ?? null,
      });
      await queue.enqueue(item);

      try {
        const { conflicts } = await this.flush();
        return { queued: false, conflicts };
      } catch {
        // Offline, or the server is unhappy. The write is queued and will go on the
        // next flush; reporting it as failed would invite the user to retype it.
        return { queued: true, conflicts: [] };
      }
    },

    async flush() {
      const pending = await queue.all();
      if (pending.length === 0) return { pushed: 0, conflicts: [] };

      const result = await sync.push(pending.map((row) => row.item));

      // A 409 is partial: `applied` says what landed, `conflicts` what did not. Only
      // the applied ones may leave the queue.
      const applied = new Set(result.applied.map((a) => a.id));
      const done = pending.filter((row) => applied.has(row.item.id));
      await queue.forget(done.map((row) => row.seq));

      for (const entry of result.applied) {
        const cached = await cache.get(entry.id);
        if (cached !== null) {
          await cache.put({ ...cached, version: entry.version, cursor: entry.cursor });
        }
      }

      // The server copy of each conflict comes back with it, so the caller can resolve
      // without another round trip (A-6). Cache it, since it is newer than what we had.
      for (const conflict of result.conflicts) {
        if (conflict.server === null) continue;
        await cache.put({
          id: conflict.id,
          wire: { ciphertext: conflict.server.ciphertext, nonce: conflict.server.nonce },
          cursor: conflict.server.cursor ?? 0,
          version: conflict.server.version,
          deletedAt: conflict.server.deletedAt ?? null,
        });
      }

      await cache.setCursor(Math.max(await cache.cursor(), result.cursor));
      return { pushed: done.length, conflicts: result.conflicts };
    },

    pull,
  };
}
