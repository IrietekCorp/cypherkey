/**
 * The Argon2id step, off the popup's main thread.
 *
 * Requirement 2 of M2-01: a ~175 ms hash on the main thread janks the unlock screen and
 * stalls the Rhythm Light's per-keystroke pulse. The light is the consent signal (X-1),
 * so it stuttering is not a cosmetic problem — it is the UI lying about whether capture
 * is live.
 *
 * The module is `hash-wasm`, the same implementation the server and the tests use, so
 * a vector that passes in Bun is evidence about the browser (A-2, A-15).
 */
import { type ArgonParams, deriveMasterKey } from '../../core/crypto/kdf';

export type KdfRequest = {
  id: number;
  kdfInput: Uint8Array;
  salt: Uint8Array;
  params?: ArgonParams;
};

export type KdfResponse =
  | { id: number; ok: true; key: Uint8Array }
  | { id: number; ok: false; error: string };

/**
 * The whole of the worker's logic, exported so it can be tested without a Worker.
 *
 * Errors are returned rather than thrown, and carry only the message `deriveMasterKey`
 * produced — which names the offending argument and never its contents.
 */
export async function handleKdfRequest(request: KdfRequest): Promise<KdfResponse> {
  try {
    const key = await deriveMasterKey(request.kdfInput, request.salt, request.params);
    return { id: request.id, ok: true, key };
  } catch (err) {
    return { id: request.id, ok: false, error: (err as Error).message };
  }
}

/**
 * Warms the WASM module. Requirement 3: fetch and compile when the popup opens, in
 * parallel with passphrase entry, so the cost at submit is the hash alone. The module
 * is 11.6 KB gzipped; compiling it during typing is free wall-clock time.
 *
 * A trivial hash is the only portable way to force instantiation.
 */
export async function warmUp(): Promise<void> {
  await deriveMasterKey(new Uint8Array([0]), new Uint8Array(16), { m: 8, t: 1, p: 1 });
}

// Worker entry. Guarded so importing this module in a test does not register a handler.
declare const self: { onmessage?: (event: MessageEvent<KdfRequest | 'warm'>) => void } & {
  postMessage(value: unknown): void;
};

if (
  typeof self !== 'undefined' &&
  typeof (self as { postMessage?: unknown }).postMessage === 'function'
) {
  self.onmessage = async (event) => {
    if (event.data === 'warm') {
      await warmUp();
      self.postMessage({ warmed: true });
      return;
    }
    self.postMessage(await handleKdfRequest(event.data));
  };
}
