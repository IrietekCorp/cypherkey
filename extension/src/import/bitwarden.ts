import type { VaultItem } from '../vault/item';
import { type ImportDeps, type ImportResult, hostFromUrl } from './chrome-csv';

/**
 * Bitwarden's unencrypted JSON export.
 *
 * `type` is a number: 1 login, 2 secure note, 3 card, 4 identity. Only the first two
 * have somewhere to go here — a card or an identity is dropped with a reason rather
 * than mangled into a login, because an import that silently reshapes data is worse
 * than one that says what it could not take.
 */

const LOGIN = 1;
const SECURE_NOTE = 2;

type BitwardenItem = {
  type?: number;
  name?: string;
  notes?: string | null;
  login?: {
    username?: string | null;
    password?: string | null;
    uris?: Array<{ uri?: string | null }> | null;
  } | null;
};

const KIND_NAMES: Record<number, string> = { 3: 'card', 4: 'identity' };

export function parseBitwarden(input: string, deps: ImportDeps): ImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    // The whole file is unusable, which is different from a bad row: say so once
    // rather than reporting every line as broken.
    throw new Error('That file is not valid JSON. Export again without encryption.');
  }

  const container = parsed as { items?: unknown; encrypted?: unknown };
  if (container.encrypted === true) {
    throw new Error(
      'That export is encrypted. Bitwarden can export unencrypted JSON; this cannot read the encrypted form.',
    );
  }
  if (!Array.isArray(container.items)) {
    throw new Error('That file has no items. Check it is a Bitwarden JSON export.');
  }

  const raw = container.items as BitwardenItem[];
  const items: VaultItem[] = [];
  const skipped: ImportResult['skipped'] = [];

  raw.forEach((entry, index) => {
    const row = index + 1;
    const title = (entry.name ?? '').trim();
    if (title.length === 0) {
      skipped.push({ row, reason: 'no name' });
      return;
    }

    if (entry.type === SECURE_NOTE) {
      const body = entry.notes ?? '';
      if (body.length === 0) {
        skipped.push({ row, reason: `"${title}" is an empty note` });
        return;
      }
      items.push({ kind: 'note', id: deps.newId(), title, body, updatedAt: deps.now() });
      return;
    }

    if (entry.type !== LOGIN) {
      const kind = KIND_NAMES[entry.type ?? 0] ?? 'unsupported type';
      skipped.push({ row, reason: `"${title}" is a ${kind}, which CypherKey cannot hold yet` });
      return;
    }

    const password = entry.login?.password ?? '';
    if (password.length === 0) {
      skipped.push({ row, reason: `"${title}" has no password` });
      return;
    }

    const uri = entry.login?.uris?.[0]?.uri ?? '';
    items.push({
      kind: 'login',
      id: deps.newId(),
      title,
      host: hostFromUrl(uri),
      username: (entry.login?.username ?? '').trim(),
      password,
      ...((entry.notes ?? '').length > 0 ? { notes: entry.notes as string } : {}),
      updatedAt: deps.now(),
    });
  });

  return { items, skipped, total: raw.length };
}
