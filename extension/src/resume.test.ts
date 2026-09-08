import { afterEach, describe, expect, test } from 'bun:test';
import type { SessionSnapshot } from '../../core/client/session';
import {
  RESUME_IDLE_MS,
  RESUME_MAX_MS,
  clearResume,
  loadResume,
  saveResume,
  touchResume,
  updateResumeTokens,
  watchResume,
} from './resume';
import { memoryArea } from './storage';

const SNAPSHOT: SessionSnapshot = {
  vaultKey: 'A'.repeat(43),
  wrapKey: 'B'.repeat(43),
  accessToken: 'access',
  refreshToken: 'refresh',
  keyVersion: 1,
};

const T0 = 1_788_000_000_000;

describe('a resumable session', () => {
  test('is resumable straight after an unlock', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    const result = await loadResume(area, T0 + 1_000);
    expect(result.resumed).toBe(true);
    if (result.resumed) {
      expect(result.stored.username).toBe('shawn');
      expect(result.stored.snapshot.accessToken).toBe('access');
    }
  });

  test('an empty area is simply no session, not a failure', async () => {
    const result = await loadResume(memoryArea(), T0);
    expect(result).toEqual({ resumed: false, reason: 'none' });
  });

  test('a manual lock ends it', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    await clearResume(area);
    expect((await loadResume(area, T0)).resumed).toBe(false);
  });
});

describe('the two deadlines', () => {
  test('idle past the timeout ends the session', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    const result = await loadResume(area, T0 + RESUME_IDLE_MS);
    expect(result).toEqual({ resumed: false, reason: 'idle' });
  });

  test('activity pushes the idle deadline out', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    await touchResume(area, T0 + RESUME_IDLE_MS - 1_000);
    // Without the touch this instant would be past the idle limit.
    expect((await loadResume(area, T0 + RESUME_IDLE_MS + 1_000)).resumed).toBe(true);
  });

  /** The cap is the one a busy user cannot push out; that is what makes it a cap. */
  test('activity does not extend the 24-hour cap', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    for (let t = 30 * 60_000; t < RESUME_MAX_MS; t += 30 * 60_000) {
      await touchResume(area, T0 + t);
    }
    const result = await loadResume(area, T0 + RESUME_MAX_MS);
    expect(result).toEqual({ resumed: false, reason: 'expired' });
  });

  test('a refused session is cleared, not left to be refused again', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    await loadResume(area, T0 + RESUME_MAX_MS);
    // Second look finds nothing at all: the keys are no longer sitting in memory.
    expect(await loadResume(area, T0 + RESUME_MAX_MS)).toEqual({ resumed: false, reason: 'none' });
  });
});

describe('a snapshot that cannot be trusted is refused', () => {
  /**
   * A clock that moves backwards would put `unlockedAt` in the future, and both elapsed
   * checks would then read as "no time has passed" — an unlock that never expires.
   */
  test('timestamps in the wrong order are malformed, not a fresh session', async () => {
    const area = memoryArea();
    await area.set({
      'cypherkey.session.resume': {
        snapshot: SNAPSHOT,
        username: 'shawn',
        unlockedAt: T0 + 60_000,
        lastActiveAt: T0,
      },
    });
    expect(await loadResume(area, T0)).toEqual({ resumed: false, reason: 'malformed' });
  });

  test('a snapshot missing its keys is refused', async () => {
    const area = memoryArea();
    await area.set({
      'cypherkey.session.resume': {
        snapshot: { accessToken: 'a', refreshToken: 'r', keyVersion: 1 },
        username: 'shawn',
        unlockedAt: T0,
        lastActiveAt: T0,
      },
    });
    expect(await loadResume(area, T0)).toEqual({ resumed: false, reason: 'malformed' });
  });

  test('non-numeric timestamps are refused', async () => {
    const area = memoryArea();
    await area.set({
      'cypherkey.session.resume': {
        snapshot: SNAPSHOT,
        username: 'shawn',
        unlockedAt: 'now',
        lastActiveAt: T0,
      },
    });
    expect(await loadResume(area, T0)).toEqual({ resumed: false, reason: 'malformed' });
  });
});

/**
 * The rule this module exists to keep. A-7 permits five things on disk and none of them
 * is a live key: a vault key in `storage.local` means a stolen laptop opens the vault
 * with no passphrase and no rhythm.
 */
