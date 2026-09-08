import type { CaptureState } from './useCapture';

export type RhythmLightProps = {
  state: CaptureState;
  /** Set once a score exists, so the light can show the band (X-1, A-4.4). */
  band?: 'pass' | 'grey' | 'fail';
  /** The element `startCapture` checks for visibility. */
  ref?: React.Ref<HTMLDivElement>;
};

/** The seven states of §06, as the data attribute the stylesheet keys off. */
type LightState = 'idle' | 'ready' | 'recording' | 'captured' | 'matched' | 'amber' | 'fail';

/**
 * X-1's consent signal, made legible.
 *
 * The component does not decide whether capture may run — `startCapture` does that, and
 * refuses without a visible light. What this does is make the refusal, the pulse and
 * every cancellation something the user can see and act on.
 *
 * It must never be hidden to "clean up" a screen: hiding it does not disable capture
 * quietly, it stops capture entirely.
 *
 * Form A, Concentric: four bars inside two rings, with a third ring leaving the mark on
 * every keystroke. The geometry lives in `design/rhythm-light.css` and is fixed by the
 * style guide, not by this file.
 */
export function RhythmLight({ state, band, ref }: RhythmLightProps) {
  const capturing = state.status === 'capturing';
  const pulses = capturing ? state.pulses : 0;
  const light = resolveState(state, band);
  const running = light === 'ready' || light === 'recording';

  return (
    <div className="flex items-center gap-[8.4px]">
      <div
        ref={ref}
        data-testid="rhythm-light"
        data-pulses={pulses}
        data-state={light}
        data-running={running ? 'true' : 'false'}
        className="ck-light"
      >
        {light === 'matched' ? (
          <span className="ck-light-check">
            <CheckMark />
          </span>
        ) : (
          <span className="ck-light-bars">
            <i />
            <i />
            <i />
            <i />
          </span>
        )}
        <Pulses count={pulses} />
      </div>

      <div className="flex min-w-0 flex-col">
        <span className="ck-h2">{label(state, band)}</span>
        {/*
          `<output>` carries role="status" implicitly, which is what a screen reader needs
          here. The light itself is deliberately NOT a live region: announcing one pulse
          per keystroke would read the passphrase's length aloud.
        */}
        <output aria-live="polite" className="ck-small ck-muted">
          {message(state)}
        </output>
      </div>
    </div>
  );
}

/**
 * One ring per keystroke, keyed on the count so React mounts a fresh element each time.
 *
 * Reusing one node and restarting its animation means reading back layout to force a
 * reflow; a keyed element that unmounts on the next pulse gets the same effect from the
 * renderer. Only the most recent is ever on screen, so this cannot accumulate.
 */
function Pulses({ count }: { count: number }) {
  if (count === 0) return null;
  return <span key={count} className="ck-light-pulse" />;
}

function CheckMark() {
  return (
    <svg width="10" height="10" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <title>Matched</title>
      <path
        d="M3.5 8.5 6.5 11.5 12.5 5"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** The band wins when there is one: a score has been returned and it is the news. */
function resolveState(state: CaptureState, band?: 'pass' | 'grey' | 'fail'): LightState {
  if (band === 'pass') return 'matched';
  // "Grey" in the code and the docs, "amber" in the UI. The guide keeps both names.
  if (band === 'grey') return 'amber';
  if (band === 'fail') return 'fail';
  if (state.status === 'unavailable') return 'idle';
  if (state.status === 'capturing') return state.pulses === 0 ? 'ready' : 'recording';
  if (state.status === 'done') return 'captured';
  return 'idle';
}

/**
 * The four states a person can actually be in, named the way they expect.
 *
 * This used to answer 'Ready' for idle, cancelled *and* done, so the label said the
 * same thing before the field was focused, after a sample was captured, and after one
 * was thrown away. "Ready" while nothing is armed is worse than uninformative: it
 * claims the opposite of the truth.
 */
function label(state: CaptureState, band?: 'pass' | 'grey' | 'fail'): string {
  if (band === 'pass') return 'Rhythm matched';
  if (band === 'grey') return 'You look a little different today';
  if (band === 'fail') return "That didn't match your rhythm";
  if (state.status === 'unavailable') return 'Not recording';
  if (state.status === 'capturing') {
    return state.pulses === 0 ? 'Ready' : 'Listening to your rhythm';
  }
  if (state.status === 'done') return 'Sample taken';
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
    // Stated outright in BOTH states, which is the point of X-1: the user should never
    // have to infer that capture is running. "Listening to your rhythm" is the guide's
    // label and does say it, but the explicit sentence costs a line and X-1 is a hard
    // limit, so it stays alongside.
    return state.pulses === 0
      ? 'Your typing rhythm will be measured while this light is on. Start typing.'
      : `Your rhythm is being measured while this light is on. ${state.pulses} ${
          state.pulses === 1 ? 'keystroke' : 'keystrokes'
        } so far.`;
  }
  // A silent success is indistinguishable from nothing having happened, which is how a
  // voided sample and a good one came to look the same on screen.
  if (state.status === 'done') {
    const strokes = state.events.filter((e) => e.type === 'down').length;
    return `${strokes} ${strokes === 1 ? 'key' : 'keys'} recorded.`;
  }
  return '';
}
