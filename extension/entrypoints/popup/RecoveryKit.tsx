import { useMemo, useRef, useState } from 'react';
import '../../src/print.css';

/**
 * The sentence that has to survive onto paper. Someone reading the sheet years later
 * has only what is printed on it, and discovering this at the next login is too late.
 */
export const AUTHENTICATOR_WARNING =
  'If you ever use this Kit, your authenticator app will need to be set up again. Your Backup Codes will still work.';

/** M2-00f: recovery retires the Kit it was given and issues this one. */
export const REPLACEMENT_WARNING = 'The old one no longer works — save this one now.';

/** How many characters the user must read back to prove the Kit was saved. */
export const CONFIRM_COUNT = 4;

/**
 * The Kit as a file, carrying everything the printed sheet carried.
 *
 * Whoever opens this has nothing else -- possibly years later, possibly after losing
 * every device -- so the consequences travel with the code rather than living in a UI
 * they will never see again.
 */
export function kitFileContents(
  recoveryCode: string,
  backupCodes: string[],
  variant: 'signup' | 'replacement' = 'signup',
): string {
  const lines = [
    'CypherKey Recovery Kit',
    '',
    recoveryCode,
    '',
    'This Kit is the only way back into your vault if you forget your passphrase or',
    'lose every device. It is not kept on our servers and cannot be re-sent.',
    '',
    AUTHENTICATOR_WARNING,
  ];
  if (variant === 'replacement') lines.push('', REPLACEMENT_WARNING);
  if (backupCodes.length > 0) {
    lines.push(
      '',
      'Backup Codes',
      'Ten one-time codes. Each one gets you past a rhythm check when your typing does',
      'not match -- they open a session, not your vault.',
      '',
      ...backupCodes,
    );
  }
  lines.push(
    '',
    '---',
    'This file is plain text. Anyone who reads it can recover your vault, so print it',
    'or write it down, then delete the file.',
    '',
  );
  return lines.join('\n');
}

/**
 * The Kit's symbols with formatting removed, so a position refers to what the user
 * counts on the sheet rather than to an index into a hyphenated string.
 */
export function kitSymbols(code: string): string[] {
  return [...code.replace(/-/g, '')];
}

/**
 * Crockford's aliases, so reading `0` where the sheet shows `O` is not a failure. The
 * Kit alphabet excludes I, L, O and U precisely so this is unambiguous.
 */
function normalizeSymbol(raw: string): string {
  const upper = raw.trim().toUpperCase();
  if (upper === 'O') return '0';
  if (upper === 'I' || upper === 'L') return '1';
  return upper;
}

/**
 * Picks the positions to ask about.
 *
 * Four characters rather than a full retype: it proves the sheet was saved without
 * training anyone to type their Recovery Kit into a screen, which is the habit a
 * phishing page would exploit.
 */
export function pickPositions(
  symbolCount: number,
  count = CONFIRM_COUNT,
  random: () => number = Math.random,
): number[] {
  const chosen = new Set<number>();
  while (chosen.size < Math.min(count, symbolCount)) {
    chosen.add(Math.floor(random() * symbolCount));
  }
  return [...chosen].sort((a, b) => a - b);
}

/** True when every answer matches the symbol at its position. */
export function checkAnswers(code: string, positions: number[], answers: string[]): boolean {
  const symbols = kitSymbols(code);
  if (answers.length !== positions.length) return false;
  return positions.every((position, i) => {
    const expected = symbols[position];
    const given = answers[i];
    if (expected === undefined || given === undefined) return false;
    return normalizeSymbol(given) === normalizeSymbol(expected);
  });
}

export type RecoveryKitProps = {
  recoveryCode: string;
  /** X-3's ten one-time codes. Shown once, here. Never called "recovery codes". */
  backupCodes?: string[];
  /** `replacement` is the post-recovery variant, where an older Kit has just died. */
  variant?: 'signup' | 'replacement';
  onConfirmed(): void;
};

