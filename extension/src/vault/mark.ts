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
 * tinted by category. Nothing is fetched, and the vault stays local.
 *
 * The tint is by category rather than per entry, which the style guide's §09 fixes. A
 * per-host hue was tried first and reads better as decoration, but it makes colour mean
 * nothing: with every row a different shade, a glance tells you which rows are logins and
 * which are notes only by reading them. Two tints answer that question without reading.
 */
import type { VaultItem } from './item';

export type ItemMark = {
  /** One or two characters. Never empty. */
  initials: string;
  /** The category the tint comes from. */
  kind: VaultItem['kind'];
};

/** Everything a mark is derived from, so the rules can be tested without an item. */
export function markFor(name: string, kind: VaultItem['kind']): ItemMark {
  return { initials: initialsFor(name), kind };
}

/** The mark for a vault entry: a login is known by its host, a note by its title. */
export function itemMark(item: VaultItem): ItemMark {
  return item.kind === 'login'
    ? markFor(item.title.trim() === '' ? item.host : item.title, 'login')
    : markFor(item.title, 'note');
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

  // Words must contain something a reader would call a letter or a digit. "Wifi — flat"
  // splits to ["Wifi", "—", "flat"] and took the dash as the second initial, giving "W—".
  const words = cleaned.split(/[\s._/-]+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return '?';
  if (words.length === 1) {
    const single = words[0] as string;
    return [...single].slice(0, 2).join('').toUpperCase();
  }
  const first = [...(words[0] as string)][0] ?? '';
  const second = [...(words[1] as string)][0] ?? '';
  return `${first}${second}`.toUpperCase();
}
