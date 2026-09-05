import { type Session, createSession } from '../../core/client/session';
import type { ArgonParams, deriveMasterKey } from '../../core/crypto/kdf';
import type { KdfRequest, KdfResponse } from './kdf-worker';
import { type StorageArea, extensionStorage } from './storage';

/** The part of `Worker` this uses, so tests can supply a double. */
export type KdfWorker = {
  postMessage(value: KdfRequest | 'warm'): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  terminate?(): void;
};

/**
 * Wraps a Worker as the `deriveKey` the session injects.
 *
 * Requests are correlated by id rather than by arrival order: two derivations can be in
 * flight at once (an unlock racing a background refresh), and resolving them in order
 * would silently hand one caller the other's key.
 */
export function workerKdf(worker: KdfWorker): typeof deriveMasterKey {
  const pending = new Map<number, (r: KdfResponse) => void>();
  let nextId = 1;

  worker.addEventListener('message', (event) => {
    const data = event.data as KdfResponse | { warmed: true };
    if (!('id' in data)) return;
    pending.get(data.id)?.(data);
    pending.delete(data.id);
  });

  return (kdfInput: Uint8Array, salt: Uint8Array, params?: ArgonParams) =>
    new Promise<Uint8Array>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, (response) => {
        if (response.ok) resolve(response.key);
        else reject(new Error(response.error));
      });
      worker.postMessage({ id, kdfInput, salt, params });
    });
}

export type ExtensionSessionDeps = {
  baseUrl: string;
  area: StorageArea;
  worker: KdfWorker;
  fetch?: typeof fetch;
  argonParams?: ArgonParams;
};

/**
 * The session as the extension builds it: `chrome.storage` underneath, Argon2id in a
 * Worker, everything else straight from `core/client`.
 *
 * Warming starts here rather than at first use, so the WASM module compiles while the
 * user is still typing (requirement 3).
 */
export function createExtensionSession(deps: ExtensionSessionDeps): Session {
  deps.worker.postMessage('warm');
  return createSession({
    baseUrl: deps.baseUrl,
    fetch: deps.fetch ?? globalThis.fetch,
    storage: extensionStorage(deps.area),
    deriveKey: workerKdf(deps.worker),
    ...(deps.argonParams === undefined ? {} : { argonParams: deps.argonParams }),
  });
}
