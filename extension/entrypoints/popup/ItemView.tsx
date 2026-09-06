import { useState } from 'react';
import type { BrowserApi } from '../../src/autofill';
import type { VaultItem } from '../../src/vault/item';

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

  return (
    <main className="flex flex-col gap-3 p-4 font-sans text-sm">
      <button
        type="button"
        data-testid="back"
        onClick={onBack}
        className="self-start text-xs text-neutral-500 underline"
      >
        Back
      </button>

      <h1 data-testid="title" className="text-base font-semibold">
        {item.title}
      </h1>

      {item.kind === 'login' ? (
        <>
          <Field label="Site" value={item.host} testId="host" />
          <Field
            label="Username"
            value={item.username}
            testId="username"
            onCopy={() => copy('Username', item.username)}
          />

          <div className="flex flex-col gap-1">
            <span className="text-xs text-neutral-500">Password</span>
            <div className="flex items-center gap-2">
              <span data-testid="password" className="font-mono">
                {revealed ? item.password : '••••••••••'}
              </span>
              <button
                type="button"
                data-testid="reveal"
                onClick={() => setRevealed((r) => !r)}
                className="text-xs text-neutral-500 underline"
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
              {/* Copying does not reveal: the two are separate acts. */}
              <button
                type="button"
                data-testid="copy-password"
                onClick={() => copy('Password', item.password)}
                className="text-xs text-neutral-500 underline"
              >
                Copy
              </button>
            </div>
          </div>

          {browser !== undefined && (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                data-testid="fill"
                disabled={filling}
                onClick={fill}
                className="self-start rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-40"
              >
                Fill this page
              </button>
              {fillMessage !== null && (
                <p data-testid="fill-message" className="text-xs text-neutral-600">
                  {fillMessage}
                </p>
              )}
            </div>
          )}

          {item.notes !== undefined && <Field label="Notes" value={item.notes} testId="notes" />}
        </>
      ) : (
        <div className="flex flex-col gap-1">
          <span className="text-xs text-neutral-500">Note</span>
          <p data-testid="body" className="whitespace-pre-wrap">
            {item.body}
          </p>
        </div>
      )}

      {copied !== null && (
        <p data-testid="copied" className="text-xs text-neutral-500">
          {copied} copied.
        </p>
      )}

      <button
        type="button"
        data-testid="edit"
        onClick={onEdit}
        className="self-start rounded border border-neutral-300 px-2 py-1"
      >
        Edit
      </button>
    </main>
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
    <div className="flex flex-col gap-1">
      <span className="text-xs text-neutral-500">{label}</span>
      <div className="flex items-center gap-2">
        <span data-testid={testId} className="break-all">
          {value}
        </span>
        {onCopy !== undefined && (
          <button
            type="button"
            data-testid={`copy-${testId}`}
            onClick={onCopy}
            className="text-xs text-neutral-500 underline"
          >
            Copy
          </button>
        )}
      </div>
    </div>
  );
}
