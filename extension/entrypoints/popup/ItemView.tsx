import { useMemo, useState } from 'react';
import type { BrowserApi } from '../../src/autofill';
import type { VaultItem } from '../../src/vault/item';
import { itemMark } from '../../src/vault/mark';

export type ItemViewProps = {
  item: VaultItem;
  onEdit(): void;
  onBack(): void;
  /**
   * Absent when the extension APIs are not there — the options page, a test. Autofill
   * is then simply not offered rather than offered and broken.
   */
  browser?: BrowserApi;
};

/**
 * One item, read-only.
 *
 * The password is masked until asked for, and revealing it is a deliberate act rather
 * than the default — a popup sits over whatever page is open, often in a shared room
 * or on a shared screen. Copying does not reveal.
 */
export function ItemView({ item, onEdit, onBack, browser }: ItemViewProps) {
  const [revealed, setRevealed] = useState(false);
  const mark = useMemo(() => itemMark(item), [item]);
  const [copied, setCopied] = useState<string | null>(null);
  const [fillMessage, setFillMessage] = useState<string | null>(null);
  const [filling, setFilling] = useState(false);

  /**
   * The decision is made here, in the popup, before anything is injected. A page on
   * the wrong host never receives the script at all.
   */
  const fill = async () => {
    if (browser === undefined || item.kind !== 'login') return;
    setFilling(true);
    try {
      /**
       * Loaded on demand, not on import. `decideFill` needs the public suffix list,
       * which is ~250 KB gzipped — and it belongs to the one action that needs it, not
       * to every popup open. Importing it eagerly took the popup from 106 KB to
       * 216 KB and broke the A-15 budget, which is how this was noticed.
       */
      const { autofillActiveTab, outcomeMessage } = await import('../../src/autofill');
      const outcome = await autofillActiveTab(browser, item.host, {
        username: item.username,
        password: item.password,
      });
      setFillMessage(outcomeMessage(outcome, item.host));
    } finally {
      setFilling(false);
    }
  };

  const copy = async (label: string, value: string) => {
    await navigator.clipboard?.writeText(value);
    setCopied(label);
  };

  /*
    Frame 11.

    Every row is the same object: a bordered card, the label above the value, the action
    on the right. Reveal is a round icon button and Copy stays worded, and the two are
    never merged -- copying is a thing you do without looking, revealing is a thing you do
    when nobody is behind you, and one button for both makes the safer act the harder one.
  */
  return (
    <main className="ck-app flex flex-col" style={{ padding: 'var(--ck-s4)', gap: 'var(--ck-s4)' }}>
      <header className="flex items-center justify-between" style={{ gap: 'var(--ck-s2)' }}>
        <button
          type="button"
          data-testid="back"
          onClick={onBack}
          className="btn btn-ghost ck-small"
        >
          ← Vault
        </button>
        <button
          type="button"
          data-testid="edit"
          onClick={onEdit}
          className="btn btn-secondary ck-small"
        >
          Edit
        </button>
      </header>

      <div className="flex items-center" style={{ gap: 'var(--ck-s3)' }}>
        <span
          aria-hidden="true"
          className="grid shrink-0 place-items-center"
          style={{
            width: 32,
            height: 32,
            borderRadius: 'var(--ck-r-md)',
            fontSize: 12,
            fontWeight: 500,
            background: mark.kind === 'login' ? 'var(--ck-accent-900)' : 'var(--ck-inset)',
            color: mark.kind === 'login' ? 'var(--ck-accent-300)' : 'var(--ck-muted)',
            border: `1px solid ${mark.kind === 'login' ? 'var(--ck-accent-700)' : 'var(--ck-border)'}`,
          }}
        >
          {mark.initials}
        </span>
        <div className="flex min-w-0 flex-col">
          <h1 data-testid="title" className="ck-h1 truncate">
            {item.title}
          </h1>
          {item.kind === 'login' && (
            <span data-testid="host" className="ck-small ck-muted truncate">
              {item.host}
            </span>
          )}
        </div>
      </div>

      {item.kind === 'login' ? (
        <>
          <Field
            label="Username"
            value={item.username}
            testId="username"
            onCopy={() => copy('Username', item.username)}
          />

          <div className="card flex flex-col" style={{ gap: 'var(--ck-s2)' }}>
            <span className="ck-small ck-muted">Password</span>
            <div className="flex items-center" style={{ gap: 'var(--ck-s2)' }}>
              <span data-testid="password" className="font-mono flex-1 break-all">
                {revealed ? item.password : '••••••••••••••••'}
              </span>
              <button
                type="button"
                data-testid="reveal"
                aria-label={revealed ? 'Hide password' : 'Reveal password'}
                onClick={() => setRevealed((r) => !r)}
                className="btn btn-icon"
              >
                {revealed ? <EyeOff /> : <Eye />}
              </button>
              {/* Copying does not reveal: the two are separate acts. */}
              <button
                type="button"
                data-testid="copy-password"
                onClick={() => copy('Password', item.password)}
                className="btn btn-secondary ck-small"
              >
                Copy
              </button>
            </div>
            <p className="ck-small ck-muted">
              Copying doesn’t reveal it. Last changed {changed(item.updatedAt)}.
            </p>
          </div>

          {item.notes !== undefined && <Field label="Notes" value={item.notes} testId="notes" />}

          {browser !== undefined && (
            <div className="flex flex-col" style={{ gap: 'var(--ck-s2)' }}>
              <button
                type="button"
                data-testid="fill"
                disabled={filling}
                onClick={fill}
                className="btn btn-primary btn-block"
              >
                Fill this page
              </button>
              {fillMessage !== null && (
                <p data-testid="fill-message" className="ck-small ck-muted">
                  {fillMessage}
                </p>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="card flex flex-col" style={{ gap: 'var(--ck-s2)' }}>
          <span className="ck-small ck-muted">Note</span>
          <p data-testid="body" className="whitespace-pre-wrap">
            {item.body}
          </p>
        </div>
      )}

      {copied !== null && (
        <p data-testid="copied" className="ck-small" style={{ color: 'var(--ck-accent-300)' }}>
          {copied} copied.
        </p>
      )}
    </main>
  );
}

/** When the entry last changed, in the words a person would use. */
function changed(updatedAt: number): string {
  const days = Math.floor((Date.now() - updatedAt) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(updatedAt).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
}

function Eye() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Reveal</title>
      <path
        d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.6" />
    </svg>
  );
}

function EyeOff() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <title>Hide</title>
      <path
        d="M3 3l18 18M10.6 10.7a3 3 0 0 0 4.2 4.2M9.9 5.2A9.8 9.8 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.3 6.4A17 17 0 0 0 2 12s3.5 7 10 7c1.4 0 2.6-.3 3.7-.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Field({
  label,
  value,
  testId,
  onCopy,
}: {
  label: string;
  value: string;
  testId: string;
  onCopy?: () => void;
}) {
  return (
    <div className="card flex flex-col" style={{ gap: 'var(--ck-s2)' }}>
      <span className="ck-small ck-muted">{label}</span>
      <div className="flex items-center" style={{ gap: 'var(--ck-s2)' }}>
        <span data-testid={testId} className="flex-1 break-all whitespace-pre-wrap">
          {value}
        </span>
        {onCopy !== undefined && (
          <button
            type="button"
            data-testid={`copy-${testId}`}
            onClick={onCopy}
            className="btn btn-secondary ck-small"
          >
            Copy
          </button>
        )}
      </div>
    </div>
  );
}
