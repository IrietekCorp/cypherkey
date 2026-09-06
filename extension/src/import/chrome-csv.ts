import type { VaultItem } from '../vault/item';
import { parseCsvRecords } from './csv';

/**
 * Chrome's password export.
 *
 * Header is `name,url,username,password,note` — though the columns have moved between
 * versions, so they are read by name rather than by position.
 */

export type ImportResult = {
  items: VaultItem[];
  /** Rows that could not be used, each with a reason the user can act on. */
  skipped: Array<{ row: number; reason: string }>;
  /** Records seen, so `items.length + skipped.length` reconciles against it. */
  total: number;
};

export type ImportDeps = { newId: () => string; now: () => number };

/** Best-effort host from a URL, for the domain match M2-10 does before filling. */
export function hostFromUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return '';
  try {
    return new URL(trimmed).hostname;
  } catch {
    // Chrome sometimes exports a bare host, and older rows can hold an app id.
    return trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').split('/')[0] ?? '';
  }
}

export function parseChromeCsv(input: string, deps: ImportDeps): ImportResult {
  const records = parseCsvRecords(input);
  const items: VaultItem[] = [];
  const skipped: ImportResult['skipped'] = [];

  records.forEach((record, index) => {
    // Row numbers are what the user sees in a spreadsheet: 1 is the header.
    const row = index + 2;
    const password = record.password ?? '';
    const name = (record.name ?? '').trim();
    const url = record.url ?? '';

    if (password.length === 0) {
      skipped.push({ row, reason: 'no password in this row' });
      return;
    }
    const title = name.length > 0 ? name : hostFromUrl(url);
    if (title.length === 0) {
      skipped.push({ row, reason: 'no name or address to identify it by' });
      return;
    }

    items.push({
      kind: 'login',
      id: deps.newId(),
      title,
      host: hostFromUrl(url),
      username: (record.username ?? '').trim(),
      // Never trimmed: a leading or trailing space is part of the password, and
      // removing one locks the user out of the site with no visible cause.
      password,
      ...((record.note ?? '').length > 0 ? { notes: record.note as string } : {}),
      updatedAt: deps.now(),
    });
  });

  return { items, skipped, total: records.length };
}
