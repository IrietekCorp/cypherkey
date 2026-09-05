import type { CaptureState } from './useCapture';

export type RhythmLightProps = {
  state: CaptureState;
  /** Set once a score exists, so the light can show the band (X-1, A-4.4). */
  band?: 'pass' | 'grey' | 'fail';
  /** The element `startCapture` checks for visibility. */
  ref?: React.Ref<HTMLDivElement>;
};

const BAND_CLASS = {
  pass: 'bg-emerald-500',
  grey: 'bg-amber-500',
  fail: 'bg-rose-500',
} as const;

/**
 * X-1's consent signal, made legible.
 *
 * The component does not decide whether capture may run — `startCapture` does that, and
 * refuses without a visible light. What this does is make the refusal, the pulse and
 * every cancellation something the user can see and act on.
 *
 * It must never be hidden to "clean up" a screen: hiding it does not disable capture
 * quietly, it stops capture entirely.
 */
export function RhythmLight({ state, band, ref }: RhythmLightProps) {
  const capturing = state.status === 'capturing';
  const pulses = capturing ? state.pulses : 0;

  const dotClass =
    band !== undefined
      ? BAND_CLASS[band]
      : capturing
        ? 'bg-sky-500'
        : state.status === 'cancelled' || state.status === 'unavailable'
          ? 'bg-neutral-400'
          : 'bg-neutral-300';

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <div
          ref={ref}
          data-testid="rhythm-light"
          data-pulses={pulses}
          className={`h-3 w-3 rounded-full transition-opacity ${dotClass}`}
          style={{ opacity: capturing && pulses % 2 === 1 ? 0.55 : 1 }}
        />
        <span className="text-xs text-neutral-600">{label(state, band)}</span>
      </div>

      {/*
        `<output>` carries role="status" implicitly, which is what a screen reader needs
        here. The light itself is deliberately NOT a live region: announcing one pulse
        per keystroke would read the passphrase's length aloud.
      */}
      <output aria-live="polite" className="text-xs text-neutral-700">
        {message(state)}
      </output>
    </div>
  );
}

function label(state: CaptureState, band?: 'pass' | 'grey' | 'fail'): string {
  if (band === 'pass') return 'Rhythm matched';
  if (band === 'grey') return 'Rhythm looks different';
  if (band === 'fail') return 'Rhythm did not match';
  if (state.status === 'capturing') return 'Recording your rhythm';
  if (state.status === 'unavailable') return 'Not recording';
  return 'Ready';
}

function message(state: CaptureState): string {
  if (state.status === 'cancelled' || state.status === 'unavailable') return state.message;
  if (state.status === 'capturing') {
    // Stating it outright is the point of X-1: the user should never have to infer it.
    return 'Your typing rhythm is being measured while this light is on.';
  }
  return '';
}
