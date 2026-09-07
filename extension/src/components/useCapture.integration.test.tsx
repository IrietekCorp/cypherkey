import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { RhythmLight } from './RhythmLight';
import { useCapture } from './useCapture';

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

/** The shape a real screen will take: an input, a light, and the hook joining them. */
function Harness({ hide = false }: { hide?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const light = useRef<HTMLDivElement>(null);
  const capture = useCapture();

  return (
    <div>
      <button type="button" data-testid="stop" onClick={() => capture.stop()}>
        Done
      </button>
      <input
        ref={input}
        data-testid="passphrase"
        onFocus={() => {
          if (input.current !== null && light.current !== null) {
            capture.start(input.current, light.current);
          }
        }}
      />
      <div style={hide ? { display: 'none' } : undefined}>
        <RhythmLight ref={light} state={capture.state} />
      </div>
    </div>
  );
}

const field = () => host.querySelector('[data-testid="passphrase"]');
const dot = () => host.querySelector('[data-testid="rhythm-light"]');

const type = async (keys: string[]) => {
  const el = field();
  for (const key of keys) {
    await act(async () => {
      el?.dispatchEvent(new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      el?.dispatchEvent(new win.KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    });
  }
};

describe('the light pulses once per keystroke', () => {
  test('one pulse per character, driven by real key events', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => field()?.dispatchEvent(new win.Event('focusin', { bubbles: true })));

    await type(['c', 'o', 'r', 'r', 'e', 'c', 't']);
    expect(dot()?.getAttribute('data-pulses')).toBe('7');
  });

  /** A-14.1: a modifier is recorded but is not a keystroke the user sees pulse. */
  test('a held modifier does not pulse on its own', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => field()?.dispatchEvent(new win.Event('focusin', { bubbles: true })));

    await type(['Shift', 'P']);
    expect(dot()?.getAttribute('data-pulses')).toBe('1');
  });

  /**
   * Capture records a blur token rather than rejecting on the spot, so `focus_lost` is
   * only discoverable when the sample is tokenized. The hook does that in `stop()`,
   * which is why the message appears there and not at the moment focus was lost.
   */
  test('losing focus voids the sample, and stop() explains why', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => field()?.dispatchEvent(new win.Event('focusin', { bubbles: true })));
    await type(['a', 'b']);
    await act(async () => field()?.dispatchEvent(new win.Event('blur', { bubbles: true })));

    await act(async () => {
      host
        .querySelector('[data-testid="stop"]')
        ?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });

    expect(host.textContent).toContain('The cursor left the box');
    expect(host.textContent).toContain('without leaving the field');
  });

  /**
   * The tokenizer knows exactly which condition tripped and on which key, and that
   * detail used to be computed and thrown away: every `malformed` sample showed the
   * same sentence about held keys, whether a key was held, none were captured, or the
   * feature vector disagreed with the script length. A real onboarding failure was
   * reported against that message while the actual cause was something else, so the
   * detail is now surfaced and pinned here.
   */
  test('a still-held key is named, not guessed at', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => field()?.dispatchEvent(new win.Event('focusin', { bubbles: true })));
    await type(['a', 'b']);
    // A final key pressed and never released -- the sample ends while it is down.
    await act(async () => {
      field()?.dispatchEvent(
        new win.KeyboardEvent('keydown', { key: 'c', bubbles: true, cancelable: true }),
      );
    });

    await act(async () => {
      host
        .querySelector('[data-testid="stop"]')
        ?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });

    // The generic sentence still tells the user what to do...
    expect(host.textContent).toContain('could not be measured');
    // ...and the detail says which key, so the next report is diagnosable.
    expect(host.textContent).toContain('still held when the sample ended');
    expect(host.textContent).toContain('c');
  });

  /**
   * `startCapture` reports `unsupported_key` for paste, drop and composition alike --
   * one reason for three different mistakes, which is the M1-18 failure one layer down.
   * The hook listens for them itself so each gets its own sentence.
   */
  test.each([
    ['paste', 'Pasting cannot be measured'],
    ['drop', 'Dropped text cannot be measured'],
    ['compositionstart', 'An input method was composing'],
  ])('%s gets its own message', async (event, expected) => {
    await act(async () => root.render(<Harness />));
    await act(async () => field()?.dispatchEvent(new win.Event('focusin', { bubbles: true })));

    await act(async () => {
      field()?.dispatchEvent(new win.Event(event, { bubbles: true }));
    });
    expect(host.textContent).toContain(expected);
  });

  test('a clean sample returns its script', async () => {
    await act(async () => root.render(<Harness />));
    await act(async () => field()?.dispatchEvent(new win.Event('focusin', { bubbles: true })));
    await type(['h', 'i']);

    await act(async () => {
      host
        .querySelector('[data-testid="stop"]')
        ?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    });
    expect(host.textContent).not.toContain('cursor left the box');
  });
});

/**
 * The acceptance criterion, end to end: a screen that hides the light gets no data, and
 * the refusal appears on screen rather than as an exception.
 */
describe('a hidden light produces a refusal, not a crash', () => {
  test('capture never starts and the reason is rendered', async () => {
    await act(async () => root.render(<Harness hide />));
    await act(async () => field()?.dispatchEvent(new win.Event('focusin', { bubbles: true })));

    expect(host.textContent).toContain('The Rhythm Light is not visible');
    expect(host.textContent).toContain('Typing is only measured when you can see it');

    // And nothing was recorded: typing into it produces no pulses at all.
    await type(['a', 'b', 'c']);
    expect(dot()?.getAttribute('data-pulses')).toBe('0');
  });
});
