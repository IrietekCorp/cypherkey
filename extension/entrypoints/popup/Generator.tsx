import { useState } from 'react';
import {
  type CharacterOptions,
  entropyBits,
  generatePassphrase,
  generatePassword,
  wordsForBits,
} from '../../src/generator';

/** 80 bits: ten words, or sixteen mixed characters. Comfortably past brute force. */
const TARGET_BITS = 80;

export type GeneratorProps = {
  /** Puts the value into the field being edited. */
  onUse(value: string): void;
};

type Mode = 'password' | 'passphrase';

/**
 * The generator.
 *
 * It states the entropy rather than colouring a bar. A green bar tells the user they
 * did well; a number tells them what an attacker faces, and is the only claim we can
 * actually stand behind for a value we generated ourselves.
 */
export function Generator({ onUse }: GeneratorProps) {
  const [mode, setMode] = useState<Mode>('password');
  const [length, setLength] = useState(20);
  const [words, setWords] = useState(wordsForBits(TARGET_BITS));
  const [symbols, setSymbols] = useState(true);
  const [value, setValue] = useState<string | null>(null);

  const options: CharacterOptions = { length, symbols };
  const bits =
    mode === 'password' ? entropyBits('password', options) : entropyBits('passphrase', { words });

  const generate = () => {
    setValue(mode === 'password' ? generatePassword(options) : generatePassphrase({ words }));
  };

  return (
    <section
      className="card flex flex-col"
      style={{ gap: 'var(--ck-s3)', background: 'var(--ck-inset)' }}
    >
      {/* Frame 13. Inline in the edit screen, so it is a panel rather than a page. */}
      <div className="flex items-center justify-between" style={{ gap: 'var(--ck-s3)' }}>
        <h2 className="ck-h2">Generate</h2>
        <div className="seg">
          {(['password', 'passphrase'] as const).map((option) => (
            <button
              key={option}
              type="button"
              data-testid={`mode-${option}`}
              aria-pressed={mode === option}
              onClick={() => {
                setMode(option);
                setValue(null);
              }}
              className="seg-opt ck-small"
            >
              {option}
            </button>
          ))}
        </div>
      </div>

      {mode === 'password' ? (
        <div className="flex flex-col" style={{ gap: 'var(--ck-s2)' }}>
          <label className="flex items-center" style={{ gap: 'var(--ck-s3)' }} htmlFor="gen-length">
            <span className="ck-small ck-muted">Length</span>
            <input
              id="gen-length"
              data-testid="length"
              type="range"
              min={8}
              max={64}
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
              className="flex-1"
              style={{ accentColor: 'var(--ck-accent)' }}
            />
            <span className="ck-small ck-num" style={{ width: 22, textAlign: 'right' }}>
              {length}
            </span>
          </label>
          <label className="flex items-center" style={{ gap: 'var(--ck-s3)' }}>
            <input
              type="checkbox"
              data-testid="symbols"
              checked={symbols}
              onChange={() => setSymbols((s) => !s)}
              style={{ accentColor: 'var(--ck-accent)' }}
            />
            <span className="ck-small ck-muted">Include symbols</span>
          </label>
        </div>
      ) : (
        <label className="flex items-center" style={{ gap: 'var(--ck-s3)' }} htmlFor="gen-words">
          <span className="ck-small ck-muted">Words</span>
          <input
            id="gen-words"
            data-testid="words"
            type="range"
            min={4}
            max={16}
            value={words}
            onChange={(e) => setWords(Number(e.target.value))}
            className="flex-1"
            style={{ accentColor: 'var(--ck-accent)' }}
          />
          <span className="ck-small ck-num" style={{ width: 22, textAlign: 'right' }}>
            {words}
          </span>
        </label>
      )}

      {value !== null && (
        <code
          data-testid="value"
          className="ck-small font-mono break-all"
          style={{
            padding: 'var(--ck-s3)',
            borderRadius: 'var(--ck-r-md)',
            border: '1px solid var(--ck-border)',
            background: 'var(--ck-surface)',
          }}
        >
          {value}
        </code>
      )}

      {/*
        Entropy, not a strength meter. It is a property of how the string was made, which
        this screen knows exactly -- not a guess at how hard it would be to crack.
      */}
      <p data-testid="entropy" className="ck-small ck-muted ck-num">
        {bits} bits of entropy
        {bits < TARGET_BITS && ' — short of the 80 this aims for'}
      </p>

      <div className="flex" style={{ gap: 'var(--ck-s2)' }}>
        <button
          type="button"
          data-testid="generate"
          onClick={generate}
          className="btn btn-secondary"
          style={{ flex: 1 }}
        >
          {value === null ? 'Generate' : 'Again'}
        </button>
        {value !== null && (
          <button
            type="button"
            data-testid="use"
            onClick={() => onUse(value)}
            className="btn btn-primary"
            style={{ flex: 1 }}
          >
            Use this
          </button>
        )}
      </div>
    </section>
  );
}
