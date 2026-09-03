import { beforeEach, describe, expect, it } from 'bun:test';
import { KeyboardEvent as HappyKeyboardEvent, Window } from 'happy-dom';
import { startCapture } from './capture';
import { extractFeatures } from './features';

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
    const modifiers = ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock'];

    for (const mod of modifiers) {
      typeKey(inputElement, mod);
    }

    // None of the modifiers should have fired pulse
    expect(pulseCount).toBe(0);

    // Backspace must be recorded and pulse
    typeKey(inputElement, 'Backspace');
    expect(pulseCount).toBe(1);

    const events = session.stop();

    // Only Backspace events (down and up) should be present
    expect(events.length).toBe(2);
    const downEvt = events[0];
    const upEvt = events[1];
    if (!downEvt || !upEvt) throw new Error('Missing event pair');

    expect(downEvt.key).toBe('Backspace');
    expect(downEvt.type).toBe('down');
    expect(upEvt.key).toBe('Backspace');
    expect(upEvt.type).toBe('up');

    // extractFeatures recognizes backspace and rejects per security policy
    expect(extractFeatures(events, 1)).toEqual({ error: 'backspace' });
  });
});
