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
 * The username, written by the popup rather than by `core/client`.
 *
 * Not in `PERSISTED_KEYS`, which is core's list. `Unlock` needs a username to log in
 * with, and it only ever existed in React state -- so reopening the popup could not
 * offer to unlock an account that plainly existed, and started onboarding again for a
 * user who already had one. It is not secret and it is not key material: it is the same
 * name the account was created with.
 */
export const USERNAME_KEY = 'cypherkey.user.name';

/**
 * The real `chrome.storage.local`, or null where there is none -- tests, the options
 * page preview, anything not running as an extension.
 *
 * The popup ran on `memoryArea()` until now, which meant nothing survived closing it:
 * no device identity, no salt, no cached vault. For a password manager that is not a
 * limitation, it is the whole product missing.
 */
export function localArea(): StorageArea | null {
  const chrome = (globalThis as { chrome?: { storage?: { local?: unknown } } }).chrome;
  const local = chrome?.storage?.local;
  if (local === undefined || local === null) return null;
  return local as StorageArea;
}

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
