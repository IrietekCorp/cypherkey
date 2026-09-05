import { useRef, useState } from 'react';
import { RhythmLight } from '../../src/components/RhythmLight';
import { preventFocusSteal, useCapture } from '../../src/components/useCapture';

/**
 * The popup shell. Screens land here in order: Onboarding (M2-03), Recovery Kit
 * (M2-04), Enrollment (M2-05), Unlock (M2-07), Vault (M2-08).
 *
 * Until then this exercises M2-02 so the X-1 guarantee can be checked by hand: hide the
 * light and capture refuses, on screen, rather than failing quietly or throwing.
 */
export function App() {
  const input = useRef<HTMLInputElement>(null);
  const light = useRef<HTMLDivElement>(null);
  const [hidden, setHidden] = useState(false);
  const [script, setScript] = useState<string | null>(null);
  const capture = useCapture();

  const begin = () => {
    if (input.current !== null && light.current !== null) {
      setScript(null);
      capture.start(input.current, light.current);
    }
  };

  return (
    <main className="flex flex-col gap-3 p-4 font-sans text-sm">
      <h1 className="text-base font-semibold">CypherKey</h1>

      <label className="flex flex-col gap-1">
        <span className="text-xs text-neutral-600">Type anything to see the light work</span>
        <input
          ref={input}
          type="password"
          onFocus={begin}
          className="rounded border border-neutral-300 px-2 py-1"
        />
      </label>

      <div style={hidden ? { display: 'none' } : undefined}>
        <RhythmLight ref={light} state={capture.state} />
      </div>

      <div className="flex items-center gap-2">
        {/* preventFocusSteal: without it, this click blurs the input, which voids the
            sample the click is meant to submit. */}
        <button
          type="button"
          onMouseDown={preventFocusSteal}
          onClick={() => setScript(capture.stop()?.script ?? null)}
          className="rounded bg-neutral-900 px-2 py-1 text-white"
        >
          Done
        </button>
        <button
          type="button"
          onClick={() => {
            capture.reset();
            setScript(null);
            setHidden((h) => !h);
          }}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          {hidden ? 'Show the light' : 'Hide the light'}
        </button>
      </div>

      {script !== null && (
        <p className="text-xs text-neutral-600">
          Captured {[...script].length} keystrokes. Nothing left this popup.
        </p>
      )}
    </main>
  );
}
