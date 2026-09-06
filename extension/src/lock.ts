import type { Session } from '../../core/client/session';

/**
 * Locking, and what locking has to reach.
 *
 * `session.lock()` zeroes the keys the session holds — vault, wrap, phantom, the
 * provisional device key. It knows nothing about what the *extension* has built out of
 * them, and that is the part worth being careful about: a decrypted `VaultItem[]` in a
 * React state variable is a list of plaintext passwords. Zeroing a 32-byte key while
 * leaving those in memory locks the door and leaves the window open.
 *
 * So this owns the whole lock, not just the timer: subscribers clear what they hold,
 * the KDF worker is terminated, and only then does the session zero its keys.
 */

export const DEFAULT_IDLE_MS = 15 * 60_000;
/** How often the idle check runs. Finer than this buys nothing a user can perceive. */
const TICK_MS = 15_000;

export type LockDeps = {
  session: Pick<Session, 'lock' | 'state'>;
  /** A-5: fifteen minutes by default. */
  idleTimeoutMs?: number;
  now?: () => number;
  /** Injected so tests do not wait, and so a service worker can supply its own. */
  setInterval?: (fn: () => void, ms: number) => number;
  clearInterval?: (handle: number) => void;
  /**
   * The Argon2 worker. Terminated on lock: it received `kdfInput` — the passphrase —
   * and there is no way to zero another thread's heap from here. Ending it is the only
   * assurance available, and starting a new one costs a WASM compile the user is not
   * waiting on.
   */
  worker?: { terminate?(): void };
};

export type LockController = {
  /** Records activity. A-5's timeout is measured from the last one of these. */
  touch(): void;
  /** Locks now, running every subscriber before the session zeroes its keys. */
  lock(reason: LockReason): void;
  /** Registers something to clear. Returns an unsubscribe. */
  onLock(handler: (reason: LockReason) => void): () => void;
  /** Stops the timer. Does **not** lock — `dispose` is teardown, not a security event. */
  dispose(): void;
  msUntilLock(): number;
};

export type LockReason = 'idle' | 'popup-closed' | 'manual' | 'suspend';

export function createLockController(deps: LockDeps): LockController {
  const now = deps.now ?? Date.now;
  const idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_MS;
  const start =
    deps.setInterval ?? ((fn, ms) => globalThis.setInterval(fn, ms) as unknown as number);
  const stop = deps.clearInterval ?? ((handle) => globalThis.clearInterval(handle));

  const handlers = new Set<(reason: LockReason) => void>();
  let lastActivity = now();
  let locked = false;

  const lock = (reason: LockReason): void => {
    if (locked) return;
    locked = true;

    /**
     * Subscribers first, session last.
     *
     * A subscriber that needs the vault key to tidy up — re-encrypting a draft, say —
     * would find it already zeroed if the order were reversed. Nothing does that today;
     * the ordering exists so nothing has to think about it later.
     *
     * A throwing subscriber must not stop the others, or one buggy screen keeps
     * plaintext alive everywhere else.
     */
    for (const handler of handlers) {
      try {
        handler(reason);
      } catch {
        // Deliberately swallowed: locking is not optional.
      }
    }

    deps.worker?.terminate?.();
    deps.session.lock();
  };

  const handle = start(() => {
    if (deps.session.state() !== 'unlocked') return;
    if (now() - lastActivity >= idleTimeoutMs) lock('idle');
  }, TICK_MS);

  return {
    touch() {
      lastActivity = now();
      // Touching after a lock must not resurrect the session: only a new unlock does.
      if (deps.session.state() === 'unlocked') locked = false;
    },
    lock,
    onLock(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    dispose() {
      stop(handle);
    },
    msUntilLock() {
      return Math.max(0, idleTimeoutMs - (now() - lastActivity));
    },
  };
}

/**
 * Only the two methods `bindPopupLifecycle` needs, so a real `Window` and a test double
 * both satisfy it without either being cast. The event object is never read.
 */
export type LifecycleTarget = {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
};

/**
 * Wires the events a popup gets.
 *
 * `pagehide` rather than `unload`: it is the one that fires reliably when a popup is
 * dismissed, which is the common case — a popup closes the moment it loses focus, and
 * that must lock rather than leave an unlocked session behind for whoever opens it next.
 */
export function bindPopupLifecycle(
  controller: LockController,
  target: LifecycleTarget,
): () => void {
  const onHide = () => controller.lock('popup-closed');
  const onActivity = () => controller.touch();

  target.addEventListener('pagehide', onHide);
  for (const event of ['keydown', 'pointerdown', 'focus'] as const) {
    target.addEventListener(event, onActivity);
  }

  return () => {
    target.removeEventListener('pagehide', onHide);
    for (const event of ['keydown', 'pointerdown', 'focus'] as const) {
      target.removeEventListener(event, onActivity);
    }
  };
}

/**
 * Overwrites a string-bearing object in place, for the plaintext the extension holds.
 *
 * This is weaker than zeroing a `Uint8Array` and the difference is worth naming: a
 * JavaScript string is immutable and may have been copied by the engine, so the
 * original bytes cannot be reached to overwrite. What this does is drop the last
 * *reference* the extension holds, which is what makes the value collectable. Anything
 * that must be truly zeroable has to be a `Uint8Array` from the start — which is why
 * every key in `core/crypto` is one.
 */
export function forget<T extends Record<string, unknown>>(holder: T): void {
  for (const key of Object.keys(holder)) {
    const value = holder[key];
    if (value instanceof Uint8Array) value.fill(0);
    (holder as Record<string, unknown>)[key] = undefined;
  }
}
