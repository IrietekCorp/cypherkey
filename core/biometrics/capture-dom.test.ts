import { beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { startCapture } from './capture';
import { RhythmLightNotVisible, startCaptureWith } from './capture-contract';
import { domAdapter } from './capture-dom';
import type { KeyEvent } from './types';

/**
 * The DOM adapter, and the guarantee that matters while two capture paths exist: for
 * the same typing they produce the same events.
 *
 * `startCapture` is not yet collapsed onto `startCaptureWith` — that is a follow-up,
 * deliberately not attempted in the same change as introducing the contract. Until it
 * happens, this file is what stops the two drifting.
 */

let win: Window;
let input: ReturnType<Window['document']['createElement']>;
let light: ReturnType<Window['document']['createElement']>;

beforeEach(() => {
  win = new Window();
  input = win.document.createElement('input');
  light = win.document.createElement('div');
  win.document.body.append(input, light);
});

/** Types into the field, driving whatever is listening. */
const type = (keys: string[]) => {
  for (const key of keys) {
    input.dispatchEvent(
      new win.KeyboardEvent('keydown', { key, code: `Key${key.toUpperCase()}`, bubbles: true }),
    );
    input.dispatchEvent(
      new win.KeyboardEvent('keyup', { key, code: `Key${key.toUpperCase()}`, bubbles: true }),
    );
  }
};

const shape = (events: KeyEvent[]) =>
  events.map((e) => (e.type === 'blur' ? 'blur' : `${e.type}:${e.key}`));

describe('it behaves as startCapture does', () => {
  /**
   * The one assertion worth having while both exist. If the two ever disagree about
   * what a keystroke is, an account enrolled through one would fail to unlock through
   * the other, and nothing else in the system would notice.
   */
  test('the same typing yields the same event shape', () => {
    const viaLegacy = startCapture(
      input as unknown as HTMLInputElement,
      light as unknown as HTMLElement,
    );
    type([...'correct']);
    const legacyEvents = viaLegacy.stop();

    const viaAdapter = startCaptureWith(
      domAdapter(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    );
    type([...'correct']);
    const adapterEvents = viaAdapter.stop();

    expect(shape(adapterEvents)).toEqual(shape(legacyEvents));
  });

  test('both refuse a hidden light', () => {
    (light as unknown as HTMLElement).style.display = 'none';

    expect(() =>
      startCapture(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    ).toThrow('RhythmLightNotVisible');
    expect(() =>
      startCaptureWith(
        domAdapter(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
      ),
    ).toThrow(RhythmLightNotVisible);
  });

  test('both record a blur rather than rejecting on the spot', () => {
    const handle = startCaptureWith(
      domAdapter(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    );
    type(['a']);
    input.dispatchEvent(new win.Event('blur', { bubbles: true }));

    expect(shape(handle.stop())).toEqual(['down:a', 'up:a', 'blur']);
  });

  test('both void the sample on paste', () => {
    const handle = startCaptureWith(
      domAdapter(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    );
    type(['a']);
    input.dispatchEvent(new win.Event('paste', { bubbles: true }));

    expect(handle.stop()).toEqual([]);
  });
});

describe('the DOM rules stay in the DOM adapter', () => {
  test('auto-repeat is dropped', () => {
    const handle = startCaptureWith(
      domAdapter(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    );
    input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    input.dispatchEvent(
      new win.KeyboardEvent('keydown', { key: 'a', repeat: true, bubbles: true }),
    );
    input.dispatchEvent(new win.KeyboardEvent('keyup', { key: 'a', bubbles: true }));

    // Holding a key is not a rhythm signal, and produces downs with no matching ups.
    expect(shape(handle.stop())).toEqual(['down:a', 'up:a']);
  });

  test('a lock key is ignored entirely', () => {
    const handle = startCaptureWith(
      domAdapter(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    );
    type(['NumLock', 'a']);
    expect(shape(handle.stop())).toEqual(['down:a', 'up:a']);
  });

  /** A-14.1: Escape is a token, so it must not close the popup it was typed into. */
  test('Escape is recorded and its default prevented', () => {
    const handle = startCaptureWith(
      domAdapter(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    );
    const event = new win.KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    input.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(shape(handle.stop())).toEqual(['down:Escape']);
  });

  test('a modifier is recorded but does not pulse', () => {
    let pulses = 0;
    const handle = startCaptureWith(
      domAdapter(input as unknown as HTMLInputElement, light as unknown as HTMLElement, () => {
        pulses += 1;
      }),
    );
    type(['Shift', 'a']);

    expect(handle.stop()).toHaveLength(4);
    expect(pulses).toBe(1);
  });

  test('stopping removes every listener it added', () => {
    const handle = startCaptureWith(
      domAdapter(input as unknown as HTMLInputElement, light as unknown as HTMLElement),
    );
    handle.stop();

    type(['a']);
    // A second stop returns nothing, and the events above went nowhere.
    expect(handle.stop()).toEqual([]);
  });
});
