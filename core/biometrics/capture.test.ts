import { beforeEach, describe, expect, it } from 'bun:test';
import { KeyboardEvent as HappyKeyboardEvent, Window } from 'happy-dom';
import { startCapture } from './capture';
import { extractFeatures } from './features';
import { eventsToScript } from './script';

describe('Rhythm Light capture module (startCapture)', () => {
  let window: Window;
  let document: Window['document'];
  let inputElement: ReturnType<Window['document']['createElement']>;
  let lightElement: ReturnType<Window['document']['createElement']>;

  beforeEach(() => {
    window = new Window();
    document = window.document;

    inputElement = document.createElement('input');
    lightElement = document.createElement('div');

    document.body.appendChild(inputElement);
    document.body.appendChild(lightElement);
  });

  const dispatchKey = (
    target: typeof inputElement,
    type: 'keydown' | 'keyup',
    key: string,
    repeat = false,
  ) => {
    const event = new HappyKeyboardEvent(type, {
      key,
      // A real browser always sends this; pairing depends on it (see script.ts).
      code: key.length === 1 ? `Key${key.toUpperCase()}` : key,
      repeat,
      bubbles: true,
      cancelable: true,
    });
    target.dispatchEvent(event);
  };

  const typeKey = (target: typeof inputElement, key: string) => {
    dispatchKey(target, 'keydown', key, false);
    dispatchKey(target, 'keyup', key, false);
  };

  const toInput = (el: typeof inputElement): HTMLInputElement => el as unknown as HTMLInputElement;
  const toElement = (el: typeof lightElement): HTMLElement => el as unknown as HTMLElement;

  it('case 1: throws RhythmLightNotVisible when light is not connected or hidden', () => {
    // 1a. Light not connected to document
    const detachedLight = document.createElement('div');
    expect(() => startCapture(toInput(inputElement), toElement(detachedLight))).toThrow(
      'RhythmLightNotVisible',
    );

    // 1b. Light has display: none
    lightElement.style.display = 'none';
    expect(() => startCapture(toInput(inputElement), toElement(lightElement))).toThrow(
      'RhythmLightNotVisible',
    );
    lightElement.style.display = '';

    // 1c. Light has visibility: hidden
    lightElement.style.visibility = 'hidden';
    expect(() => startCapture(toInput(inputElement), toElement(lightElement))).toThrow(
      'RhythmLightNotVisible',
    );
    lightElement.style.visibility = '';

    // 1d. Light has opacity: 0
    lightElement.style.opacity = '0';
    expect(() => startCapture(toInput(inputElement), toElement(lightElement))).toThrow(
      'RhythmLightNotVisible',
    );
    lightElement.style.opacity = '';

    // 1e. Light ancestor has display: none
    const container = document.createElement('div');
    const nestedLight = document.createElement('div');
    container.style.display = 'none';
    container.appendChild(nestedLight);
    document.body.appendChild(container);
    expect(() => startCapture(toInput(inputElement), toElement(nestedLight))).toThrow(
      'RhythmLightNotVisible',
    );

    // 1f. Light has offsetParent === null when supported in DOM env
    const mockParentLight = document.createElement('div');
    document.body.appendChild(mockParentLight);
    Object.defineProperty(mockParentLight, 'offsetParent', {
      value: null,
      configurable: true,
    });
    expect(() => startCapture(toInput(inputElement), toElement(mockParentLight))).toThrow(
      'RhythmLightNotVisible',
    );

    // 1g. Connected and visible light succeeds without throwing
    const capture = startCapture(toInput(inputElement), toElement(lightElement));
    expect(typeof capture.stop).toBe('function');
    expect(typeof capture.cancel).toBe('function');
    capture.cancel();
  });

  it('case 2: records down/up pairs with performance.now', () => {
    const beforeStart = performance.now();
    const session = startCapture(toInput(inputElement), toElement(lightElement));

    typeKey(inputElement, 's');
    typeKey(inputElement, 'e');
    typeKey(inputElement, 'c');
    typeKey(inputElement, 'u');
    typeKey(inputElement, 'r');
    typeKey(inputElement, 'e');

    const events = session.stop();
    const afterStop = performance.now();

    // 6 keys typed -> 12 events
    expect(events.length).toBe(12);

    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (!event) throw new Error('Unexpected undefined event');
      if (event.type === 'blur') throw new Error('Unexpected blur');
      expect(typeof event.key).toBe('string');
      expect(event.type === 'down' || event.type === 'up').toBe(true);
      expect(typeof event.t).toBe('number');
      expect(event.t).toBeGreaterThanOrEqual(beforeStart);
      expect(event.t).toBeLessThanOrEqual(afterStop);
    }

    // Down/up alternation and order
    const expectedKeys = ['s', 'e', 'c', 'u', 'r', 'e'];
    for (let i = 0; i < expectedKeys.length; i++) {
      const downEvent = events[i * 2];
      const upEvent = events[i * 2 + 1];
      if (!downEvent || !upEvent) throw new Error('Missing event pair');
      if (downEvent.type === 'blur' || upEvent.type === 'blur') throw new Error('Unexpected blur');

      expect(downEvent.key).toBe(expectedKeys[i] ?? '');
      expect(downEvent.type).toBe('down');
      expect(upEvent.key).toBe(expectedKeys[i] ?? '');
      expect(upEvent.type).toBe('up');
      expect(upEvent.t).toBeGreaterThanOrEqual(downEvent.t);
    }

    // Validates with extractFeatures
    const features = extractFeatures(events, 6);
    expect('error' in features).toBe(false);
    if (!('error' in features)) {
      expect(features.version).toBe(1);
      expect(features.len).toBe(6);
      expect(features.values.length).toBe(23);
    }
  });

  it('case 3: onPulse fires per keydown', () => {
    let pulseCount = 0;
    const session = startCapture(toInput(inputElement), toElement(lightElement), {
      onPulse: () => {
        pulseCount++;
      },
    });

    // 3a. Initial count is 0
    expect(pulseCount).toBe(0);

    // 3b. Keydown fires onPulse
    dispatchKey(inputElement, 'keydown', 'a', false);
    expect(pulseCount).toBe(1);

    // 3c. Keyup does NOT fire onPulse
    dispatchKey(inputElement, 'keyup', 'a', false);
    expect(pulseCount).toBe(1);

    // 3d. Auto-repeat keydown (repeat: true) does NOT fire onPulse
    dispatchKey(inputElement, 'keydown', 'a', true);
    expect(pulseCount).toBe(1);

    // 3e. Modifier keydown does NOT fire onPulse
    dispatchKey(inputElement, 'keydown', 'Shift', false);
    expect(pulseCount).toBe(1);

    // 3f. Another normal keydown fires onPulse
    dispatchKey(inputElement, 'keydown', 'b', false);
    expect(pulseCount).toBe(2);

    session.stop();
  });

  it('case 4: stop() removes listeners', () => {
    let pulseCount = 0;
    const session = startCapture(toInput(inputElement), toElement(lightElement), {
      onPulse: () => {
        pulseCount++;
      },
    });

    typeKey(inputElement, 'x');
    expect(pulseCount).toBe(1);

    const events = session.stop();
    expect(events.length).toBe(2);

    // Dispatch events after stop()
    typeKey(inputElement, 'y');
    expect(pulseCount).toBe(1); // onPulse must not fire

    // stop() returns the captured events and does not capture new ones
    const stoppedAgain = session.stop();
    expect(stoppedAgain.length).toBe(2);
  });

  it('case 4b: cancel() removes listeners and discards events', () => {
    let pulseCount = 0;
    const session = startCapture(toInput(inputElement), toElement(lightElement), {
      onPulse: () => {
        pulseCount++;
      },
    });

    typeKey(inputElement, 'x');
    expect(pulseCount).toBe(1);

    session.cancel();

    // After cancel, listeners are detached
    typeKey(inputElement, 'y');
    expect(pulseCount).toBe(1);

    // After cancel, events are discarded
    expect(session.stop().length).toBe(0);
  });

  it('case 5: ignores modifier-only keys (Shift, Ctrl, Alt, Meta) but records Backspace', () => {
    let pulseCount = 0;
    const session = startCapture(toInput(inputElement), toElement(lightElement), {
      onPulse: () => {
        pulseCount++;
      },
    });

    // Ignored modifiers
    // A-14.1 reversed this: modifiers are recorded, because their down/up pairs are
    // what distinguish a lone tap (a Phantom Key) from a held modifier and a chord.
    for (const mod of ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock']) {
      typeKey(inputElement, mod);
    }
    // They still do not pulse the light — the pulse marks a character, not a modifier.
    expect(pulseCount).toBe(0);

    // The locks change nothing about the script and are still dropped.
    for (const lock of ['NumLock', 'ScrollLock']) {
      typeKey(inputElement, lock);
    }

    typeKey(inputElement, 'Backspace');
    expect(pulseCount).toBe(1);

    const events = session.stop();
    // Five modifiers plus Backspace, down and up each; the two locks contribute none.
    expect(events.length).toBe(12);
    expect(events.filter((e) => e.type !== 'blur' && e.key === 'NumLock')).toHaveLength(0);

    const last = events.slice(-2);
    expect(last.every((e) => e.type !== 'blur' && e.key === 'Backspace')).toBe(true);
  });

  it('records a blur, so a sample that lost focus can be voided', () => {
    const session = startCapture(toInput(inputElement), toElement(lightElement));

    typeKey(inputElement, 'a');
    inputElement.dispatchEvent(new window.Event('blur'));

    const events = session.stop();
    expect(events.some((e) => e.type === 'blur')).toBe(true);
    expect(eventsToScript(events)).toMatchObject({ error: 'focus_lost' });
  });

  it('records the physical key alongside the character', () => {
    const session = startCapture(toInput(inputElement), toElement(lightElement));
    typeKey(inputElement, 'a');
    const events = session.stop();
    const down = events[0];
    if (down === undefined || down.type === 'blur') throw new Error('expected a keydown');
    // Without this, releasing Shift before a letter unpairs the keystroke entirely.
    expect(down.code).toBe('KeyA');
  });

  it('Backspace is a legitimate keystroke now, not a rejected one', () => {
    const session = startCapture(toInput(inputElement), toElement(lightElement));

    for (const key of ['a', 'x', 'Backspace', 'b']) typeKey(inputElement, key);

    const events = session.stop();
    const script = eventsToScript(events);
    expect('error' in script).toBe(false);
    if ('error' in script) throw new Error('unreachable');
    expect(script.resolved).toBe('ab');

    const features = extractFeatures(events, 4);
    expect('error' in features).toBe(false);
  });

  it('a paste, a drop or an IME composition voids the sample', () => {
    for (const eventName of ['paste', 'drop', 'compositionstart']) {
      const reasons: string[] = [];
      const session = startCapture(toInput(inputElement), toElement(lightElement), {
        onCancel: (reason) => reasons.push(reason),
      });

      typeKey(inputElement, 'a');
      inputElement.dispatchEvent(new window.Event(eventName));

      expect(reasons).toEqual(['unsupported_key']);
      // The buffer is emptied, so a cancelled attempt cannot be salvaged.
      expect(session.stop()).toHaveLength(0);
    }
  });

  it('drops auto-repeat, which is not a rhythm signal and cannot be paired', () => {
    const session = startCapture(toInput(inputElement), toElement(lightElement));

    dispatchKey(inputElement, 'keydown', 'a', false);
    dispatchKey(inputElement, 'keydown', 'a', true);
    dispatchKey(inputElement, 'keydown', 'a', true);
    dispatchKey(inputElement, 'keyup', 'a', false);

    expect(session.stop()).toHaveLength(2);
  });
});
