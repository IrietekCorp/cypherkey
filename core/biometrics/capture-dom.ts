import { isLightVisible } from './capture';
import type { CaptureAdapter, KeySource, RhythmIndicator } from './capture-contract';

/**
 * The browser as a platform, behind the M2-00h contract.
 *
 * Every DOM-specific rule lives here rather than in the contract, which is the point of
 * the split: a terminal has no `preventDefault`, no auto-repeat flag, no paste event and
 * no blur, and none of those should appear in an interface a CLI has to satisfy.
 */

/** Modifiers are recorded (A-14.1 needs their pairs) but are not keystrokes that pulse. */
const RECORDED_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** Locks that change nothing about the script and carry no useful rhythm. */
const IGNORED_KEYS = new Set(['NumLock', 'ScrollLock']);

export function domIndicator(light: HTMLElement, onPulse?: () => void): RhythmIndicator {
  return {
    // Delegated to the same check `startCapture` uses, so the two cannot drift on what
    // "visible" means — the one question X-1 turns on.
    isVisible: () => isLightVisible(light),
    pulse: () => onPulse?.(),
  };
}

export function domKeySource(input: HTMLInputElement): KeySource {
  return {
    listen(handlers) {
      const onKeyDown = (event: KeyboardEvent) => {
        if (IGNORED_KEYS.has(event.key)) return;
        // Holding a key is not a rhythm signal, and produces downs with no matching ups.
        if (event.repeat) return;

        // A-14.1: Escape is a token, so it must not close the popup it was typed into.
        if (event.key === 'Escape') event.preventDefault();

        handlers.onEvent({
          key: event.key,
          code: event.code,
          type: 'down',
          t: performance.now(),
        });
        if (!RECORDED_MODIFIERS.has(event.key)) handlers.onPulse();
      };

      const onKeyUp = (event: KeyboardEvent) => {
        if (IGNORED_KEYS.has(event.key)) return;
        handlers.onEvent({ key: event.key, code: event.code, type: 'up', t: performance.now() });
      };

      // A-14.1: losing focus voids the sample. This is how "the key did not move focus"
      // is enforced without a per-OS list of keys that steal it.
      const onBlur = () => handlers.onEvent({ type: 'blur', t: performance.now() });

      // Nothing here can be scored: a paste has no rhythm, a drop has no keystrokes,
      // and IME composition produces characters no key pressed.
      const onUnsupported = () => handlers.onAbandon('unsupported_key');

      input.addEventListener('keydown', onKeyDown);
      input.addEventListener('keyup', onKeyUp);
      input.addEventListener('blur', onBlur);
      input.addEventListener('paste', onUnsupported);
      input.addEventListener('drop', onUnsupported);
      input.addEventListener('compositionstart', onUnsupported);

      return () => {
        input.removeEventListener('keydown', onKeyDown);
        input.removeEventListener('keyup', onKeyUp);
        input.removeEventListener('blur', onBlur);
        input.removeEventListener('paste', onUnsupported);
        input.removeEventListener('drop', onUnsupported);
        input.removeEventListener('compositionstart', onUnsupported);
      };
    },
  };
}

/** The browser adapter, ready for `startCaptureWith`. */
export function domAdapter(
  input: HTMLInputElement,
  light: HTMLElement,
  onPulse?: () => void,
): CaptureAdapter {
  return { indicator: domIndicator(light, onPulse), source: domKeySource(input) };
}
