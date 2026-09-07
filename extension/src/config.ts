/**
 * Where the extension talks to the server.
 *
 * A beta tester's build must work with no configuration, so the default is production.
 * A dev build overrides it with `VITE_CYPHERKEY_API`, which is why this is resolved at
 * build time rather than stored: a server URL held in `storage` is a value an attacker
 * who can write storage could repoint at their own host, and every request after that
 * carries an `authHash` to a server of their choosing.
 */

/** The hosted API. Must stay in step with `host_permissions` in `manifest.ts`. */
export const PRODUCTION_API_BASE_URL = 'https://api.cypherkey.io';

/**
 * Resolves the API base URL from an optional build-time override, guaranteeing a value
 * with no trailing slash so callers can join paths without doubling it.
 */
export function resolveApiBaseUrl(override?: string): string {
  const raw = override?.trim();
  if (raw === undefined || raw === '') return PRODUCTION_API_BASE_URL;
  return raw.replace(/\/+$/, '');
}

const env = import.meta.env as Record<string, string | undefined> | undefined;

/** The base URL this build talks to. */
export const API_BASE_URL = resolveApiBaseUrl(env?.VITE_CYPHERKEY_API);
