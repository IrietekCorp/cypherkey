import type { AuthedRequest, Session } from '../../core/client/session';
import { updateResumeTokens } from './resume';
import type { StorageArea } from './storage';

/**
 * An authenticated request that renews its own access token.
 *
 * **The bug this exists for.** Access tokens last fifteen minutes (A-8). A resumable
 * session lasts an hour of idle and up to a day (M2-18). `session.refresh()` was written
 * and tested in M1 and then called from nowhere — so every session in the product went
 * dead fifteen minutes in: sync stopped pushing, the vault fell back to "offline", and
 * the settings screen would have sat on "Loading…" forever. Nothing caught it because
 * every test issues a token and spends it in the same millisecond.
 *
 * **Why the retry is exactly one.** A 401 has two causes worth distinguishing: an
 * expired access token, which a refresh fixes, and a revoked or wrong session, which it
 * cannot. One attempt separates them. Retrying further would turn a revoked device into
 * a loop against the server.
 *
 * **Why the rotated pair is written back.** A-9 retires the refresh token that was
 * spent. The popup and the options page read the same snapshot, so a rotation held only
 * in this document's memory leaves the other one holding a spent token — and spending a
 * spent one revokes the whole family. `updateResumeTokens` closes that window as
 * narrowly as it can be closed.
 */
export type RefreshingDeps = {
  session: Pick<Session, 'authed' | 'tokens' | 'refresh'>;
  /** `chrome.storage.session`, or null where there is none. Never `storage.local`. */
  memory: StorageArea | null;
  now?: () => number;
  /** The new access token, for a caller holding it in state. */
  onTokens?: (accessToken: string) => void;
  /** The refresh was refused: this session is over and only an unlock revives it. */
  onLost?: () => void;
};

export function refreshingRequest(deps: RefreshingDeps): AuthedRequest {
  const now = deps.now ?? Date.now;
  const live = () => deps.session.tokens()?.accessToken;

  return async (method, path, body, token) => {
    const base = deps.session.authed();
    const first = await base(method, path, body, token ?? live());
    if (first.status !== 401) return first;

    if (!(await deps.session.refresh())) {
      deps.onLost?.();
      // The original 401, not a synthesised one. The caller asked what the server said.
      return first;
    }

    const renewed = deps.session.tokens();
    if (renewed !== null) {
      if (deps.memory !== null) await updateResumeTokens(deps.memory, renewed, now());
      deps.onTokens?.(renewed.accessToken);
    }
    // A fresh `authed()`: the device key is unwrapped per call, so nothing is stale here
    // except the token, which `live()` now reads as the new one.
    return deps.session.authed()(method, path, body, live());
  };
}