describe('the snapshot never goes near disk', () => {
  test('the module reaches for storage.session and nothing else', async () => {
    const raw = await Bun.file(`${import.meta.dir}/resume.ts`).text();
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('storage?.session');
    expect(code).not.toContain('storage.local');
    expect(code).not.toContain('localArea');
  });
});

describe('rotated tokens (A-9)', () => {
  test('replace the pair in the snapshot without moving the hard cap', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);

    await updateResumeTokens(area, { accessToken: 'a2', refreshToken: 'r2' }, T0 + 60_000);

    const result = await loadResume(area, T0 + 60_000);
    expect(result.resumed).toBe(true);
    if (result.resumed) {
      expect(result.stored.snapshot.accessToken).toBe('a2');
      expect(result.stored.snapshot.refreshToken).toBe('r2');
      // Everything else about the snapshot survives, keys included.
      expect(result.stored.snapshot.vaultKey).toBe(SNAPSHOT.vaultKey);
      expect(result.stored.unlockedAt).toBe(T0);
      expect(result.stored.lastActiveAt).toBe(T0 + 60_000);
    }
  });

  /**
   * A refresh cannot resurrect a session that has already ended, and writing one back
   * would be how a cleared snapshot came back to life.
   */
  test('write nothing when there is no session to write to', async () => {
    const area = memoryArea();

    await updateResumeTokens(area, { accessToken: 'a2', refreshToken: 'r2' }, T0);

    expect(await loadResume(area, T0)).toEqual({ resumed: false, reason: 'none' });
  });

  test('a refreshed session still expires on its original schedule', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);

    await updateResumeTokens(
      area,
      { accessToken: 'a2', refreshToken: 'r2' },
      T0 + RESUME_MAX_MS - 1,
    );

    const result = await loadResume(area, T0 + RESUME_MAX_MS);
    expect(result).toEqual({ resumed: false, reason: 'expired' });
  });
});

describe('watching for a session appearing or going away', () => {
  type Handler = (changes: Record<string, unknown>, area?: string) => void;

  /** Stands in for `chrome.storage`, with both places an onChanged event can live. */
  function fakeChrome(options: { scoped: boolean }) {
    const handlers = new Set<Handler>();
    const event = {
      addListener: (fn: Handler) => void handlers.add(fn),
      removeListener: (fn: Handler) => void handlers.delete(fn),
    };
    const storage = options.scoped
      ? { session: { onChanged: event } }
      : { session: {}, onChanged: event };
    (globalThis as { chrome?: unknown }).chrome = { storage };
    return {
      handlers,
      fire: (changes: Record<string, unknown>, area?: string) => {
        for (const fn of handlers) fn(changes, area);
      },
    };
  }

  afterEach(() => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
  });

  test('a change to the snapshot calls back', async () => {
    const chrome = fakeChrome({ scoped: true });
    let fired = 0;
    const off = watchResume(() => {
      fired += 1;
    });

    chrome.fire({ 'cypherkey.session.resume': { newValue: {} } });

    expect(fired).toBe(1);
    off();
    expect(chrome.handlers.size).toBe(0);
  });

  test('a change to something else does not', async () => {
    const chrome = fakeChrome({ scoped: true });
    let fired = 0;
    watchResume(() => {
      fired += 1;
    });

    chrome.fire({ 'cypherkey.user.name': { newValue: 'shawn' } });

    expect(fired).toBe(0);
  });

  /**
   * The fallback path. `storage.onChanged` fires for every area, and `storage.local`
   * holds the device key and the salt: a listener that did not filter would wake the
   * options page on writes that say nothing about a session.
   */
  test('on the global event, only the session area counts', async () => {
    const chrome = fakeChrome({ scoped: false });
    const seen: string[] = [];
    watchResume(() => seen.push('fired'));

    chrome.fire({ 'cypherkey.session.resume': { newValue: {} } }, 'local');
    expect(seen).toHaveLength(0);

    chrome.fire({ 'cypherkey.session.resume': { newValue: {} } }, 'session');
    expect(seen).toHaveLength(1);
  });

  /** Outside the extension there is nothing to watch, and that is not a failure. */
  test('with no chrome at all it returns a no-op', () => {
    (globalThis as { chrome?: unknown }).chrome = undefined;
    expect(() => watchResume(() => {})()).not.toThrow();
  });
});
