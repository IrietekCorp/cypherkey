import type { ItemWire } from '../vault/codec';

/**
 * The offline cache (A-7).
 *
 * It holds **ciphertext only**. Decryption happens on read, into memory, for as long
 * as the session is unlocked — a cache of plaintext would survive the popup closing and
 * make the 15-minute idle lock decorative.
 */

/** A cached row: the blob plus what the server knows about it. */
export type CachedItem = {
  id: string;
  wire: ItemWire;
  /** Server-assigned ordering (A-6). */
  cursor: number;
  /** The version the server holds, for optimistic concurrency on the next push. */
  version: number;
  deletedAt?: number | null;
};

/**
 * The persistence seam.
 *
 * Small on purpose: IndexedDB backs it in the browser, a map backs it in tests, and
 * `chrome.storage.local` could back it too. Nothing in this module knows which.
 */
export type KeyValueStore = {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
};

const ITEM_PREFIX = 'cypherkey.cache.item.';
const CURSOR_KEY = 'cypherkey.cache.cursor';
const KEY_VERSION_KEY = 'cypherkey.cache.keyVersion';

export type Cache = {
  /** Everything held, in cursor order. */
  items(): Promise<CachedItem[]>;
  get(id: string): Promise<CachedItem | null>;
  put(item: CachedItem): Promise<void>;
  remove(id: string): Promise<void>;
  /** The highest cursor seen, so the next pull asks only for what is new. */
  cursor(): Promise<number>;
  setCursor(cursor: number): Promise<void>;
  keyVersion(): Promise<number>;
  setKeyVersion(version: number): Promise<void>;
  /** Drops every item and rewinds the cursor. Keeps nothing to be re-derived. */
  clear(): Promise<void>;
};

export function createCache(store: KeyValueStore): Cache {
  const readNumber = async (key: string): Promise<number> => {
    const raw = await store.get(key);
    if (raw === null) return 0;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  };

  return {
    async items() {
      const keys = (await store.keys()).filter((k) => k.startsWith(ITEM_PREFIX));
      const rows: CachedItem[] = [];
      for (const key of keys) {
        const raw = await store.get(key);
        if (raw === null) continue;
        try {
          rows.push(JSON.parse(raw) as CachedItem);
        } catch {
          // A row we cannot parse is a row we cannot use. Dropping it is safe: the
          // server is the source of truth and the next full sync restores it.
          await store.remove(key);
        }
      }
      return rows.sort((a, b) => a.cursor - b.cursor);
    },

    async get(id) {
      const raw = await store.get(`${ITEM_PREFIX}${id}`);
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as CachedItem;
      } catch {
        return null;
      }
    },

    async put(item) {
      await store.set(`${ITEM_PREFIX}${item.id}`, JSON.stringify(item));
    },

    async remove(id) {
      await store.remove(`${ITEM_PREFIX}${id}`);
    },

    cursor: () => readNumber(CURSOR_KEY),
    setCursor: (cursor) => store.set(CURSOR_KEY, String(cursor)),
    keyVersion: () => readNumber(KEY_VERSION_KEY),
    setKeyVersion: (version) => store.set(KEY_VERSION_KEY, String(version)),

    async clear() {
      for (const key of await store.keys()) {
        if (key.startsWith(ITEM_PREFIX)) await store.remove(key);
      }
      await store.set(CURSOR_KEY, '0');
    },
  };
}

/** For tests and for the options page's preview mode. */
export function memoryStore(): KeyValueStore & { dump(): Record<string, string> } {
  const map = new Map<string, string>();
  return {
    async get(key) {
      return map.get(key) ?? null;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async keys() {
      return [...map.keys()];
    },
    dump: () => Object.fromEntries(map),
  };
}

/**
 * IndexedDB, hand-rolled.
 *
 * `idb` was not added: this is one object store with four operations, and the wrapper
 * would cost download size on every popup open to save about thirty lines.
 */
export function indexedDbStore(dbName = 'cypherkey', storeName = 'cache'): KeyValueStore {
  const open = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = indexedDB.open(dbName, 1);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) {
          request.result.createObjectStore(storeName);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

  const run = async <T>(
    mode: IDBTransactionMode,
    work: (s: IDBObjectStore) => IDBRequest,
  ): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const request = work(db.transaction(storeName, mode).objectStore(storeName));
        request.onsuccess = () => resolve(request.result as T);
        request.onerror = () => reject(request.error);
      });
    } finally {
      db.close();
    }
  };

  return {
    async get(key) {
      return (await run<string | undefined>('readonly', (s) => s.get(key))) ?? null;
    },
    async set(key, value) {
      await run('readwrite', (s) => s.put(value, key));
    },
    async remove(key) {
      await run('readwrite', (s) => s.delete(key));
    },
    async keys() {
      return (await run<IDBValidKey[]>('readonly', (s) => s.getAllKeys())).map(String);
    },
  };
}
