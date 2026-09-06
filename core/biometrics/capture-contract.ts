import type { KeyEvent, ScriptError } from './types';

/**
 * What capture requires of a platform, independent of the DOM.
 *
 * `capture.ts` is written against `HTMLInputElement` and `HTMLElement`, which is right
 * for a browser and unavailable everywhere else: a terminal has no elements, and M4's
 * CLI walks straight into it. This is the shape a platform must supply instead.
 *
 * The important part is what does **not** become optional. X-1 says a service that hides
 * the light gets no data, and the rule survives the move off the DOM: an adapter must
 * *prove* the indicator is visible, not merely promise it. In a browser that proof is a
 * rendered element; in a TTY it is a line drawn on a screen the user is looking at.
 * `startCapture` refuses either way.
 */

/**
 * A platform's consent indicator.
 *
 * A single method, deliberately. Anything richer invites an adapter to report "visible"
 * from configuration rather than from the world — which is the failure X-1 exists to
 * prevent.
 */
export type RhythmIndicator = {
  /**
   * Whether the user can see it, *now*. Called immediately before capture starts and
   * never cached: a light that was visible a minute ago says nothing about a window
   * that has since been scrolled, minimised or redrawn.
   */
  isVisible(): boolean;
  /** Called once per counted keystroke, so the indicator can show that it is live. */
  pulse(): void;
};

/**
 * A platform's key source.
 *
 * It reports raw down/up events with timestamps and says nothing about what they mean;
 * `script.ts` owns that. Focus loss has no cross-platform equivalent — a terminal has
 * no blur — so it is reported through the same `KeyEvent` union rather than being
 * modelled separately, and a platform that cannot detect it simply never emits one.
 */
export type KeySource = {
  /** Begins delivering events. Returns a function that stops delivery. */
  listen(handlers: {
    onEvent(event: KeyEvent): void;
    /**
     * A keystroke the user should see acknowledged.
     *
     * Separate from `onEvent` because which keys count is platform knowledge: A-14.1
     * records a modifier's down/up pair but a lone Shift is not a keystroke anyone
     * expects to see pulse, and only the adapter knows what its platform calls Shift.
     */
    onPulse(): void;
    /** The sample is void. `reason` is what the user is told. */
    onAbandon(reason: ScriptError): void;
  }): () => void;
};

export type CaptureAdapter = {
  indicator: RhythmIndicator;
  source: KeySource;
};

export type CaptureHandle = {
  /** Ends the sample and returns its events. */
  stop(): KeyEvent[];
  /** Voids the sample and discards its events. */
  cancel(): void;
};

/** Thrown when an adapter cannot show that its indicator is visible. */
export class RhythmLightNotVisible extends Error {
  constructor() {
    super('RhythmLightNotVisible');
    this.name = 'RhythmLightNotVisible';
  }
}

/**
 * Capture, over any platform.
 *
 * The visibility check happens **before** a single listener is attached, so a platform
 * that hides its indicator never sees an event, rather than seeing them and discarding
 * them afterwards. The difference matters: the second version has the timings in memory
 * at some point, and this one never does.
 */
export function startCaptureWith(adapter: CaptureAdapter): CaptureHandle {
  if (!adapter.indicator.isVisible()) {
    throw new RhythmLightNotVisible();
  }

  let events: KeyEvent[] = [];
  let active = true;

  const stopListening = adapter.source.listen({
    onEvent(event) {
      if (!active) return;
      events.push(event);
    },
    onPulse() {
      if (!active) return;
      adapter.indicator.pulse();
    },
    onAbandon() {
      if (!active) return;
      // The buffer is emptied, not merely flagged: a cancelled attempt must not be
      // recoverable by anything that still holds the handle.
      events = [];
    },
  });

  const finish = (): KeyEvent[] => {
    if (!active) return [];
    active = false;
    stopListening();
    return events;
  };

  return {
    stop: finish,
    cancel() {
      finish();
      events = [];
    },
  };
}
