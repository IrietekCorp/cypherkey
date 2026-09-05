import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { startCapture } from '../../../core/biometrics/capture';
import type { ScriptError } from '../../../core/biometrics/types';
import { RhythmLight } from './RhythmLight';
import { CANCEL_MESSAGES, type CaptureState, LIGHT_HIDDEN_MESSAGE } from './useCapture';

let win: Window;
let host: ReturnType<Window['document']['createElement']>;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  win = new Window();
  for (const key of [
    'window',
    'document',
    'HTMLElement',
    'Element',
    'Node',
    'navigator',
    'MouseEvent',
    'KeyboardEvent',
    'Event',
  ]) {
    (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[key];
  }
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

  host = win.document.createElement('div');
  win.document.body.appendChild(host);
  root = createRoot(host as unknown as HTMLElement);
});

afterEach(async () => {
  await act(async () => root.unmount());
});

const render = async (state: CaptureState, band?: 'pass' | 'grey' | 'fail') => {
  await act(async () => {
    root.render(<RhythmLight state={state} band={band} />);
  });
  return host;
};

const dot = () => host.querySelector('[data-testid="rhythm-light"]');

describe('accessibility (X-1)', () => {
  test('the message is a polite live region', async () => {
    await render({ status: 'capturing', pulses: 0 });
    // `<output>` has an implicit role of "status", which is the semantic element for
    // this rather than a <p> carrying the role by hand.
    const status = host.querySelector('output');
    expect(status).not.toBeNull();
    expect(status?.getAttribute('aria-live')).toBe('polite');
  });

  /**
   * The light itself must not be a live region: a screen reader announcing one pulse
   * per keystroke would read the passphrase's length aloud and be unusable besides.
   */
  test('the light itself is not announced', async () => {
    await render({ status: 'capturing', pulses: 3 });
    expect(dot()?.getAttribute('aria-live')).toBeNull();
    expect(dot()?.getAttribute('role')).toBeNull();
    expect(dot()?.tagName.toLowerCase()).not.toBe('output');
  });

  test('capture being active is stated outright, not implied by colour', async () => {
    await render({ status: 'capturing', pulses: 1 });
    expect(host.textContent).toContain('Recording your rhythm');
    expect(host.textContent).toContain('being measured while this light is on');
  });
});

describe('pulses', () => {
  test('the light reflects one pulse per keystroke', async () => {
    await render({ status: 'capturing', pulses: 0 });
    expect(dot()?.getAttribute('data-pulses')).toBe('0');

    await render({ status: 'capturing', pulses: 5 });
    expect(dot()?.getAttribute('data-pulses')).toBe('5');
  });

  test('a pulse changes the light, so it is visibly alive', async () => {
    await render({ status: 'capturing', pulses: 2 });
    const even = dot()?.getAttribute('style');
    await render({ status: 'capturing', pulses: 3 });
    expect(dot()?.getAttribute('style')).not.toBe(even);
  });
});

describe('every cancel reason renders its own message', () => {
  const reasons: ScriptError[] = [
    'focus_lost',
    'unsupported_key',
    'unsupported_combo',
    'malformed',
  ];

  for (const reason of reasons) {
    test(`${reason} explains itself`, async () => {
      await render({ status: 'cancelled', reason, message: CANCEL_MESSAGES[reason] });
      expect(host.textContent).toContain(CANCEL_MESSAGES[reason]);
    });
  }

  test('two different reasons do not render the same text', async () => {
    await render({
      status: 'cancelled',
      reason: 'focus_lost',
      message: CANCEL_MESSAGES.focus_lost,
    });
    const first = host.textContent;
    await render({ status: 'cancelled', reason: 'malformed', message: CANCEL_MESSAGES.malformed });
    expect(host.textContent).not.toBe(first);
  });
});

describe('bands', () => {
  test.each([
    ['pass', 'Rhythm matched'],
    ['grey', 'Rhythm looks different'],
    ['fail', 'Rhythm did not match'],
  ] as const)('%s says %s', async (band, expected) => {
    await render({ status: 'done', events: [] }, band);
    expect(host.textContent).toContain(expected);
  });

  /**
   * The web demo showed "0.69 PASS" beside "Stolen password neutralized" and it was the
   * single most confusing thing in it. The label is derived from the band, so the two
   * cannot disagree.
   */
  test('the label is a pure function of the band', async () => {
    await render({ status: 'capturing', pulses: 9 }, 'fail');
    expect(host.textContent).toContain('Rhythm did not match');
    expect(host.textContent).not.toContain('Rhythm matched');
  });
});

/**
 * The acceptance criterion: with the light hidden by CSS, capture refuses and the
 * refusal is on screen rather than thrown into the console.
 */
describe('a hidden light refuses capture and says so', () => {
  const hiddenBy = (apply: (el: HTMLElement) => void) => {
    const input = win.document.createElement('input');
    const light = win.document.createElement('div');
    win.document.body.append(input, light);
    apply(light as unknown as HTMLElement);
    return { input, light };
  };

  test.each([
    [
      'display:none',
      (el: HTMLElement) => {
        el.style.display = 'none';
      },
    ],
    [
      'visibility:hidden',
      (el: HTMLElement) => {
        el.style.visibility = 'hidden';
      },
    ],
    [
      'opacity:0',
      (el: HTMLElement) => {
        el.style.opacity = '0';
      },
    ],
    [
      'detached from the document',
      (el: HTMLElement) => {
        el.remove();
      },
    ],
  ])('%s', async (_name, apply) => {
    const { input, light } = hiddenBy(apply);

    expect(() =>
      startCapture(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    ).toThrow('RhythmLightNotVisible');

    await render({ status: 'unavailable', message: LIGHT_HIDDEN_MESSAGE });
    expect(host.textContent).toContain('not visible');
    expect(host.textContent).toContain('Typing is only measured when you can see it');
  });

  test('a hidden parent hides the light too', () => {
    const wrapper = win.document.createElement('div');
    const input = win.document.createElement('input');
    const light = win.document.createElement('div');
    wrapper.appendChild(light);
    win.document.body.append(input, wrapper);
    (wrapper as unknown as HTMLElement).style.display = 'none';

    expect(() =>
      startCapture(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    ).toThrow('RhythmLightNotVisible');
  });
});
