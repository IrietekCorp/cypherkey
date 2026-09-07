import { describe, expect, test } from 'bun:test';
import { failureMessage } from './session';

/**
 * A real signup showed the user "signup failed with status 409". The server had
 * answered `{ error: 'username_taken' }` — the one part of that response written for a
 * person to act on — and the client threw the status code instead.
 */
describe('failureMessage', () => {
  test('a taken username says so, and says what to do', () => {
    const message = failureMessage('Signup', 409, { error: 'username_taken' });
    expect(message).toContain('already taken');
    expect(message).toContain('different');
    // The thing a user cannot act on must not be the thing they are shown.
    expect(message).not.toContain('409');
  });

  test('other known codes get their own sentence', () => {
    expect(failureMessage('Login', 429, { error: 'rate_limited' })).toContain('Wait a minute');
    expect(failureMessage('Login', 403, { error: 'locked_out' })).toContain('locked');
  });

  /**
   * An unknown code keeps its name rather than being given an invented meaning: a
   * message written for a condition nobody has thought about is worse than an honest
   * one that can be looked up.
   */
  test('an unknown code is reported verbatim, not guessed at', () => {
    expect(failureMessage('Signup', 400, { error: 'some_new_code' })).toBe(
      'Signup failed: some_new_code',
    );
  });

  test('a response with no code falls back to the status', () => {
    expect(failureMessage('Signup', 500, {})).toBe('Signup failed with status 500');
    expect(failureMessage('Signup', 502, 'gateway')).toBe('Signup failed with status 502');
    expect(failureMessage('Signup', 503, null)).toBe('Signup failed with status 503');
  });
});
