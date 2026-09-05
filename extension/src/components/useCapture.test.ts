import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { startCapture } from '../../../core/biometrics/capture';
import type { ScriptError } from '../../../core/biometrics/types';
import { CANCEL_MESSAGES, preventFocusSteal } from './useCapture';

/** The four `ScriptError` values, so a new one cannot be added without copy. */
const SCRIPT_ERRORS: ScriptError[] = [
  'focus_lost',
  'unsupported_key',
  'unsupported_combo',
  'malformed',
];

describe('CANCEL_MESSAGES', () => {
  /**
   * M1-18 collapsed five conditions into one bare "enroll rejected malformed", and the
   * demo needed a debug panel before anyone could tell them apart. Every reason gets
   * its own sentence.
   */
  test('every cancel reason has its own message', () => {
    const messages = Object.values(CANCEL_MESSAGES);
    expect(new Set(messages).size).toBe(messages.length);
  });

  test('covers every ScriptError the capture module can emit', () => {
    for (const reason of SCRIPT_ERRORS) {
      expect(CANCEL_MESSAGES[reason]).toBeDefined();
      expect(CANCEL_MESSAGES[reason].length).toBeGreaterThan(20);
    }
  });

  /**
   * `startCapture` reports `unsupported_key` for paste, drop and composition too, so
   * this message must not name a cause it cannot be sure of. It said "an arrow, a
   * function key or similar" and would have been wrong for a paste.
   */
  test('the shared unsupported_key message does not guess at a cause', () => {
    expect(CANCEL_MESSAGES.unsupported_key).not.toContain('arrow');
    expect(CANCEL_MESSAGES.unsupported_key).not.toContain('function key');
  });

  test('each message says what to do, not just what went wrong', () => {
    // A reason with no remedy leaves the user stuck, which is what the demo showed.
    for (const message of Object.values(CANCEL_MESSAGES)) {
      expect(message).toMatch(/\.\s|\.$/);
      expect(message.split(' ').length).toBeGreaterThan(6);
    }
  });

  test('no message leaks what was typed', () => {
    for (const message of Object.values(CANCEL_MESSAGES)) {
      expect(message).not.toContain('passphrase:');
      expect(message).not.toMatch(/"[^"]{3,}"/);
    }
  });
});

describe('preventFocusSteal', () => {
  /**
   * Clicking Submit blurs the input, `blur` voids the sample, and the click sends
   * nothing. `mousedown` fires before focus moves, so preventing its default keeps
   * focus where it is. This cost a full debugging session on the web demo.
   */
  test('a mousedown on a sibling button does not cancel the sample', () => {
    const win = new Window();
    const doc = win.document;
    const input = doc.createElement('input');
    const light = doc.createElement('div');
    const submit = doc.createElement('button');
    doc.body.append(input, light, submit);

    const cancels: ScriptError[] = [];
    const capture = startCapture(
      input as unknown as HTMLInputElement,
      light as unknown as HTMLElement,
      { onCancel: (reason) => cancels.push(reason) },
    );

    submit.addEventListener('mousedown', (e) => preventFocusSteal(e as unknown as Event));
    const event = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    submit.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(cancels).toEqual([]);
    expect(capture.stop()).toEqual([]);
  });

  test('without it, the default is not prevented and focus would move', () => {
    const win = new Window();
    const submit = win.document.createElement('button');
    win.document.body.appendChild(submit);
    const event = new win.MouseEvent('mousedown', { bubbles: true, cancelable: true });
    submit.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(false);
  });
});
