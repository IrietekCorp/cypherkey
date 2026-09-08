/**
 * The little coloured square beside an entry.
 *
 * A password manager usually shows the site's favicon here, and that is a request to a
 * third party for every entry in the vault. The response tells that party -- and anyone
 * watching the connection -- exactly which sites the user keeps credentials for, which
 * is roughly the list a zero-knowledge product exists to keep private. Even a favicon
 * proxy just moves who learns it.
 *
 * So the mark is derived from the entry itself: initials the user already recognises,
 * and a hue that is stable for a given name so the same site looks the same every time.
 * Nothing is fetched, and the vault stays local.
 */
import type { VaultItem } from './item';

export type ItemMark = {
  /** One or two characters. Never empty. */
  initials: string;
  /** 0-359, stable for a given key. */
  hue: number;
};

/** Everything a mark is derived from, so the rules can be tested without an item. */
export function markFor(name: string, key: string): ItemMark {
  return { initials: initialsFor(name), hue: hueFor(key === '' ? name : key) };
}

/** The mark for a vault entry: a login is known by its host, a note by its title. */
export function itemMark(item: VaultItem): ItemMark {
  return item.kind === 'login'
    ? markFor(item.title.trim() === '' ? item.host : item.title, item.host)
    : markFor(item.title, item.title);
}

/**
 * Initials a person would recognise.
 *
 * Two words give two letters ("Cloud Flare" → CF). One word gives its first two
 * ("GitHub" → GI), because a single letter collides constantly in a list. A leading
 * `www.` is dropped so every site does not read WW.
 */
export function initialsFor(name: string): string {
  const cleaned = name
    .trim()
    .replace(/^www\./i, '')
    .replace(/^https?:\/\//i, '');
  if (cleaned === '') return '?';

  const words = cleaned.split(/[\s._/-]+/).filter((w) => w.length > 0);
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const single = words[0] as string;
    return [...single].slice(0, 2).join('').toUpperCase();
  }
  const first = [...(words[0] as string)][0] ?? '';
  const second = [...(words[1] as string)][0] ?? '';
  return `${first}${second}`.toUpperCase();
}

/**
 * A stable hue for a key.
 *
 * FNV-1a, because it is four lines and this is decoration -- nothing here is a security
 * decision, and a hash imported for the purpose would cost popup weight for a colour.
 */
export function hueFor(key: string): number {
  let hash = 0x811c9dc5;
  for (const ch of key.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}
