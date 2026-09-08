import { describe, expect, test } from 'bun:test';
import type { VaultItem } from './item';
import { hueFor, initialsFor, itemMark } from './mark';

const login = (over: Partial<Extract<VaultItem, { kind: 'login' }>> = {}): VaultItem => ({
  kind: 'login',
  id: 'i1',
  title: 'GitHub',
  host: 'github.com',
  username: 'shawn',
  password: 'hunter2',
  updatedAt: 1,
  ...over,
});

describe('initialsFor', () => {
  test('two words give two letters', () => {
    expect(initialsFor('Cloud Flare')).toBe('CF');
    expect(initialsFor('Apartment List')).toBe('AL');
  });

  test('one word gives its first two, because one letter collides constantly', () => {
    expect(initialsFor('GitHub')).toBe('GI');
    expect(initialsFor('x')).toBe('X');
  });

  test('a leading www. is dropped, or every site reads WW', () => {
    expect(initialsFor('www.stripe.com')).toBe('SC');
    expect(initialsFor('https://linear.app')).toBe('LA');
  });

  test('separators in a host are word breaks', () => {
    expect(initialsFor('mail.google.com')).toBe('MG');
    expect(initialsFor('my-bank.co.uk')).toBe('MB');
  });

  test('never returns nothing', () => {
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('   ')).toBe('?');
    expect(initialsFor('...')).toBe('?');
  });

  test('non-latin names keep their own characters', () => {
    // Slicing by code point, not by UTF-16 unit, so a surrogate pair is not halved.
    expect(initialsFor('日本銀行')).toBe('日本');
    expect(initialsFor('🦊 Firefox')).toBe('🦊F');
  });
});

describe('hueFor', () => {
  test('is stable for the same key', () => {
    expect(hueFor('github.com')).toBe(hueFor('github.com'));
  });

  test('ignores case and surrounding space, so one site is one colour', () => {
    expect(hueFor(' GitHub.com ')).toBe(hueFor('github.com'));
  });

  test('is in range', () => {
    for (const key of ['a', 'github.com', '', 'a very long name indeed', '日本']) {
      const hue = hueFor(key);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  test('different sites generally differ', () => {
    const hues = new Set(
      ['github.com', 'stripe.com', 'google.com', 'linear.app', 'figma.com'].map(hueFor),
    );
    // Not a guarantee -- 360 buckets collide -- but a hash that returned one value for
    // everything would pass every test above and make the whole list one colour.
    expect(hues.size).toBeGreaterThan(3);
  });
});

describe('itemMark', () => {
  test('a login is coloured by its host, so a rename keeps its colour', () => {
    const before = itemMark(login({ title: 'GitHub' }));
    const after = itemMark(login({ title: 'Work GitHub' }));
    expect(after.hue).toBe(before.hue);
    expect(after.initials).toBe('WG');
  });

  test('a login with no title falls back to the host', () => {
    expect(itemMark(login({ title: '   ' })).initials).toBe('GC');
  });

  test('a note is known by its title', () => {
    const mark = itemMark({ kind: 'note', id: 'n1', title: 'Wifi Codes', body: '', updatedAt: 1 });
    expect(mark.initials).toBe('WC');
    expect(mark.hue).toBe(hueFor('Wifi Codes'));
  });

  /** The reason this module exists rather than an <img src=…> pointing at a favicon. */
  test('derives everything locally, with no network call', async () => {
    // Comments are stripped first: this file explains at length why it does not fetch a
    // favicon, and a naive grep finds that explanation and calls it a violation.
    const raw = await Bun.file(`${import.meta.dir}/mark.ts`).text();
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

    // A favicon request tells a third party which sites are in the vault, which is the
    // list the product exists to keep private. Nothing here may reach the network.
    for (const forbidden of ['fetch', 'XMLHttpRequest', 'Image(', 'import(']) {
      expect(code).not.toContain(forbidden);
    }
    // The only inputs are fields the vault already holds.
    expect(code).toContain('item.host');
    expect(code).toContain('item.title');
  });
});