export function RecoveryKit({
  recoveryCode,
  backupCodes,
  variant = 'signup',
  onConfirmed,
}: RecoveryKitProps) {
  const symbols = useMemo(() => kitSymbols(recoveryCode), [recoveryCode]);
  const positions = useMemo(() => pickPositions(symbols.length), [symbols.length]);
  const answers = useRef<Array<HTMLInputElement | null>>([]);
  const [error, setError] = useState<string | null>(null);

  const saveKit = () => {
    const blob = new Blob([kitFileContents(recoveryCode, backupCodes ?? [], variant)], {
      type: 'text/plain',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'cypherkey-recovery-kit.txt';
    link.click();
    // Revoked on the next tick: revoking synchronously after click() cancels the
    // download in some builds, and a live blob URL keeps the Kit in memory.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  };

  const confirm = () => {
    const given = positions.map((_, i) => answers.current[i]?.value ?? '');
    if (checkAnswers(recoveryCode, positions, given)) {
      setError(null);
      onConfirmed();
      return;
    }
    setError('That does not match the Kit. Check the sheet and try again.');
  };

  return (
    <main className="ck-app flex flex-col" style={{ padding: 'var(--ck-s5)', gap: 'var(--ck-s4)' }}>
      {/* Frames 03 and 04, on one screen: the sheet, then the proof it was saved. */}
      <header className="flex items-baseline justify-between" style={{ gap: 'var(--ck-s3)' }}>
        <span className="ck-wordmark ck-small ck-muted">CypherKey</span>
        <span className="ck-small ck-muted">Shown once</span>
      </header>

      <div className="flex flex-col" style={{ gap: 'var(--ck-s1)' }}>
        <h1 className="ck-h1">
          {variant === 'replacement' ? 'Your new Recovery Kit' : 'Your Recovery Kit'}
        </h1>
        <p className="ck-small ck-muted">
          This is the only way back in if you lose every device. We show it once and never again.
        </p>
      </div>

      {/* The printable sheet. Everything the reader will ever have about it. */}
      <section className="print-kit card flex flex-col" style={{ gap: 'var(--ck-s3)' }}>
        {/*
          "Your Kit", never "recovery code". The two are different objects and the
          vocabulary is load-bearing: a Backup Code opens one session, the Kit opens the
          vault and re-keys the account. `RecoveryKit.test.tsx` asserts the phrase never
          appears here.
        */}
        <h2 className="ck-small ck-muted" style={{ letterSpacing: '0.06em' }}>
          Your Kit · {symbols.length} characters
        </h2>
        <p
          data-testid="kit-code"
          className="kit-code font-mono break-all"
          style={{ fontSize: 15, lineHeight: 1.5, letterSpacing: '0.04em' }}
        >
          {recoveryCode}
        </p>
        <div
          className="kit-consequences ck-small ck-muted flex flex-col"
          style={{ gap: 'var(--ck-s2)' }}
        >
          <p>
            This Kit is the only way back into your vault if you forget your passphrase or lose
            every device. Store it somewhere physical. It is not kept on our servers and cannot be
            re-sent.
          </p>
          <p data-testid="authenticator-warning">{AUTHENTICATOR_WARNING}</p>
          {variant === 'replacement' && (
            <p data-testid="replacement-warning">{REPLACEMENT_WARNING}</p>
          )}
        </div>

        {backupCodes !== undefined && backupCodes.length > 0 && (
          <div
            className="flex flex-col"
            style={{
              gap: 'var(--ck-s2)',
              paddingTop: 'var(--ck-s3)',
              borderTop: '1px solid var(--ck-border)',
            }}
          >
            <h3 className="ck-small ck-muted" style={{ letterSpacing: '0.06em' }}>
              Backup Codes · {backupCodes.length}
            </h3>
            <p className="ck-small ck-muted">
              One-time codes. Each one gets you past a rhythm check when your typing does not match
              — they open a session, not your vault.
            </p>
            <ul
              data-testid="backup-codes"
              className="ck-small grid font-mono"
              style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 'var(--ck-s1)' }}
            >
              {backupCodes.map((code) => (
                <li key={code}>{code}</li>
              ))}
            </ul>
          </div>
        )}
      </section>

      <div className="no-print flex flex-col" style={{ gap: 'var(--ck-s3)' }}>
        {/*
          A download, not `window.print()`.

          Printing from an MV3 popup does nothing: the print dialog takes focus, the
          popup closes because it lost focus, and the print is cancelled with no error.
          The button sat there looking functional and doing nothing at all -- on the one
          screen whose whole job is making sure the user keeps a copy.

          A blob download works from a popup and needs no permission. It does put the
          Kit on disk in plain text, which the file itself says, along with what to do
          about it.
        */}
        <div className="flex flex-col" style={{ gap: 'var(--ck-s1)' }}>
          <button
            type="button"
            data-testid="save-kit"
            onClick={saveKit}
            className="btn btn-secondary btn-block"
          >
            Save this Kit as a file
          </button>
          <p className="ck-small ck-muted">
            Saves a plain-text file to your downloads. Print it or write it down, then delete the
            file — anyone who reads it can recover your vault.
          </p>
        </div>

        <div
          className="flex flex-col"
          style={{
            gap: 'var(--ck-s3)',
            paddingTop: 'var(--ck-s3)',
            borderTop: '1px solid var(--ck-border)',
          }}
        >
          <div className="flex flex-col" style={{ gap: 'var(--ck-s1)' }}>
            <h2 className="ck-h2">Prove you saved it</h2>
            <p className="ck-small ck-muted">
              Type the characters at these positions. Read them off the sheet, not the screen. The
              dashes are not counted.
            </p>
          </div>

          {/*
            The Kit again, with every character's position under it.

            Asking someone to find "character 15" of a 33-symbol code was a counting
            exercise the layout worked against: the sheet groups the code with dashes, the
            positions ignore dashes, nothing said so, and `break-all` rewraps the whole
            thing at popup width. A real first user answered two of four with the symbols
            four places along -- the code was saved correctly and the check said it was
            not, which is the one failure this screen must never produce.

            Screen-only. The printed sheet keeps the plain grouped code, because a ruler of
            index numbers is noise on paper and this prompt is not printed at all.
          */}
          <div data-testid="position-ruler" className="flex flex-wrap font-mono" style={{ gap: 2 }}>
            {symbols.map((symbol, index) => {
              const asked = positions.includes(index);
              return (
                <span
                  key={`${index}-${symbol}`}
                  className="flex flex-col items-center text-center"
                  style={{
                    width: 20,
                    borderRadius: 'var(--ck-r-sm)',
                    // Amber marks the four being asked for -- the same colour the amber
                    // band uses, and the only place on this screen colour means anything.
                    background: asked
                      ? 'color-mix(in srgb, var(--ck-amber) 16%, transparent)'
                      : 'transparent',
                    color: asked ? 'var(--ck-amber-text)' : 'var(--ck-muted)',
                    fontWeight: asked ? 500 : 400,
                  }}
                >
                  <span style={{ fontSize: 13, lineHeight: 1.2 }}>{symbol}</span>
                  <span className="ck-num" style={{ fontSize: 9, lineHeight: 1.2, opacity: 0.75 }}>
                    {index + 1}
                  </span>
                </span>
              );
            })}
          </div>

          <div className="flex" style={{ gap: 'var(--ck-s2)' }}>
            {positions.map((position, i) => (
              <label key={position} className="flex flex-col items-center" style={{ gap: 2 }}>
                <span data-testid="position-label" className="ck-small ck-muted ck-num">
                  #{position + 1}
                </span>
                <input
                  ref={(node) => {
                    answers.current[i] = node;
                  }}
                  data-testid={`answer-${i}`}
                  maxLength={1}
                  className="input text-center font-mono uppercase"
                  style={{ width: 34, paddingInline: 0 }}
                />
              </label>
            ))}
          </div>

          {error !== null && (
            <p data-testid="error" className="ck-small" style={{ color: 'var(--ck-fail-text)' }}>
              {error}
            </p>
          )}

          <button
            type="button"
            data-testid="confirm"
            onClick={confirm}
            className="btn btn-primary btn-block"
          >
            I have saved my Kit
          </button>
        </div>
      </div>
    </main>
  );
}
