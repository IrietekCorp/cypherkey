import { useRef, useState } from 'react';
import { parseBitwarden } from '../../src/import/bitwarden';
import { type ImportResult, parseChromeCsv } from '../../src/import/chrome-csv';
import { type VaultItem, newItemId } from '../../src/vault/item';

/**
 * Importing from another manager.
 *
 * The file is read into memory, mapped, and dropped. It is never written anywhere: an
 * export from another password manager is a plaintext file full of credentials, and
 * leaving a copy behind would be a worse leak than anything the vault itself risks.
 *
 * Nothing is saved until the user has seen what will be imported and what will not.
 * An importer that silently drops rows is one that loses passwords quietly.
 */

export type ImportProps = {
  onImport(items: VaultItem[]): Promise<void> | void;
  onCancel(): void;
  now?: () => number;
};

type Format = 'bitwarden' | 'chrome';

export function Import({ onImport, onCancel, now = Date.now }: ImportProps) {
  const file = useRef<HTMLInputElement>(null);
  const [format, setFormat] = useState<Format>('bitwarden');
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = async () => {
    const chosen = file.current?.files?.[0];
    if (chosen === undefined) {
      setError('Choose a file first.');
      return;
    }

    setError(null);
    try {
      const text = await chosen.text();
      const deps = { newId: newItemId, now };
      setPreview(format === 'bitwarden' ? parseBitwarden(text, deps) : parseChromeCsv(text, deps));
    } catch (err) {
      // A whole-file problem — encrypted, or not the format claimed — is one message,
      // not a per-row complaint about every line.
      setPreview(null);
      setError((err as Error).message);
    }
  };

  const confirm = async () => {
    if (preview === null) return;
    setBusy(true);
    try {
      await onImport(preview.items);
      // The parsed plaintext goes with the screen. Holding it after the import would
      // keep every imported password alive for no reason.
      setPreview(null);
      if (file.current !== null) file.current.value = '';
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="flex flex-col gap-3 p-4 font-sans text-sm">
      <h1 className="text-base font-semibold">Import</h1>

      <div className="flex gap-2">
        {(
          [
            ['bitwarden', 'Bitwarden JSON'],
            ['chrome', 'Chrome CSV'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            data-testid={`format-${value}`}
            onClick={() => {
              setFormat(value);
              setPreview(null);
              setError(null);
            }}
            className={`rounded border px-2 py-1 ${
              format === value
                ? 'border-neutral-900 bg-neutral-900 text-white'
                : 'border-neutral-300'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-xs text-neutral-600">
        Your export is read here and never saved. Delete the file once you are done — it holds every
        password in plain text.
      </p>

      <input ref={file} type="file" data-testid="file" className="text-xs" />

      <button
        type="button"
        data-testid="read"
        onClick={read}
        className="self-start rounded border border-neutral-300 px-2 py-1"
      >
        Read the file
      </button>

      {error !== null && (
        <p data-testid="error" className="text-xs text-rose-700">
          {error}
        </p>
      )}

      {preview !== null && (
        <section className="flex flex-col gap-2">
          <p data-testid="summary" className="text-xs text-neutral-700">
            {preview.items.length} of {preview.total} will be imported
            {preview.skipped.length > 0 && `, ${preview.skipped.length} skipped`}.
          </p>

          {preview.skipped.length > 0 && (
            <ul data-testid="skipped" className="flex flex-col gap-1 text-xs text-neutral-600">
              {preview.skipped.map((entry) => (
                <li key={`${entry.row}-${entry.reason}`}>
                  Row {entry.row}: {entry.reason}
                </li>
              ))}
            </ul>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              data-testid="confirm"
              disabled={busy || preview.items.length === 0}
              onClick={confirm}
              className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40"
            >
              Import {preview.items.length}
            </button>
            <button
              type="button"
              data-testid="cancel"
              onClick={onCancel}
              className="rounded border border-neutral-300 px-2 py-1"
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
