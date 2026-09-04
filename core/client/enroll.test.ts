import { describe, expect, test } from 'bun:test';
import { createEnroller } from './enroll';
import type { AuthedRequest } from './session';

type Call = { method: string; path: string; body?: unknown; token?: string };

/**
 * Records what the enroller sends and replies with whatever the test queued. The real
 * device signing lives in `session.authed()`; this double stands in for it.
 */
function recorder(replies: Array<{ status: number; body: unknown }>) {
  const calls: Call[] = [];
  const request: AuthedRequest = async (method, path, body, token) => {
    calls.push({ method, path, body, token });
    const next = replies.shift();
    if (next === undefined) throw new Error(`unexpected call to ${path}`);
    return next;
  };
  return { calls, request };
}

const TOKEN = 'enroll-token-abc';

describe('createEnroller', () => {
  test('status reports progress and whether the profile is built', async () => {
    const { calls, request } = recorder([
      { status: 200, body: { required: 8, submitted: 3, remaining: 5, built: false } },
    ]);
    const enroller = createEnroller({ request, token: TOKEN });

    expect(await enroller.status()).toEqual({
      required: 8,
      submitted: 3,
      remaining: 5,
      built: false,
    });
    expect(calls[0]?.method).toBe('GET');
    expect(calls[0]?.path).toBe('/enroll/status');
  });

  test('every call carries the scope-enroll bearer token', async () => {
    const { calls, request } = recorder([
      { status: 200, body: { required: 8, submitted: 0, remaining: 8, built: false } },
      { status: 200, body: { samplesRemaining: 7 } },
      { status: 200, body: { built: true, scriptLen: 3, sampleCount: 8 } },
    ]);
    const enroller = createEnroller({ request, token: TOKEN });

    await enroller.status();
    await enroller.sample({ featureVector: [1, 2, 3], commitments: ['a', 'b', 'c'] });
    await enroller.build();

    // A-9: /enroll/* accepts only the enrollment scope, so a missing token is a 401
    // that would surface as an unexplained enrollment failure in the UI.
    expect(calls.map((c) => c.token)).toEqual([TOKEN, TOKEN, TOKEN]);
  });

  test('sample posts the vector and its commitments, and returns what remains', async () => {
    const { calls, request } = recorder([{ status: 200, body: { samplesRemaining: 5 } }]);
    const enroller = createEnroller({ request, token: TOKEN });

    const result = await enroller.sample({
      featureVector: [10, 20, 30],
      commitments: ['c0', 'c1', 'c2'],
    });

    expect(result).toEqual({ samplesRemaining: 5 });
    expect(calls[0]?.path).toBe('/enroll/sample');
    expect(calls[0]?.body).toEqual({
      featureVector: [10, 20, 30],
      commitments: ['c0', 'c1', 'c2'],
    });
  });

  test('build returns the script length and sample count the server settled on', async () => {
    const { calls, request } = recorder([
      { status: 200, body: { built: true, scriptLen: 12, sampleCount: 8 } },
    ]);
    const enroller = createEnroller({ request, token: TOKEN });

    expect(await enroller.build()).toEqual({ built: true, scriptLen: 12, sampleCount: 8 });
    expect(calls[0]?.method).toBe('POST');
    expect(calls[0]?.path).toBe('/enroll/build');
  });

  test('a rejection surfaces the server error rather than a bare status', async () => {
    const { request } = recorder([{ status: 400, body: { error: 'commitment_mismatch' } }]);
    const enroller = createEnroller({ request, token: TOKEN });

    // M1-18 made every enrollment rejection carry a reason; losing it here would put
    // the demo back to "enroll rejected malformed" with nothing to act on.
    expect(enroller.sample({ featureVector: [1], commitments: ['c0'] })).rejects.toThrow(
      'commitment_mismatch',
    );
  });

  test('build before the samples are in reports the server 409, not a crash', async () => {
    const { request } = recorder([{ status: 409, body: { error: 'insufficient_samples' } }]);
    const enroller = createEnroller({ request, token: TOKEN });
    expect(enroller.build()).rejects.toThrow('insufficient_samples');
  });

  /** Absence test: the enroller must never carry key material or a passphrase. */
  test('sends nothing but the vector and the commitments', async () => {
    const { calls, request } = recorder([{ status: 200, body: { samplesRemaining: 0 } }]);
    const enroller = createEnroller({ request, token: TOKEN });
    await enroller.sample({ featureVector: [1, 2, 3], commitments: ['a', 'b', 'c'] });

    const sent = JSON.stringify(calls[0]?.body);
    for (const forbidden of [
      'kdfInput',
      'authHash',
      'wrapKey',
      'phantomKey',
      'passphrase',
      'script',
    ]) {
      expect(sent).not.toContain(forbidden);
    }
    expect(Object.keys(calls[0]?.body as object).sort()).toEqual(['commitments', 'featureVector']);
  });
});
