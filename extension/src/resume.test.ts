import { describe, expect, test } from 'bun:test';
import type { SessionSnapshot } from '../../core/client/session';
import {
  RESUME_IDLE_MS,
  RESUME_MAX_MS,
  clearResume,
  loadResume,
  saveResume,
  touchResume,
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
