import { describe, expect, test } from 'bun:test';
import type { AuthedRequest, Session } from '../../core/client/session';
import { refreshingRequest } from './authed';
import { loadResume, saveResume } from './resume';
import { memoryArea } from './storage';

const SNAPSHOT = {
  vaultKey: 'A'.repeat(43),
  wrapKey: 'B'.repeat(43),
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  keyVersion: 1,
};

const T0 = 1_788_000_000_000;

type Call = { path: string; token?: string | undefined };

/**
 * A session whose access token expires, exactly as A-8 says it does.
 *
 * `authed()` answers 401 for any token that is not the current one, which is what an
 * expired token looks like from the client. `refresh()` rotates the pair (A-9).
 */
function expiringSession(options: { refreshes?: boolean } = {}) {
  const calls: Call[] = [];
  let tokens = { accessToken: 'access-1', refreshToken: 'refresh-1' };
  let generation = 1;

  const session: Pick<Session, 'authed' | 'tokens' | 'refresh'> = {
    authed(): AuthedRequest {
      return async (_method, path, _body, token) => {
        calls.push({ path, token });
        return token === tokens.accessToken
          ? { status: 200, body: { ok: true } }
          : { status: 401, body: { error: 'unauthorized' } };
      };
    },
    tokens: () => tokens,
    async refresh() {
      if (options.refreshes === false) return false;
      generation += 1;
      tokens = { accessToken: `access-${generation}`, refreshToken: `refresh-${generation}` };
      return true;
    },
  };

  return { session, calls, current: () => tokens };
}

describe('an authenticated request that renews its own token', () => {
  test('a live token is used as it is, with no refresh', async () => {
    const { session, calls } = expiringSession();
    const request = refreshingRequest({ session, memory: null, now: () => T0 });

    const result = await request('GET', '/user/settings');

    expect(result.status).toBe(200);
    expect(calls).toHaveLength(1);
  });

  /**
   * The bug this exists for: access tokens last fifteen minutes and sessions last an
   * hour, so every session outlives its token. Before this, everything authenticated
   * simply stopped working partway through and the vault fell back to "offline".
   */
  test('an expired token is refreshed once and the request retried', async () => {
    const { session, calls } = expiringSession();
    const request = refreshingRequest({ session, memory: null, now: () => T0 });

    const result = await request('GET', '/user/settings', undefined, 'access-stale');

    expect(result.status).toBe(200);
    expect(calls.map((c) => c.token)).toEqual(['access-stale', 'access-2']);
  });

  test('a refusal to refresh is reported as the 401 it was, and once', async () => {
    const { session, calls } = expiringSession({ refreshes: false });
    let lost = 0;
    const request = refreshingRequest({
      session,
      memory: null,
      now: () => T0,
      onLost: () => {
        lost += 1;
      },
    });

    const result = await request('GET', '/user/settings', undefined, 'access-stale');

    expect(result.status).toBe(401);
    expect(lost).toBe(1);
    // A revoked session must not become a loop against the server.
    expect(calls).toHaveLength(1);
  });

  /**
   * A-9 retires the refresh token that was spent. Two documents read one snapshot, so a
   * rotation kept only in this document leaves the other holding a dead token, and
   * spending a spent one revokes the whole family: the user is signed out for being
   * careful.
   */
  test('the rotated pair is written back into the shared snapshot', async () => {
    const area = memoryArea();
    await saveResume(area, SNAPSHOT, 'shawn', T0);
    const { session } = expiringSession();
    const request = refreshingRequest({ session, memory: area, now: () => T0 + 60_000 });

    await request('GET', '/user/settings', undefined, 'access-stale');

    const found = await loadResume(area, T0 + 60_000);
    expect(found.resumed).toBe(true);
    if (found.resumed) {
      expect(found.stored.snapshot.accessToken).toBe('access-2');
      expect(found.stored.snapshot.refreshToken).toBe('refresh-2');
      // Refreshing a token is not re-proving a passphrase, so the hard cap does not move.
      expect(found.stored.unlockedAt).toBe(T0);
      expect(found.stored.lastActiveAt).toBe(T0 + 60_000);
    }
  });

  test('a caller holding the token in state is told the new one', async () => {
    const { session } = expiringSession();
    const seen: string[] = [];
    const request = refreshingRequest({
      session,
      memory: null,
      now: () => T0,
      onTokens: (token) => seen.push(token),
    });

    await request('GET', '/user/settings', undefined, 'access-stale');

    expect(seen).toEqual(['access-2']);
  });

  test('with no token supplied it reaches for the live one', async () => {
    const { session, calls } = expiringSession();
    const request = refreshingRequest({ session, memory: null, now: () => T0 });

    await request('GET', '/user/settings');

    expect(calls[0]?.token).toBe('access-1');
  });
});
