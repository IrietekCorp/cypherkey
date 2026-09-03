import type { KeyEvent } from './types';

// Assumption: Auto-repeat keydown events (event.repeat === true) are recorded in key events but do not trigger onPulse.

const MODIFIER_KEYS = new Set([
  'Shift',
  'Control',
  'Alt',
  'Meta',
  'CapsLock',
  'NumLock',
  'ScrollLock',
]);

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
  opts?: { onPulse?: () => void },
): { stop(): KeyEvent[]; cancel(): void } {
  if (!isLightVisible(light)) {
    throw new Error('RhythmLightNotVisible');
  }

  const events: KeyEvent[] = [];
  let isActive = true;

  const handleKeyDown = (event: KeyboardEvent) => {
    if (MODIFIER_KEYS.has(event.key)) {
      return;
    }

    if (!event.repeat) {
      opts?.onPulse?.();
    }

    events.push({
      key: event.key,
      type: 'down',
      t: performance.now(),
    });
  };

  const handleKeyUp = (event: KeyboardEvent) => {
    if (MODIFIER_KEYS.has(event.key)) {
      return;
    }

    events.push({
      key: event.key,
      type: 'up',
      t: performance.now(),
    });
  };

  input.addEventListener('keydown', handleKeyDown);
  input.addEventListener('keyup', handleKeyUp);

  const cleanup = () => {
    if (!isActive) return;
    isActive = false;
    input.removeEventListener('keydown', handleKeyDown);
    input.removeEventListener('keyup', handleKeyUp);
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
