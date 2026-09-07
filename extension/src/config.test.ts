import { describe, expect, test } from 'bun:test';
import { PRODUCTION_API_BASE_URL, resolveApiBaseUrl } from './config';

describe('resolveApiBaseUrl', () => {
  test('defaults to production when nothing overrides it', () => {
    expect(resolveApiBaseUrl(undefined)).toBe(PRODUCTION_API_BASE_URL);
    expect(resolveApiBaseUrl('')).toBe(PRODUCTION_API_BASE_URL);
    expect(resolveApiBaseUrl('   ')).toBe(PRODUCTION_API_BASE_URL);
  });

  test('a dev override wins', () => {
    expect(resolveApiBaseUrl('http://localhost:3000')).toBe('http://localhost:3000');
  });

  test('trailing slashes are stripped so callers can join paths', () => {
    // `${base}/auth/login` would otherwise become a double slash, which some routers
    // treat as a different path than the one the server registered.
    expect(resolveApiBaseUrl('https://api.cypherkey.io/')).toBe('https://api.cypherkey.io');
    expect(resolveApiBaseUrl('https://api.cypherkey.io///')).toBe('https://api.cypherkey.io');
  });

  /**
   * The default is the one URL a beta tester never configures, so it is pinned here.
   * It must also stay in step with `host_permissions`: if they disagree, every request
   * fails in a real browser and passes in every test.
   */
  test('the production default is https and is the hosted API', () => {
    expect(PRODUCTION_API_BASE_URL).toBe('https://api.cypherkey.io');
    expect(PRODUCTION_API_BASE_URL.startsWith('https://')).toBe(true);
  });
});
