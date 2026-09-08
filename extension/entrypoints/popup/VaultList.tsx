import { useMemo, useState } from 'react';
import { type VaultItem, itemSummary, searchItems } from '../../src/vault/item';
import { itemMark } from '../../src/vault/mark';

export type VaultListProps = {
  items: VaultItem[];
  onOpen(item: VaultItem): void;
  onAdd(kind: VaultItem['kind']): void;
  onProfile(): void;
};

/** The categories, in the order they are worth scanning. */
const SECTIONS = [
  { kind: 'login' as const, label: 'Logins', empty: 'No logins yet.' },
  { kind: 'note' as const, label: 'Secure notes', empty: 'No notes yet.' },
];

/**
 * The dashboard.
 *
 * Grouped by kind rather than one flat list, because the two are looked for differently:
 * a login is hunted for by site when you need to get in somewhere, a note is browsed.
 * The groups collapse to nothing when empty, so a vault of only logins reads as a list
 * rather than a list plus an apology.
 *
 * Search is a ranked substring match rather than a fuzzy library: the list is local and
 * small, ranking is three fields deep, and a dependency here would cost download size on
 * every popup open for a problem this does not have.
 */
export function VaultList({ items, onOpen, onAdd, onProfile }: VaultListProps) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchItems(items, query), [items, query]);
  const searching = query.trim().length > 0;

  const grouped = useMemo(
    () => SECTIONS.map((s) => ({ ...s, rows: results.filter((i) => i.kind === s.kind) })),
    [results],
  );

  return (
    <main className="flex h-full flex-col gap-3 p-4 font-sans text-sm">
      <header className="flex items-center justify-between gap-2">
        <div className="flex items-baseline gap-2">
          <h1 className="text-base font-semibold">Vault</h1>
          <span data-testid="count" className="text-xs text-neutral-500">
            {items.length} {items.length === 1 ? 'item' : 'items'}
          </span>
        </div>
        <button
          type="button"
          data-testid="profile"
          onClick={onProfile}
          className="rounded border border-neutral-300 px-2 py-1 text-xs text-neutral-700 hover:bg-neutral-100"
        >
          Profile
        </button>
      </header>

      <input
        data-testid="search"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1"
      />

      <div className="flex flex-col gap-4 overflow-y-auto">
        {results.length === 0 ? (
          <p data-testid="empty" className="text-xs text-neutral-500">
            {items.length === 0
              ? 'Nothing saved yet. Add a login to get started.'
              : 'Nothing matches that.'}
          </p>
        ) : (
          grouped.map((section) =>
            // While searching, a section with no hits is noise rather than information.
            section.rows.length === 0 && searching ? null : (
              <section key={section.kind} className="flex flex-col gap-1">
                <h2 className="text-[11px] font-semibold uppercase tracking-wider text-neutral-500">
                  {section.label}
                  <span className="ml-1.5 font-normal tracking-normal text-neutral-400">
                    {section.rows.length}
                  </span>
                </h2>

                {section.rows.length === 0 ? (
                  <p className="px-1 text-xs text-neutral-400">{section.empty}</p>
                ) : (
                  <ul data-testid={`items-${section.kind}`} className="flex flex-col">
                    {section.rows.map((item) => (
                      <Row key={item.id} item={item} onOpen={() => onOpen(item)} />
                    ))}
                  </ul>
                )}
              </section>
            ),
          )
        )}
      </div>

      <div className="mt-auto flex gap-2 border-t border-neutral-200 pt-3">
        <button
          type="button"
          data-testid="add-login"
          onClick={() => onAdd('login')}
          className="rounded bg-neutral-900 px-2 py-1 text-white"
        >
          Add login
        </button>
        <button
          type="button"
          data-testid="add-note"
          onClick={() => onAdd('note')}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          Add note
        </button>
      </div>
    </main>
  );
}

/** One entry: its mark, what it is, and who it is for. Never its password. */
function Row({ item, onOpen }: { item: VaultItem; onOpen(): void }) {
  const summary = itemSummary(item);
  const mark = itemMark(item);

  return (
    <li>
      <button
        type="button"
        data-testid={`item-${item.id}`}
        onClick={onOpen}
        className="flex w-full items-center gap-2.5 rounded px-1.5 py-1.5 text-left hover:bg-neutral-100"
      >
        <span
          aria-hidden="true"
          data-testid={`mark-${item.id}`}
          className="grid h-7 w-7 shrink-0 place-items-center rounded text-[11px] font-semibold"
          style={{
            // Fixed saturation and lightness so every mark reads as one set; only the
            // hue moves. Computed from the entry, never fetched.
            background: `hsl(${mark.hue} 58% 92%)`,
            color: `hsl(${mark.hue} 55% 30%)`,
          }}
        >
          {mark.initials}
        </span>
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-medium">{summary.title}</span>
          <span className="truncate text-xs text-neutral-500">
            {summary.detail === '' ? '—' : summary.detail}
          </span>
        </span>
      </button>
    </li>
  );
}
