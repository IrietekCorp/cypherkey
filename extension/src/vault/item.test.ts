import { describe, expect, test } from 'bun:test';
import { type LoginItem, type NoteItem, type VaultItem, itemSummary, searchItems } from './item';

const login = (over: Partial<LoginItem> = {}): LoginItem => ({
  kind: 'login',
  id: crypto.randomUUID(),
  title: 'GitHub',
  host: 'github.com',
  username: 'shawn',
  password: 'hunter2',
  updatedAt: 1_000,
  ...over,
});

const note = (over: Partial<NoteItem> = {}): NoteItem => ({
  kind: 'note',
  id: crypto.randomUUID(),
  title: 'Wifi',
  body: 'upstairs: swordfish',
  updatedAt: 1_000,
  ...over,
});

describe('an empty query', () => {
  test('shows everything, most recently changed first', () => {
    const older = login({ title: 'A', updatedAt: 1 });
    const newer = login({ title: 'B', updatedAt: 2 });
    expect(searchItems([older, newer], '').map((i) => i.title)).toEqual(['B', 'A']);
  });

  test('whitespace counts as empty', () => {
    const items = [login(), note()];
    expect(searchItems(items, '   ')).toHaveLength(2);
  });
});

describe('ranking is title, then host, then username', () => {
  test('a title match outranks a host match', () => {
    const byTitle = login({ title: 'Acme', host: 'unrelated.com', username: 'x' });
    const byHost = login({ title: 'Unrelated', host: 'acme.com', username: 'x' });
    expect(searchItems([byHost, byTitle], 'acme')[0]).toBe(byTitle);
  });

  test('a host match outranks a username match', () => {
    const byHost = login({ title: 'Unrelated', host: 'acme.com', username: 'x' });
    const byUsername = login({ title: 'Unrelated', host: 'other.com', username: 'acme' });
    expect(searchItems([byUsername, byHost], 'acme')[0]).toBe(byHost);
  });

  /** Typing "git" to find "GitHub" is the common case; "Digital Ocean" is not meant. */
  test('a prefix match outranks the same word found later', () => {
    const prefix = login({ title: 'GitHub' });
    const middle = login({ title: 'Digital Ocean' });
    expect(searchItems([middle, prefix], 'git')[0]).toBe(prefix);
  });

  test('ties break on recency', () => {
    const older = login({ title: 'Acme', updatedAt: 1 });
    const newer = login({ title: 'Acme', updatedAt: 2 });
    expect(searchItems([older, newer], 'acme')[0]).toBe(newer);
  });

  test('search is case insensitive both ways', () => {
    const item = login({ title: 'GitHub' });
    expect(searchItems([item], 'GITHUB')).toHaveLength(1);
    expect(searchItems([login({ title: 'github' })], 'GitHub')).toHaveLength(1);
  });

  test('non-matching items are excluded, not just ranked lower', () => {
    // Distinct hosts on purpose: the default fixture host is github.com, so leaving it
    // would have matched "Bank" on its host and made this assert nothing.
    const items = [
      login({ title: 'GitHub', host: 'github.com' }),
      login({ title: 'Bank', host: 'bank.example' }),
    ];
    expect(searchItems(items, 'github').map((i) => i.title)).toEqual(['GitHub']);
  });
});

describe('a password is never searchable', () => {
  /**
   * Matching on it would let anyone with the vault already open confirm a guess by
   * typing it into the search box, and would surface entries for a reason the user
   * cannot see on screen.
   */
  test('typing a password finds nothing', () => {
    const item = login({ title: 'GitHub', password: 'correcthorse' });
    expect(searchItems([item], 'correcthorse')).toHaveLength(0);
  });

  test('a note body is searchable, because it is content rather than a secret field', () => {
    const item = note({ title: 'Wifi', body: 'upstairs: swordfish' });
    expect(searchItems([item], 'swordfish')).toHaveLength(1);
  });
});

describe('itemSummary', () => {
  test('a login shows its username, never its password', () => {
    const summary = itemSummary(login({ password: 'hunter2' }));
    expect(summary.detail).toBe('shawn');
    expect(JSON.stringify(summary)).not.toContain('hunter2');
  });

  test('a note shows its first line', () => {
    const summary = itemSummary(note({ body: 'first line\nsecond line' }));
    expect(summary.detail).toBe('first line');
  });

  test('a long first line is truncated rather than overflowing the list', () => {
    const summary = itemSummary(note({ body: 'x'.repeat(200) }));
    expect(summary.detail.length).toBeLessThanOrEqual(61);
    expect(summary.detail.endsWith('…')).toBe(true);
  });

  test('every kind produces a summary', () => {
    const items: VaultItem[] = [login(), note()];
    for (const item of items) {
      expect(itemSummary(item).title.length).toBeGreaterThan(0);
    }
  });
});
