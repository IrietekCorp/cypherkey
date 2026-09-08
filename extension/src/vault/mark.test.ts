import { describe, expect, test } from 'bun:test';
import type { VaultItem } from './item';
import { initialsFor, itemMark } from './mark';

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

  test('punctuation is not a word', () => {
    // "Wifi — flat" split to ["Wifi", "—", "flat"] and took the dash as an initial.
    expect(initialsFor('Wifi — flat')).toBe('WF');
    expect(initialsFor('Mail · Work')).toBe('MW');
  });

  test('never returns nothing', () => {
    expect(initialsFor('')).toBe('?');
    expect(initialsFor('   ')).toBe('?');
    expect(initialsFor('...')).toBe('?');
  });

  test('non-latin names keep their own characters', () => {
    // Slicing by code point, not by UTF-16 unit, so a surrogate pair is not halved.
    expect(initialsFor('日本銀行')).toBe('日本');
    expect(initialsFor('Санкт Петербург')).toBe('СП');
  });

  /**
   * An emoji in a title is decoration, and "🦊F" is not initials anyone recognises. It
   * used to be kept; skipping it falls through to the words that carry the name.
   */
  test('an emoji is not an initial', () => {
    expect(initialsFor('🦊 Firefox')).toBe('FI');
    // Unless it is all there is, in which case there is nothing else to show.
    expect(initialsFor('🦊')).toBe('?');
  });
});

describe('the tint is the category, not the entry', () => {
  test('a login and a note are tinted differently', () => {
    const loginMark = itemMark(login());
    const noteMark = itemMark({ kind: 'note', id: 'n1', title: 'Wifi', body: '', updatedAt: 1 });
    expect(loginMark.kind).toBe('login');
    expect(noteMark.kind).toBe('note');
  });

  /**
   * A per-entry hue was tried first and reads better as decoration, but it makes colour
   * mean nothing: with every row a different shade, telling logins from notes at a glance
   * requires reading them. §09 fixes the tint to the category.
   */
  test('two different logins share a tint', () => {
    expect(itemMark(login({ host: 'github.com' })).kind).toBe(
      itemMark(login({ host: 'stripe.com' })).kind,
    );
  });
});

describe('itemMark', () => {
  test('a renamed login keeps its category and takes new initials', () => {
    expect(itemMark(login({ title: 'Work GitHub' })).initials).toBe('WG');
    expect(itemMark(login({ title: 'Work GitHub' })).kind).toBe('login');
  });

  test('a login with no title falls back to the host', () => {
    expect(itemMark(login({ title: '   ' })).initials).toBe('GC');
  });

  test('a note is known by its title', () => {
    const mark = itemMark({ kind: 'note', id: 'n1', title: 'Wifi Codes', body: '', updatedAt: 1 });
    expect(mark.initials).toBe('WC');
    expect(mark.kind).toBe('note');
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
