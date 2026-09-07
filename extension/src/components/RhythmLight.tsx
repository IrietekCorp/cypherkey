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
        : state.status === 'done'
          ? 'bg-emerald-500'
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

/**
 * The four states a person can actually be in, named the way they expect.
 *
 * This used to answer 'Ready' for idle, cancelled *and* done, so the label said the
 * same thing before the field was focused, after a sample was captured, and after one
 * was thrown away. "Ready" while nothing is armed is worse than uninformative: it
 * claims the opposite of the truth.
 *
 * Idle → nothing is armed. Ready → armed, waiting for the first keystroke.
 * Recording → keystrokes are arriving. Captured → a sample was taken.
 */
function label(state: CaptureState, band?: 'pass' | 'grey' | 'fail'): string {
  if (band === 'pass') return 'Rhythm matched';
  if (band === 'grey') return 'Rhythm looks different';
  if (band === 'fail') return 'Rhythm did not match';
  if (state.status === 'unavailable') return 'Not recording';
  if (state.status === 'capturing') {
    return state.pulses === 0 ? 'Ready' : 'Recording your rhythm';
  }
  if (state.status === 'done') return 'Captured';
  if (state.status === 'cancelled') return 'Discarded';
  return 'Idle';
}

function message(state: CaptureState): string {
  if (state.status === 'cancelled') {
    // The detail names the key and the condition. It is derived from the script, never
    // from timings, so it reveals nothing a script-length error would not already.
    return state.detail === undefined ? state.message : `${state.message} (${state.detail})`;
  }
  if (state.status === 'unavailable') return state.message;
  if (state.status === 'capturing') {
    // Stating it outright is the point of X-1: the user should never have to infer it.
    return state.pulses === 0
      ? 'Your typing rhythm will be measured while this light is on. Start typing.'
      : `Your typing rhythm is being measured while this light is on. ${state.pulses} ${
          state.pulses === 1 ? 'keystroke' : 'keystrokes'
        } so far.`;
  }
  // A silent success is indistinguishable from nothing having happened, which is how a
  // voided sample and a good one came to look the same on screen.
  if (state.status === 'done') {
    const strokes = state.events.filter((e) => e.type === 'down').length;
    return `Captured — ${strokes} ${strokes === 1 ? 'key' : 'keys'} recorded.`;
  }
  return '';
}
