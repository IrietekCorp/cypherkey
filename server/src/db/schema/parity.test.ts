import { describe, expect, test } from 'bun:test';
import type { Table } from 'drizzle-orm';
import { getTableColumns, getTableName } from 'drizzle-orm';
import * as pg from './pg';
import * as sqlite from './sqlite';

/** A-1.5: one schema, two databases, no forks. The two dialect files must stay identical in shape. */
function shape(tables: Record<string, Table>) {
  const out: Record<string, string[]> = {};
  for (const table of Object.values(tables)) {
    out[getTableName(table)] = Object.values(getTableColumns(table))
      .map(
        (c) => `${c.name}${c.notNull ? '!' : '?'}${c.primary ? '#' : ''}${c.isUnique ? '*' : ''}`,
      )
      .sort();
  }
  return out;
}

describe('dialect parity', () => {
  test('both dialects declare the same tables', () => {
    expect(Object.keys(shape(sqlite.tables)).sort()).toEqual(Object.keys(shape(pg.tables)).sort());
  });

  test('every table has the same columns, nullability, keys and uniqueness', () => {
    expect(shape(sqlite.tables)).toEqual(shape(pg.tables));
  });

  test('covers exactly the thirteen tables of A-9', () => {
    expect(Object.keys(shape(sqlite.tables)).sort()).toEqual([
      'audit_log',
      'auth_score_history',
      'biometric_profiles',
      'devices',
      'enrollment_samples',
      'lockouts',
      'nonces',
      'rate_limits',
      'refresh_tokens',
      'step_up_factors',
      'users',
      'vault_cursors',
      'vault_items',
    ]);
  });

  test('A-9 removed credentials and enroll_tokens; they must not come back', () => {
    const names = Object.keys(shape(sqlite.tables));
    expect(names).not.toContain('credentials');
    expect(names).not.toContain('enroll_tokens');
  });
});

describe('what the schema is not allowed to hold', () => {
  const columns = (tables: Record<string, Table>) =>
    Object.values(tables).flatMap((t) =>
      Object.values(getTableColumns(t)).map((c) => `${getTableName(t)}.${c.name}`),
    );

  test('a feature vector can live in exactly one table — enrollment_samples (A-4.6)', () => {
    for (const tables of [sqlite.tables, pg.tables]) {
      const holders = columns(tables).filter((c) => c.includes('feature_vector'));
      expect(holders).toEqual(['enrollment_samples.feature_vector']);
    }
  });

  test('no column exists for raw keystroke events, timings, scripts or passphrases', () => {
    const forbidden =
      /key_event|keystroke|dwell|flight|digraph|timing|passphrase|resolved|script_text|plaintext/;
    for (const tables of [sqlite.tables, pg.tables]) {
      expect(columns(tables).filter((c) => forbidden.test(c))).toEqual([]);
    }
  });

  test('the profile records the script length, never the passphrase length (A-4.2, v1.2)', () => {
    for (const tables of [sqlite.tables, pg.tables]) {
      const cols = columns(tables);
      expect(cols).toContain('biometric_profiles.script_len');
      expect(cols).not.toContain('biometric_profiles.passphrase_len');
    }
  });

  test('the v1.2 columns are present', () => {
    for (const tables of [sqlite.tables, pg.tables]) {
      const cols = columns(tables);
      for (const c of [
        'users.key_version',
        'users.consent_at',
        'users.consent_policy_version',
        'biometric_profiles.script_commitments',
      ]) {
        expect(cols).toContain(c);
      }
    }
  });
});
