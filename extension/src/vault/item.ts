/**
 * What a vault holds, and how it is searched.
 *
 * Deliberately free of crypto and of React: `codec.ts` is the only place that encrypts,
 * and the screens are the only place that renders. This module is the shape and the
 * ranking, both of which are easier to get right when nothing else is in the way.
 */

export type LoginItem = {
  kind: 'login';
  id: string;
  title: string;
  /** The registrable host this belongs to. M2-10 matches against it before filling. */
  host: string;
  username: string;
  password: string;
  notes?: string;
  updatedAt: number;
};

export type NoteItem = {
  kind: 'note';
  id: string;
  title: string;
  body: string;
  updatedAt: number;
};

export type VaultItem = LoginItem | NoteItem;

/** A new item's id. Client-generated, and unique only within an account (A-9). */
export function newItemId(): string {
  return crypto.randomUUID();
}

/**
 * Ranked search.
 *
 * Ranking is title, then host, then username — the order in which a person recognises
 * an entry. A prefix match beats a match in the middle, because typing "git" to find
 * "GitHub" is the common case and "Digital Ocean" is not what was meant.
 *
 * A password is never searched. Matching on it would let anyone with the vault open
 * confirm a guess by typing it into the search box, and would surface entries for
 * reasons the user cannot see.
 */
export function searchItems(items: VaultItem[], query: string): VaultItem[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) {
    return [...items].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  const scored: Array<{ item: VaultItem; score: number }> = [];
  for (const item of items) {
    const score = scoreItem(item, needle);
    if (score > 0) scored.push({ item, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || b.item.updatedAt - a.item.updatedAt)
    .map((s) => s.item);
}

/** Higher is better; 0 means no match. */
function scoreItem(item: VaultItem, needle: string): number {
  const fields: Array<[string, number]> = [[item.title, 100]];
  if (item.kind === 'login') {
    fields.push([item.host, 50], [item.username, 25]);
  } else {
    fields.push([item.body, 10]);
  }

  let best = 0;
  for (const [value, weight] of fields) {
    const haystack = value.toLowerCase();
    const at = haystack.indexOf(needle);
    if (at < 0) continue;
    // A prefix match outranks the same match found later in the string.
    best = Math.max(best, at === 0 ? weight * 2 : weight);
  }
  return best;
}

/** What the list shows. Never includes a password, even truncated. */
export function itemSummary(item: VaultItem): { title: string; detail: string } {
  return item.kind === 'login'
    ? { title: item.title, detail: item.username }
    : { title: item.title, detail: firstLine(item.body) };
}

function firstLine(body: string): string {
  const line = body.split('\n', 1)[0] ?? '';
  return line.length > 60 ? `${line.slice(0, 60)}…` : line;
}
