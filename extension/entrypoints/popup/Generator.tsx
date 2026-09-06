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
    <section className="flex flex-col gap-3 p-4 font-sans text-sm">
      <h2 className="font-medium">Generate</h2>

      <div className="flex gap-2">
        {(['password', 'passphrase'] as const).map((option) => (
          <button
            key={option}
            type="button"
            data-testid={`mode-${option}`}
            onClick={() => {
              setMode(option);
              setValue(null);
            }}
            className={`rounded border px-2 py-1 ${
              mode === option
                ? 'border-neutral-900 bg-neutral-900 text-white'
                : 'border-neutral-300'
            }`}
          >
            {option}
          </button>
        ))}
      </div>

      {mode === 'password' ? (
        <div className="flex flex-col gap-2">
          <label className="flex items-center gap-2" htmlFor="gen-length">
            <span className="text-xs text-neutral-600">Length</span>
            <input
              id="gen-length"
              data-testid="length"
              type="range"
              min={8}
              max={64}
              value={length}
              onChange={(e) => setLength(Number(e.target.value))}
            />
            <span className="w-8 text-xs">{length}</span>
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              data-testid="symbols"
              checked={symbols}
              onChange={() => setSymbols((s) => !s)}
            />
            <span className="text-xs text-neutral-600">Include symbols</span>
          </label>
        </div>
      ) : (
        <label className="flex items-center gap-2" htmlFor="gen-words">
          <span className="text-xs text-neutral-600">Words</span>
          <input
            id="gen-words"
            data-testid="words"
            type="range"
            min={4}
            max={16}
            value={words}
            onChange={(e) => setWords(Number(e.target.value))}
          />
          <span className="w-8 text-xs">{words}</span>
        </label>
      )}

      <p data-testid="entropy" className="text-xs text-neutral-600">
        {bits} bits of entropy
        {bits < TARGET_BITS && ' — short of the 80 this aims for'}
      </p>

      <div className="flex gap-2">
        <button
          type="button"
          data-testid="generate"
          onClick={generate}
          className="rounded bg-neutral-900 px-2 py-1 text-white"
        >
          {value === null ? 'Generate' : 'Again'}
        </button>
        {value !== null && (
          <button
            type="button"
            data-testid="use"
            onClick={() => onUse(value)}
            className="rounded border border-neutral-300 px-2 py-1"
          >
            Use this
          </button>
        )}
      </div>

      {value !== null && (
        <code data-testid="value" className="rounded bg-neutral-100 p-2 text-xs break-all">
          {value}
        </code>
      )}
    </section>
  );
}
