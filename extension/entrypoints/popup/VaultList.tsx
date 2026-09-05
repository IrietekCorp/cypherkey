import { useMemo, useState } from 'react';
import { type VaultItem, itemSummary, searchItems } from '../../src/vault/item';

export type VaultListProps = {
  items: VaultItem[];
  onOpen(item: VaultItem): void;
  onAdd(kind: VaultItem['kind']): void;
};

/**
 * The list, and the search over it.
 *
 * Search is a ranked substring match rather than a fuzzy library. The list is local
 * and small, ranking is three fields deep, and a dependency here would cost download
 * size on every popup open for a problem this does not have. Revisit if real vaults
 * make it feel wrong.
 */
export function VaultList({ items, onOpen, onAdd }: VaultListProps) {
  const [query, setQuery] = useState('');
  const results = useMemo(() => searchItems(items, query), [items, query]);

  return (
    <main className="flex flex-col gap-3 p-4 font-sans text-sm">
      <div className="flex items-center gap-2">
        <h1 className="text-base font-semibold">Vault</h1>
        <span className="text-xs text-neutral-500">{items.length} items</span>
      </div>

      <input
        data-testid="search"
        placeholder="Search"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1"
      />

      {results.length === 0 ? (
        <p data-testid="empty" className="text-xs text-neutral-500">
          {items.length === 0 ? 'Nothing saved yet.' : 'Nothing matches that.'}
        </p>
      ) : (
        <ul data-testid="items" className="flex flex-col">
          {results.map((item) => {
            const summary = itemSummary(item);
            return (
              <li key={item.id}>
                <button
                  type="button"
                  data-testid={`item-${item.id}`}
                  onClick={() => onOpen(item)}
                  className="flex w-full flex-col items-start rounded px-2 py-1 text-left hover:bg-neutral-100"
                >
                  <span className="font-medium">{summary.title}</span>
                  <span className="text-xs text-neutral-500">{summary.detail}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}

      <div className="flex gap-2">
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
