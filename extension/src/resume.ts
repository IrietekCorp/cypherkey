/**
 * Staying unlocked between popup opens, and the two deadlines that bound it.
 *
 * The popup is destroyed every time it closes, so before this the vault key died with
 * it and the next open meant another Argon2id derivation and another rhythm sample. That
 * is correct and unusable: a manager nobody keeps unlocked is a manager people stop
 * putting passwords into, and M2's exit criterion is that the founder uses it daily.
 *
 * The snapshot lives in `chrome.storage.session`, which the browser keeps in memory and
 * wipes on shutdown. **Never `storage.local`.** A-7 permits five things on disk and none
 * is a live key; a vault key written to disk means a stolen laptop opens the vault with
 * no passphrase and no rhythm, which is the threat the whole product is built against.
 * Closing Chrome is therefore a real lock, and that is a feature.
 *
 * Two deadlines, whichever comes first:
 *   - a hard cap from the moment of unlock, so a session cannot live forever, and
 *   - an idle timeout, so walking away from an unlocked machine ends it.
 *
 * Both are stored beside the keys rather than kept in the popup, because the popup dies
 * constantly and a deadline it forgets is not a deadline.
 */
import type { SessionSnapshot } from '../../core/client/session';
import type { StorageArea } from './storage';

/** Where the snapshot lives. Session storage only; see the note above. */
const RESUME_KEY = 'cypherkey.session.resume';

/** A-5 is 15 minutes of idle; a resumable session widens it to an hour, deliberately. */
export const RESUME_IDLE_MS = 60 * 60_000;

/** The hard ceiling, however active the user has been. */
export const RESUME_MAX_MS = 24 * 60 * 60_000;

export type StoredResume = {
  snapshot: SessionSnapshot;
  username: string;
  /** When the passphrase and rhythm were actually checked. */
  unlockedAt: number;
  /** Last sign of life, for the idle deadline. */
  lastActiveAt: number;
};

/** Why a stored session was not resumable, for a caller that wants to say so. */
export type ResumeRefusal = 'none' | 'expired' | 'idle' | 'malformed';

export type ResumeResult =
  | { resumed: true; stored: StoredResume }
  | { resumed: false; reason: ResumeRefusal };

/**
 * The session-storage area, or null where there is none.
 *
 * Separate from `localArea()` on purpose: mixing them is how a key ends up on disk. A
 * caller that cannot get this one must ask for the passphrase, never fall back to local.
 */
export function sessionArea(): StorageArea | null {
  const chrome = (globalThis as { chrome?: { storage?: { session?: unknown } } }).chrome;
  const session = chrome?.storage?.session;
  return session === undefined || session === null ? null : (session as StorageArea);
}

/** Records an unlock, starting both clocks. */
export async function saveResume(
  area: StorageArea,
  snapshot: SessionSnapshot,
  username: string,
  now: number,
): Promise<void> {
  const stored: StoredResume = { snapshot, username, unlockedAt: now, lastActiveAt: now };
  await area.set({ [RESUME_KEY]: stored });
}

/** Pushes the idle deadline out. Does not extend the hard cap, which is the point of it. */
export async function touchResume(area: StorageArea, now: number): Promise<void> {
  const stored = await readStored(area);
  if (stored === null) return;
  await area.set({ [RESUME_KEY]: { ...stored, lastActiveAt: now } });
}

/**
 * Writes a rotated token pair into the stored snapshot.
 *
 * Access tokens live fifteen minutes (A-8) and a resumable session lives an hour, so
 * every session outlives its own access token. `session.refresh()` exchanges the pair —
 * and A-9 *rotates* the refresh token, retiring the one that was spent. A rotated pair
 * that is not written back here leaves a snapshot holding a spent refresh token, and
 * the next document to use it revokes the whole family: the user is signed out for
 * being careful.
 *
 * `unlockedAt` is deliberately untouched. Refreshing a token is not re-proving a
 * passphrase, and a session that could push its hard cap out by refreshing would have
 * no cap at all.
 */
