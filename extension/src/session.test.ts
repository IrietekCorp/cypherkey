import { describe, expect, test } from 'bun:test';
import { deriveMasterKey } from '../../core/crypto/kdf';
import { handleKdfRequest } from './kdf-worker';
import { type KdfWorker, createExtensionSession, workerKdf } from './session';
import { memoryArea } from './storage';

const FAST = { m: 256, t: 1, p: 1 } as const;
const SALT = new Uint8Array(16).fill(7);
const INPUT = new TextEncoder().encode('correct horse battery staple');

/** A Worker double that runs the real handler, optionally replying out of order. */
function fakeWorker(options: { reverse?: boolean } = {}) {
  const listeners: Array<(event: MessageEvent) => void> = [];
  const seen: Array<KdfRequestLike | 'warm'> = [];
  const queued: unknown[] = [];

  const emit = (data: unknown) => {
    for (const l of listeners) l({ data } as MessageEvent);
  };

  const worker: KdfWorker = {
    postMessage(value) {
      seen.push(value as KdfRequestLike | 'warm');
      if (value === 'warm') {
        emit({ warmed: true });
        return;
      }
      void handleKdfRequest(value as Parameters<typeof handleKdfRequest>[0]).then((r) => {
        if (options.reverse === true) {
          queued.push(r);
          // Replies land in reverse, so anything relying on arrival order breaks.
          if (queued.length === 2) for (const q of queued.reverse()) emit(q);
        } else {
          emit(r);
        }
      });
    },
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
  };
  return { worker, seen };
}

type KdfRequestLike = { id: number; kdfInput: Uint8Array; salt: Uint8Array };

describe('workerKdf', () => {
  test('produces the same key as calling deriveMasterKey directly', async () => {
    const { worker } = fakeWorker();
    const viaWorker = await workerKdf(worker)(INPUT, SALT, FAST);
    expect(viaWorker).toEqual(await deriveMasterKey(INPUT, SALT, FAST));
  });

  /**
   * Two derivations can be in flight at once — an unlock racing a background refresh.
   * Correlating by arrival order would hand one caller the other's key, which is a
   * silent wrong-key bug rather than a visible failure.
   */
  test('concurrent requests resolve to their own key even when replies arrive out of order', async () => {
    const { worker } = fakeWorker({ reverse: true });
    const kdf = workerKdf(worker);
    const otherSalt = new Uint8Array(16).fill(9);

    const [a, b] = await Promise.all([kdf(INPUT, SALT, FAST), kdf(INPUT, otherSalt, FAST)]);

    expect(a).toEqual(await deriveMasterKey(INPUT, SALT, FAST));
    expect(b).toEqual(await deriveMasterKey(INPUT, otherSalt, FAST));
    expect(a).not.toEqual(b);
  });

  test('an error from the worker rejects with its message', async () => {
    const { worker } = fakeWorker();
    expect(workerKdf(worker)(new Uint8Array(0), SALT, FAST)).rejects.toThrow('kdfInput');
  });
});

describe('createExtensionSession', () => {
  test('warms the WASM module as soon as it is created', () => {
    const { worker, seen } = fakeWorker();
    createExtensionSession({ baseUrl: 'https://api.test', area: memoryArea(), worker });
    // Requirement 3: compile during typing, so submit pays for the hash alone.
    expect(seen[0]).toBe('warm');
  });

  /**
   * `fetch` is a method of the global object, and a browser enforces its receiver:
   * pulled off `globalThis` and passed on as a bare function, it throws
   *   TypeError: Failed to execute 'fetch' on 'Window': Illegal invocation
   * on the first real request. Bun and Node do not enforce it, so the detached
   * reference passed every test and failed on the first live signup.
   *
   * This substitutes a global that *does* enforce the receiver, which is what a browser
   * does, so the binding is checked here rather than by a person clicking Sign up.
   */
  test('the default fetch is bound to the global, not passed by reference', async () => {
    const realFetch = globalThis.fetch;
    let calledWithThis: unknown = 'never called';
    const strict = function (this: unknown) {
      calledWithThis = this;
      if (this !== globalThis) {
        throw new TypeError("Failed to execute 'fetch' on 'Window': Illegal invocation");
      }
      return Promise.resolve(new Response('{}', { status: 200 }));
    };
    (globalThis as { fetch: unknown }).fetch = strict;

    try {
      const { worker } = fakeWorker();
      const session = createExtensionSession({
        baseUrl: 'https://api.test',
        area: memoryArea(),
        worker,
        argonParams: FAST,
      });
      // Any call that reaches the network is enough; it must not throw on the receiver.
      await session
        .login({
          username: 'someone',
          resolved: 'x',
          script: 'x',
          strictness: 'medium',
          featureVector: [1, 2, 3],
        })
        .catch(() => {});
      expect(calledWithThis).toBe(globalThis);
    } finally {
      (globalThis as { fetch: unknown }).fetch = realFetch;
    }
  });

  test('routes the session KDF through the worker', async () => {
    const { worker, seen } = fakeWorker();
    const area = memoryArea();
    const session = createExtensionSession({
      baseUrl: 'https://api.test',
      area,
      worker,
      argonParams: FAST,
      fetch: (async () =>
        new Response(JSON.stringify({ error: 'not_found' }), {
          status: 404,
          headers: { 'content-type': 'application/json' },
        })) as unknown as typeof fetch,
    });

    await session
      .signup({
        username: 'shawn',
        email: 'shawn@example.test',
        resolved: 'correct horse battery staple',
        script: 'correct horse battery staple',
        strictness: 'medium',
        consentPolicyVersion: '2026-09-01',
        deviceName: 'Chrome',
        devicePlatform: 'linux',
      })
      .catch(() => undefined);

    // The signup failed at the network, but the derivation went through the worker.
    expect(seen.filter((m) => m !== 'warm')).toHaveLength(1);
  });

  test('starts locked', () => {
    const { worker } = fakeWorker();
    const session = createExtensionSession({
      baseUrl: 'https://api.test',
      area: memoryArea(),
      worker,
    });
    expect(session.state()).toBe('locked');
  });
});
