import type { KeyEvent } from './types';
import type { ScriptError } from './types';

/**
 * Modifiers are now recorded rather than filtered out: A-14.1 needs their down/up
 * pairs to tell a lone tap (a Phantom Key) from a held modifier (not a token), and
 * to spot Ctrl/Alt/Meta chords. `script.ts` decides what any of it means.
 */
const RECORDED_MODIFIERS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']);

/** Locks that change nothing about the script and carry no useful rhythm. */
const IGNORED_KEYS = new Set(['NumLock', 'ScrollLock']);

/**
 * Auto-repeat is dropped entirely. Holding a key is not a rhythm signal, and a
 * stream of downs with no matching ups cannot be paired into dwell times.
 */

/**
 * Checks whether the given Rhythm Light element is currently visible in the document.
 */
function isLightVisible(light: HTMLElement): boolean {
  if (!light.isConnected) {
    return false;
  }

  if ('offsetParent' in light && light.offsetParent === null) {
    return false;
  }

  const win = light.ownerDocument?.defaultView ?? (typeof window !== 'undefined' ? window : null);

  let current: HTMLElement | null = light;
  while (current) {
    const computed =
      win && typeof win.getComputedStyle === 'function' ? win.getComputedStyle(current) : null;

    const display = computed?.display ?? current.style?.display;
    if (display === 'none' || current.style?.display === 'none') {
      return false;
    }

    if (current === light) {
      const visibility = computed?.visibility ?? current.style?.visibility;
      if (
        visibility === 'hidden' ||
        visibility === 'collapse' ||
        current.style?.visibility === 'hidden' ||
        current.style?.visibility === 'collapse'
      ) {
        return false;
      }

      const opacity = computed?.opacity ?? current.style?.opacity;
      if (
        opacity === '0' ||
        (opacity !== '' && opacity !== undefined && Number(opacity) === 0) ||
        current.style?.opacity === '0' ||
        (current.style?.opacity !== '' &&
          current.style?.opacity !== undefined &&
          Number(current.style.opacity) === 0)
      ) {
        return false;
      }
    }

    current = current.parentElement;
  }

  return true;
}

/**
 * Starts keystroke timing capture for passphrase entry while guaranteeing Rhythm Light visibility.
 */
export function startCapture(
  input: HTMLInputElement,
  light: HTMLElement,
  opts?: { onPulse?: () => void; onCancel?: (reason: ScriptError) => void },
): { stop(): KeyEvent[]; cancel(): void } {
  if (!isLightVisible(light)) {
    throw new Error('RhythmLightNotVisible');
  }

  const events: KeyEvent[] = [];
  let isActive = true;

  /** Voids the sample. The buffer is emptied so a cancelled attempt cannot be used. */
  const abandon = (reason: ScriptError) => {
    events.length = 0;
    opts?.onCancel?.(reason);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (IGNORED_KEYS.has(event.key)) return;
    if (event.repeat) return;

    // A-14.1: Escape is a token, so it must not close the popup it was typed into.
    if (event.key === 'Escape') {
      event.preventDefault();
    }

    if (!RECORDED_MODIFIERS.has(event.key)) {
      opts?.onPulse?.();
    }

    events.push({ key: event.key, code: event.code, type: 'down', t: performance.now() });
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (IGNORED_KEYS.has(event.key)) return;
    events.push({ key: event.key, code: event.code, type: 'up', t: performance.now() });
  };

  // A-14.1: losing focus voids the sample. This is how "the key did not move focus"
  // is enforced without maintaining a per-platform list of keys that steal it.
  const handleBlur = () => {
    events.push({ type: 'blur', t: performance.now() });
  };

  // Nothing typed here can be scored: a paste has no rhythm, a drop has no
  // keystrokes, and IME composition produces characters no key pressed.
  const handleUnsupported = () => abandon('unsupported_key');

  input.addEventListener('keydown', handleKeyDown);
  input.addEventListener('keyup', handleKeyUp);
  input.addEventListener('blur', handleBlur);
  input.addEventListener('paste', handleUnsupported);
  input.addEventListener('drop', handleUnsupported);
  input.addEventListener('compositionstart', handleUnsupported);

  const cleanup = () => {
    if (!isActive) return;
    isActive = false;
    input.removeEventListener('keydown', handleKeyDown);
    input.removeEventListener('keyup', handleKeyUp);
    input.removeEventListener('blur', handleBlur);
    input.removeEventListener('paste', handleUnsupported);
    input.removeEventListener('drop', handleUnsupported);
    input.removeEventListener('compositionstart', handleUnsupported);
  };

  return {
    stop(): KeyEvent[] {
      cleanup();
      return [...events];
    },
    cancel(): void {
      cleanup();
      events.length = 0;
    },
  };
}
