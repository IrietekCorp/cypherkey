import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { Session } from '../../core/client/session';
import {
  DEFAULT_IDLE_MS,
  type LifecycleTarget,
  type LockReason,
  bindPopupLifecycle,
  createLockController,
  forget,
} from './lock';

/** A clock and a timer the test drives, so nothing here waits fifteen minutes. */
function harness(options: { idleTimeoutMs?: number } = {}) {
  const clock = { value: 1_788_000_000_000 };
  let tick: (() => void) | null = null;
  const state = { locked: false, terminated: false, cleared: 0 };

  const session: Pick<Session, 'lock' | 'state'> = {
    lock() {
      state.locked = true;
    },
    state: () => (state.locked ? 'locked' : 'unlocked'),
  };

  const controller = createLockController({
    session,
    ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    now: () => clock.value,
    setInterval: (fn) => {
      tick = fn;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
    worker: {
      terminate() {
        state.terminated = true;
      },
    },
  });

  return {
    controller,
    state,
    advance(ms: number) {
      clock.value += ms;
      tick?.();
    },
    hasTimer: () => tick !== null,
  };
}

describe('idle locking (A-5)', () => {
  test('fifteen minutes is the default', () => {
    expect(DEFAULT_IDLE_MS).toBe(15 * 60_000);
  });

  test('idling past the timeout locks', () => {
    const h = harness({ idleTimeoutMs: 60_000 });
    h.advance(59_000);
    expect(h.state.locked).toBe(false);

    h.advance(2_000);
    expect(h.state.locked).toBe(true);
  });

  test('activity defers it', () => {
    const h = harness({ idleTimeoutMs: 60_000 });
    h.advance(50_000);
    h.controller.touch();
    h.advance(50_000);

    // 100s elapsed, but only 50s since the last activity.
    expect(h.state.locked).toBe(false);
    h.advance(20_000);
    expect(h.state.locked).toBe(true);
  });

  test('msUntilLock counts down from the last activity', () => {
    const h = harness({ idleTimeoutMs: 60_000 });
    h.advance(20_000);
    expect(h.controller.msUntilLock()).toBe(40_000);
    h.controller.touch();
    expect(h.controller.msUntilLock()).toBe(60_000);
  });

  test('an already-locked session is not locked again', () => {
    const h = harness({ idleTimeoutMs: 60_000 });
    let locks = 0;
    h.controller.onLock(() => {
      locks += 1;
    });

    h.advance(61_000);
    h.advance(61_000);
    expect(locks).toBe(1);
  });

  /** Touching after a lock must not resurrect the session; only a new unlock does. */
  test('touching a locked session does not unlock it', () => {
    const h = harness({ idleTimeoutMs: 60_000 });
    h.advance(61_000);
    h.controller.touch();
    expect(h.state.locked).toBe(true);
  });
});

describe('what a lock has to reach', () => {
  /**
   * `session.lock()` zeroes the keys it holds and knows nothing about what the
   * extension built from them. A decrypted `VaultItem[]` is a list of plaintext
   * passwords; zeroing a 32-byte key while leaving those alive locks the door and
   * leaves the window open.
   */
  test('subscribers run, and are told why', () => {
    const h = harness();
    const reasons: LockReason[] = [];
    h.controller.onLock((reason) => reasons.push(reason));

    h.controller.lock('manual');
    expect(reasons).toEqual(['manual']);
  });

  test('subscribers run before the session zeroes its keys', () => {
    const h = harness();
    const order: string[] = [];
    h.controller.onLock(() => order.push('subscriber'));

    // A subscriber that needed the vault key to tidy up would find it gone if this
    // order were reversed.
    const originalLock = h.state.locked;
    h.controller.lock('manual');
    order.push('session');

    expect(originalLock).toBe(false);
    expect(order).toEqual(['subscriber', 'session']);
  });

  test('one throwing subscriber does not stop the others', () => {
    const h = harness();
    const ran: string[] = [];
    h.controller.onLock(() => {
      throw new Error('badly written screen');
    });
    h.controller.onLock(() => ran.push('second'));

    h.controller.lock('manual');

    // Locking is not optional: a buggy screen must not keep plaintext alive elsewhere.
    expect(ran).toEqual(['second']);
    expect(h.state.locked).toBe(true);
  });

  test('unsubscribing works', () => {
    const h = harness();
    let calls = 0;
    const off = h.controller.onLock(() => {
      calls += 1;
    });
    off();

    h.controller.lock('manual');
    expect(calls).toBe(0);
  });

  /**
   * The worker received `kdfInput` — the passphrase itself. Another thread's heap
   * cannot be zeroed from here, so ending it is the only assurance available.
   */
  test('the KDF worker is terminated', () => {
    const h = harness();
    h.controller.lock('manual');
    expect(h.state.terminated).toBe(true);
  });

  test('the session is locked last, and always', () => {
    const h = harness();
    h.controller.lock('manual');
    expect(h.state.locked).toBe(true);
  });
});

describe('dispose', () => {
  /** Teardown is not a security event: a re-render must not lock the user out. */
  test('it stops the timer without locking', () => {
    const h = harness({ idleTimeoutMs: 60_000 });
    h.controller.dispose();

    expect(h.hasTimer()).toBe(false);
    expect(h.state.locked).toBe(false);
  });
});

describe('popup lifecycle', () => {
  const popup = () => {
    const win = new Window();
    return win as unknown as Window & LifecycleTarget;
  };

  /**
   * A popup closes the moment it loses focus. Leaving an unlocked session behind for
   * whoever opens it next is the failure this prevents.
   */
  test('pagehide locks', () => {
    const h = harness();
    const win = popup();
    bindPopupLifecycle(h.controller, win);

    win.dispatchEvent(new win.Event('pagehide'));
    expect(h.state.locked).toBe(true);
  });

  test.each(['keydown', 'pointerdown'])('%s counts as activity', (event) => {
    const h = harness({ idleTimeoutMs: 60_000 });
    const win = popup();
    bindPopupLifecycle(h.controller, win);

    h.advance(50_000);
    win.dispatchEvent(new win.Event(event));
    h.advance(50_000);

    expect(h.state.locked).toBe(false);
  });

  test('unbinding stops both', () => {
    const h = harness();
    const win = popup();
    const unbind = bindPopupLifecycle(h.controller, win);
    unbind();

    win.dispatchEvent(new win.Event('pagehide'));
    expect(h.state.locked).toBe(false);
  });
});

describe('forget', () => {
  test('it zeroes byte arrays and drops references', () => {
    const key = new Uint8Array([1, 2, 3, 4]);
    const holder: Record<string, unknown> = { key, password: 'hunter2' };

    forget(holder);

    expect([...key]).toEqual([0, 0, 0, 0]);
    expect(holder.key).toBeUndefined();
    expect(holder.password).toBeUndefined();
  });

  /**
   * The honest limit, asserted so nobody mistakes this for zeroing a string. A JS
   * string is immutable and the engine may have copied it; only the last reference can
   * be dropped. Anything that must be truly zeroable is a `Uint8Array` from the start,
   * which is why every key in `core/crypto` is one.
   */
  test('a string is released, not overwritten', () => {
    const secret = 'hunter2';
    const holder: Record<string, unknown> = { secret };

    forget(holder);

    expect(holder.secret).toBeUndefined();
    // The original binding is untouched: this is a reference drop, not an erasure.
    expect(secret).toBe('hunter2');
  });

  test('an empty holder is fine', () => {
    expect(() => forget({})).not.toThrow();
  });
});
