import type { VaultItemWire } from '../../../core/client/sync';
import type { KeyValueStore } from './cache';

/**
 * Writes made while offline, or while a push was failing.
 *
 * Persisted rather than held in memory: a popup closes the instant it loses focus, and
 * an edit typed thirty seconds earlier must not vanish with it. The queue holds
 * ciphertext, like everything else that rests.
 */

export type QueuedWrite = {
  /** Monotonic, so replay order matches the order the user made the changes. */
  seq: number;
  item: VaultItemWire;
};

const QUEUE_KEY = 'cypherkey.sync.queue';

export type Queue = {
  enqueue(item: VaultItemWire): Promise<void>;
  all(): Promise<QueuedWrite[]>;
  /** Drops the given sequence numbers, leaving anything added since. */
  forget(seqs: number[]): Promise<void>;
  clear(): Promise<void>;
  size(): Promise<number>;
};

export function createQueue(store: KeyValueStore): Queue {
  const read = async (): Promise<QueuedWrite[]> => {
    const raw = await store.get(QUEUE_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as QueuedWrite[]) : [];
    } catch {
      // Better to lose an unreadable queue than to wedge every future sync on it.
      return [];
    }
  };

  const write = (rows: QueuedWrite[]) => store.set(QUEUE_KEY, JSON.stringify(rows));

  return {
    async enqueue(item) {
      const rows = await read();
      // One entry per item: a later edit supersedes an earlier one, and replaying both
      // would push a stale version and manufacture a conflict against ourselves.
      const withoutPrevious = rows.filter((row) => row.item.id !== item.id);
      const nextSeq = rows.reduce((max, row) => Math.max(max, row.seq), 0) + 1;
      await write([...withoutPrevious, { seq: nextSeq, item }]);
    },

    async all() {
      return (await read()).sort((a, b) => a.seq - b.seq);
    },

    async forget(seqs) {
      const drop = new Set(seqs);
      await write((await read()).filter((row) => !drop.has(row.seq)));
    },

    async clear() {
      await store.remove(QUEUE_KEY);
    },

    async size() {
      return (await read()).length;
    },
  };
}
