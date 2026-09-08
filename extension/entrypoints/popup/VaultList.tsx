import { useMemo, useState } from 'react';
import { type VaultItem, itemSummary, searchItems } from '../../src/vault/item';
import { itemMark } from '../../src/vault/mark';

export type VaultListProps = {
  items: VaultItem[];
  onOpen(item: VaultItem): void;
  onAdd(kind: VaultItem['kind']): void;
  onProfile(): void;
  onImport(): void;
  /** For the profile mark in the header. */
  username: string;
};

/** The categories, in the order they are worth scanning. */
const SECTIONS = [
  { kind: 'login' as const, label: 'Logins' },
  { kind: 'note' as const, label: 'Secure notes' },
];

/**
 * The vault, frames 09 and 10.
 *
 * Grouped by kind rather than one flat list, because the two are looked for differently:
 * a login is hunted for by site when you need to get in somewhere, a note is browsed.
 * Sections disappear while searching, so a query does not leave empty headings behind.
 *
 * Search is a ranked substring match rather than a fuzzy library: the list is local and
 * small, ranking is three fields deep, and a dependency here would cost download size on
 * every popup open for a problem this does not have.
 */
export function VaultList({ items, onOpen, onAdd, onProfile, onImport, username }: VaultListProps) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchItems(items, query), [items, query]);
  const searching = query.trim().length > 0;

  const grouped = useMemo(
    () => SECTIONS.map((s) => ({ ...s, rows: results.filter((i) => i.kind === s.kind) })),
    [results],
  );

  return (
    <main
      className="ck-app flex h-full flex-col"
      style={{ padding: 'var(--ck-s4)', gap: 'var(--ck-s4)' }}
    >
      <header className="flex items-center" style={{ gap: 'var(--ck-s3)' }}>
        <input
          data-testid="search"
          placeholder={
            items.length === 0
              ? 'Search'
              : `Search ${items.length} ${items.length === 1 ? 'entry' : 'entries'}`
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="input"
        />
        <button
          type="button"
          data-testid="profile"
          onClick={onProfile}
          aria-label="Profile"
          className="btn btn-icon"
          style={{ borderRadius: '50%', width: 30, height: 30, padding: 0 }}
        >
          <span className="ck-small" style={{ fontWeight: 500 }}>
            {initials(username)}
          </span>
        </button>
      </header>

      <div className="flex flex-col overflow-y-auto" style={{ gap: 'var(--ck-s5)' }}>
        {results.length === 0 ? (
          <Empty query={query} searching={searching} onAdd={onAdd} onImport={onImport} />
        ) : (
          grouped.map((section) =>
            section.rows.length === 0 ? null : (
              <section key={section.kind} className="flex flex-col" style={{ gap: 'var(--ck-s1)' }}>
                <h2
                  className="ck-small ck-muted flex items-baseline"
                  style={{ gap: 'var(--ck-s2)', letterSpacing: '0.06em' }}
                >
                  <span style={{ textTransform: 'uppercase' }}>{section.label}</span>
                  <span className="ck-num">{section.rows.length}</span>
                </h2>
                <ul data-testid={`items-${section.kind}`} className="flex flex-col">
                  {section.rows.map((item) => (
                    <Row key={item.id} item={item} onOpen={() => onOpen(item)} />
                  ))}
                </ul>
              </section>
            ),
          )
        )}
      </div>

      <div
        className="mt-auto flex"
        style={{
          gap: 'var(--ck-s2)',
          paddingTop: 'var(--ck-s3)',
          borderTop: '1px solid var(--ck-border)',
        }}
      >
        <button
          type="button"
          data-testid="add-login"
          onClick={() => onAdd('login')}
          className="btn btn-primary"
        >
          Add login
        </button>
        <button
          type="button"
          data-testid="add-note"
          onClick={() => onAdd('note')}
          className="btn btn-secondary"
        >
          Add note
        </button>
      </div>
    </main>
  );
}

/**
 * Frame 10: two empty states, and they are not the same thing.
 *
 * "Nothing matches" is a dead end unless it offers the way out, and a vault with nothing
 * in it needs to say what to do rather than state the obvious.
 */
function Empty({
  query,
  searching,
  onAdd,
  onImport,
}: {
  query: string;
  searching: boolean;
  onAdd(kind: VaultItem['kind']): void;
  onImport(): void;
}) {
  if (searching) {
    return (
      <div data-testid="empty" className="flex flex-col" style={{ gap: 'var(--ck-s2)' }}>
        <p className="ck-h2">Nothing for “{query.trim()}”</p>
        <p className="ck-small ck-muted">
          Search looks at titles, hosts and usernames — not notes.
        </p>
        <button
          type="button"
          data-testid="add-from-search"
          onClick={() => onAdd('login')}
          className="btn btn-ghost ck-small self-start"
        >
          Add it as a new login
        </button>
      </div>
    );
  }
  return (
    <div data-testid="empty" className="flex flex-col" style={{ gap: 'var(--ck-s2)' }}>
      <p className="ck-h2">Nothing in here yet</p>
      <p className="ck-small ck-muted">
        Add your first login, or bring a vault over from somewhere else — it stays on your machine
        while it converts.
      </p>
      <div className="flex" style={{ gap: 'var(--ck-s2)' }}>
        <button
          type="button"
          data-testid="empty-add"
          onClick={() => onAdd('login')}
          className="btn btn-primary"
        >
          Add a login
        </button>
        <button
          type="button"
          data-testid="empty-import"
          onClick={onImport}
          className="btn btn-secondary"
        >
          Import
        </button>
      </div>
    </div>
  );
}

/** One entry: its mark, what it is, and who it is for. Never its password. */
function Row({ item, onOpen }: { item: VaultItem; onOpen(): void }) {
  const summary = itemSummary(item);
  const mark = itemMark(item);
  const login = mark.kind === 'login';

  return (
    <li>
      <button type="button" data-testid={`item-${item.id}`} onClick={onOpen} className="card-row">
        <span
          aria-hidden="true"
          data-testid={`mark-${item.id}`}
          data-kind={mark.kind}
          className="grid shrink-0 place-items-center"
          style={{
            // Tinted by category, never per entry and never fetched: two tints answer
            // "which of these are logins" without the reader parsing a single row.
            width: 26,
            height: 26,
            borderRadius: 'var(--ck-r-sm)',
            fontSize: 10.5,
            fontWeight: 500,
            background: login ? 'var(--ck-accent-900)' : 'var(--ck-inset)',
            color: login ? 'var(--ck-accent-300)' : 'var(--ck-muted)',
            border: `1px solid ${login ? 'var(--ck-accent-700)' : 'var(--ck-border)'}`,
          }}
        >
          {mark.initials}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate">{summary.title}</span>
          <span className="ck-small ck-muted truncate">
            {summary.detail === '' ? (login ? '—' : 'Note') : summary.detail}
          </span>
        </span>
      </button>
    </li>
  );
}

/** The profile mark in the header: the account's own initials, not an entry's. */
function initials(username: string): string {
  const parts = username
    .trim()
    .split(/[\s._-]+/)
    .filter((p) => p.length > 0);
  if (parts.length === 0) return '?';
  const first = [...(parts[0] as string)][0] ?? '';
  const second =
    parts.length > 1 ? ([...(parts[1] as string)][0] ?? '') : ([...(parts[0] as string)][1] ?? '');
  return `${first}${second}`.toUpperCase();
}
