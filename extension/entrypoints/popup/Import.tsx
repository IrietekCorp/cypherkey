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
    <main className="ck-app flex flex-col" style={{ padding: 'var(--ck-s5)', gap: 'var(--ck-s4)' }}>
      {/* Frame 14. */}
      <div className="flex flex-col" style={{ gap: 'var(--ck-s1)' }}>
        <h1 className="ck-h1">Import</h1>
        <p className="ck-small ck-muted">
          Your export is read here and never saved. Delete the file once you are done — it holds
          every password in plain text.
        </p>
      </div>

      <div className="seg self-start">
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
            aria-pressed={format === value}
            onClick={() => {
              setFormat(value);
              setPreview(null);
              setError(null);
            }}
            className="seg-opt ck-small"
          >
            {label}
          </button>
        ))}
      </div>

      <label className="field">
        <span>Export file</span>
        <input ref={file} type="file" data-testid="file" className="input ck-small" />
      </label>

      <button
        type="button"
        data-testid="read"
        onClick={read}
        className="btn btn-secondary self-start"
      >
        Read the file
      </button>

      {error !== null && (
        <p data-testid="error" className="ck-small" style={{ color: 'var(--ck-fail-text)' }}>
          {error}
        </p>
      )}

      {preview !== null && (
        <section className="card flex flex-col" style={{ gap: 'var(--ck-s3)' }}>
          <p data-testid="summary" className="ck-h2 ck-num">
            {preview.items.length} of {preview.total} will be imported
            {preview.skipped.length > 0 && `, ${preview.skipped.length} skipped`}.
          </p>

          {preview.skipped.length > 0 && (
            <ul
              data-testid="skipped"
              className="ck-small ck-muted flex flex-col"
              style={{ gap: 'var(--ck-s1)' }}
            >
              {preview.skipped.map((entry) => (
                <li key={`${entry.row}-${entry.reason}`}>
                  Row {entry.row}: {entry.reason}
                </li>
              ))}
            </ul>
          )}

          <div className="flex" style={{ gap: 'var(--ck-s2)' }}>
            <button
              type="button"
              data-testid="confirm"
              disabled={busy || preview.items.length === 0}
              onClick={confirm}
              className="btn btn-primary"
              style={{ flex: 1 }}
            >
              Import {preview.items.length}
            </button>
            <button
              type="button"
              data-testid="cancel"
              onClick={onCancel}
              className="btn btn-secondary"
            >
              Cancel
            </button>
          </div>
        </section>
      )}
    </main>
  );
}
