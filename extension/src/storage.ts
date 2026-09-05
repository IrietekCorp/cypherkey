import type { SessionStorage } from '../../core/client/session';

/**
 * The subset of `chrome.storage.StorageArea` this adapter uses. Declared here rather
 * than depending on `@types/chrome` so the adapter can be driven by a double in tests
 * and by a real area in the browser without either knowing about the other.
 */
export type StorageArea = {
  get(keys: string | string[] | null): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
  remove(keys: string | string[]): Promise<void>;
};

/**
 * A-7: the only things allowed to survive a popup close.
 *
 * `core/client` writes exactly these five and nothing else. The list is enforced by a
 * test rather than left as a comment, because "what is allowed to persist" is the one
 * question a zero-knowledge client must never get wrong by accident.
 */
export const PERSISTED_KEYS = [
  'cypherkey.device.id',
  'cypherkey.device.privWrapped',
  'cypherkey.device.pub',
  'cypherkey.user.salt',
  'cypherkey.vault.offline',
] as const;

/**
 * `SessionStorage` over a `chrome.storage` area.
 *
 * Values are strings by contract; anything else in the area was not written by us and
 * is treated as absent rather than coerced, so a corrupted or foreign entry fails
 * closed — `loadDevice` then reports "no device" instead of unwrapping garbage.
 */
export function extensionStorage(area: StorageArea): SessionStorage {
  return {
    async get(key) {
      const found = await area.get(key);
      const value = found[key];
      return typeof value === 'string' ? value : null;
    },
    async set(key, value) {
      await area.set({ [key]: value });
    },
    async remove(key) {
      await area.remove(key);
    },
  };
}

/** An in-memory `StorageArea`, used by tests and by the options page's preview mode. */
export function memoryArea(): StorageArea & { dump(): Record<string, unknown> } {
  const map = new Map<string, unknown>();
  return {
    async get(keys) {
      if (keys === null) return Object.fromEntries(map);
      const list = typeof keys === 'string' ? [keys] : keys;
      const out: Record<string, unknown> = {};
      for (const k of list) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of typeof keys === 'string' ? [keys] : keys) map.delete(k);
    },
    dump: () => Object.fromEntries(map),
  };
}
