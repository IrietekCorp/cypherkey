import { useCallback, useRef, useState } from 'react';
import { startCapture } from '../../../core/biometrics/capture';
import { extractFeatures } from '../../../core/biometrics/features';
import { eventsToScript, scriptLength } from '../../../core/biometrics/script';
import type { KeyEvent, ScriptError } from '../../../core/biometrics/types';

/**
 * X-1: the light is the consent signal. `startCapture` refuses to run without a visible
 * one, and this is what the user is told when that happens.
 */
export const LIGHT_HIDDEN_MESSAGE =
  'The Rhythm Light is not visible, so nothing was recorded. Typing is only measured when you can see it.';

/**
 * One message per cancel reason.
 *
 * M1-18 collapsed five distinct conditions into a single bare "enroll rejected
 * malformed", and the web demo needed a `?debug=1` panel before anyone could tell what
 * had actually happened. Each reason gets its own sentence, and each says what to do.
 *
 * Note where each one actually comes from, because they arrive by two different routes:
 * `startCapture`'s `onCancel` reports **only** `unsupported_key`, and it uses that one
 * value for paste, drop and composition alike. `focus_lost`, `unsupported_combo` and
 * `malformed` are not raised during capture at all — they surface when `eventsToScript`
 * tokenizes the sample. And `paste` / `drop` / `composition` are distinguished here, by
 * this hook listening for those events itself, because otherwise three different
 * mistakes would share one message: the exact failure M1-18 was about.
 */
export const CANCEL_MESSAGES: Record<ScriptError | 'paste' | 'drop' | 'composition', string> = {
  focus_lost:
    'The cursor left the box, so that attempt was discarded. Click back in and type it again without leaving the field.',
  unsupported_key:
    'That attempt could not be measured. Type the passphrase using characters, Backspace, Delete and Escape.',
  unsupported_combo:
    'That looked like a shortcut rather than typing. Ctrl, Alt and Command combinations are not part of a passphrase.',
  malformed:
    'Some keys were still held when the attempt ended. Let every key come back up before you finish.',
  paste: 'Pasting cannot be measured — the rhythm is the point. Type the passphrase out.',
  drop: 'Dropped text cannot be measured. Type the passphrase out.',
  composition:
    'An input method was composing text, which we cannot time. Type the passphrase directly.',
};

export type CaptureReason = keyof typeof CANCEL_MESSAGES;

export type CaptureState =
  | { status: 'idle' }
  | { status: 'capturing'; pulses: number }
  | { status: 'cancelled'; reason: CaptureReason; message: string }
  | { status: 'unavailable'; message: string }
  | { status: 'done'; events: KeyEvent[] };

/**
 * Wraps `startCapture` for React, keeping the two guarantees that matter: capture never
 * starts without a visible light, and every way a sample dies has its own explanation.
 */
export function useCapture() {
  const handle = useRef<ReturnType<typeof startCapture> | null>(null);
  const detach = useRef<(() => void) | null>(null);
  const [state, setState] = useState<CaptureState>({ status: 'idle' });

  const finish = useCallback((reason: CaptureReason) => {
    handle.current?.cancel();
    handle.current = null;
    detach.current?.();
    detach.current = null;
    setState({ status: 'cancelled', reason, message: CANCEL_MESSAGES[reason] });
  }, []);

  const start = useCallback(
    (input: HTMLInputElement, light: HTMLElement) => {
      let pulses = 0;
      setState({ status: 'capturing', pulses: 0 });
      try {
        handle.current = startCapture(input, light, {
          onPulse: () => {
            pulses += 1;
            setState({ status: 'capturing', pulses });
          },
          // Always `unsupported_key`, whatever happened. The listeners below say which.
          onCancel: (reason) => {
            handle.current = null;
            setState((current) =>
              current.status === 'cancelled'
                ? current
                : { status: 'cancelled', reason, message: CANCEL_MESSAGES[reason] },
            );
          },
        });
      } catch {
        // The only throw `startCapture` makes is RhythmLightNotVisible, and it is a
        // refusal rather than a fault: the service did not show the light, so it gets
        // no data. Say that plainly instead of surfacing an exception.
        handle.current = null;
        setState({ status: 'unavailable', message: LIGHT_HIDDEN_MESSAGE });
        return;
      }

      // Capture voids the sample for all three of these and reports one reason for the
      // lot. Listening separately is the only way to tell the user which they did.
      const onPaste = () => finish('paste');
      const onDrop = () => finish('drop');
      const onComposition = () => finish('composition');
      input.addEventListener('paste', onPaste);
      input.addEventListener('drop', onDrop);
      input.addEventListener('compositionstart', onComposition);
      detach.current = () => {
        input.removeEventListener('paste', onPaste);
        input.removeEventListener('drop', onDrop);
        input.removeEventListener('compositionstart', onComposition);
      };
    },
    [finish],
  );

  /**
   * Ends the sample and tokenizes it.
   *
   * Tokenizing here is not an optimisation: `focus_lost`, `unsupported_combo` and
   * `malformed` are only discoverable at this point, because capture records a blur or
   * a chord rather than rejecting it. A caller that just took the events would show
   * nothing and then fail server-side with no explanation.
   */
  const stop = useCallback((): {
    script: string;
    resolved: string;
    featureVector: number[];
    events: KeyEvent[];
  } | null => {
    const active = handle.current;
    if (active === null) return null;
    handle.current = null;
    detach.current?.();
    detach.current = null;

    const events = active.stop();
    const script = eventsToScript(events);
    if ('error' in script) {
      setState({
        status: 'cancelled',
        reason: script.error,
        message: CANCEL_MESSAGES[script.error],
      });
      return null;
    }
    // Every consumer -- enrolment, login, step-up -- needs the vector as well as the
    // script, and both are derived from the same events with the same token count.
    // Extracting here keeps `getFeatureRanges` agreeing with the commitments.
    const features = extractFeatures(events, scriptLength(script.script));
    if ('error' in features) {
      const reason = features.error === 'length_mismatch' ? 'malformed' : features.error;
      setState({ status: 'cancelled', reason, message: CANCEL_MESSAGES[reason] });
      return null;
    }

    setState({ status: 'done', events });
    return { ...script, featureVector: features.values, events };
  }, []);

  const cancel = useCallback((reason: CaptureReason) => finish(reason), [finish]);

  const reset = useCallback(() => {
    handle.current?.cancel();
    handle.current = null;
    detach.current?.();
    detach.current = null;
    setState({ status: 'idle' });
  }, []);

  return { state, start, stop, cancel, reset };
}

/**
 * For any control that ends a sample — Submit, Next, Done.
 *
 * Clicking a button blurs the input, which fires `blur`, which voids the sample the
 * click was meant to send. `mousedown` fires before focus moves, so preventing its
 * default keeps focus where it is. This cost a full debugging session on the web demo
 * (M1-18) and is invisible until someone actually clicks rather than pressing Enter.
 */
export function preventFocusSteal(event: { preventDefault(): void }): void {
  event.preventDefault();
}