export async function updateResumeTokens(
  area: StorageArea,
  tokens: { accessToken: string; refreshToken: string },
  now: number,
): Promise<void> {
  const stored = await readStored(area);
  if (stored === null) return;
  await area.set({
    [RESUME_KEY]: {
      ...stored,
      snapshot: { ...stored.snapshot, ...tokens },
      lastActiveAt: now,
    },
  });
}

/**
 * Calls back whenever the snapshot changes, for a second document that is watching.
 *
 * The options page is the reason. It is a full tab and outlives any number of popups,
 * so "there is no session yet" is a state it can sit in while the user goes and unlocks
 * in the popup. Without this it would keep saying so until reloaded; with it the page
 * comes alive by itself, which is what someone who just unlocked expects.
 *
 * Returns a no-op unsubscribe where there is nothing to watch, so a caller outside the
 * extension does not have to know the difference.
 */
export function watchResume(listener: () => void): () => void {
  type Changes = Record<string, unknown>;
  type Event = {
    addListener(fn: (changes: Changes, area?: string) => void): void;
    removeListener(fn: (changes: Changes, area?: string) => void): void;
  };
  const storage = (
    globalThis as {
      chrome?: { storage?: { session?: { onChanged?: Event }; onChanged?: Event } };
    }
  ).chrome?.storage;

  // `chrome.storage.session.onChanged` is the narrow one and is preferred; the global
  // `storage.onChanged` fires for every area, so it is filtered by name. Either way a
  // change to some other key is not this page's business.
  const scoped = storage?.session?.onChanged;
  const target = scoped ?? storage?.onChanged;
  if (target === undefined) return () => {};

  const handler = (changes: Changes, area?: string) => {
    if (scoped === undefined && area !== 'session') return;
    if (!(RESUME_KEY in changes)) return;
    listener();
  };
  target.addListener(handler);
  return () => target.removeListener(handler);
}

/** Drops the snapshot. See `SessionSnapshot`: this removes a reference, it does not erase bytes. */
export async function clearResume(area: StorageArea): Promise<void> {
  await area.remove(RESUME_KEY);
}

/**
 * What a popup should do on open.
 *
 * Anything not resumable is cleared on the way out, so a refused snapshot cannot sit in
 * memory being refused for the rest of the browser session.
 */
export async function loadResume(area: StorageArea, now: number): Promise<ResumeResult> {
  const stored = await readStored(area);
  if (stored === null) return { resumed: false, reason: 'none' };

  if (!isWellFormed(stored)) {
    await clearResume(area);
    return { resumed: false, reason: 'malformed' };
  }
  // The hard cap first: it is the one the user cannot push out by being busy.
  if (now - stored.unlockedAt >= RESUME_MAX_MS) {
    await clearResume(area);
    return { resumed: false, reason: 'expired' };
  }
  if (now - stored.lastActiveAt >= RESUME_IDLE_MS) {
    await clearResume(area);
    return { resumed: false, reason: 'idle' };
  }
  return { resumed: true, stored };
}

async function readStored(area: StorageArea): Promise<StoredResume | null> {
  try {
    const found = await area.get(RESUME_KEY);
    const value = found[RESUME_KEY];
    return value === undefined || value === null ? null : (value as StoredResume);
  } catch {
    // Unreadable session storage means no resumable session, which is the safe answer.
    return null;
  }
}

/**
 * Shape check before anything is trusted.
 *
 * A clock that moved backwards makes `unlockedAt` sit in the future, and the elapsed
 * checks above would then read as "no time has passed" — an unlock that never expires.
 * Treated as malformed rather than clamped, because a snapshot whose timestamps do not
 * make sense is one we cannot reason about.
 */
function isWellFormed(stored: StoredResume): boolean {
  const { snapshot, unlockedAt, lastActiveAt } = stored;
  if (typeof unlockedAt !== 'number' || typeof lastActiveAt !== 'number') return false;
  if (!Number.isFinite(unlockedAt) || !Number.isFinite(lastActiveAt)) return false;
  if (lastActiveAt < unlockedAt) return false;
  if (snapshot === null || typeof snapshot !== 'object') return false;
  return (
    typeof snapshot.vaultKey === 'string' &&
    typeof snapshot.wrapKey === 'string' &&
    typeof snapshot.accessToken === 'string' &&
    typeof snapshot.refreshToken === 'string'
  );
}
