import { describe, expect, test } from 'bun:test';
import {
  type CaptureAdapter,
  type KeySource,
  type RhythmIndicator,
  RhythmLightNotVisible,
  startCaptureWith,
} from './capture-contract';
import { eventsToScript } from './script';
import type { KeyEvent, ScriptError } from './types';

/** An indicator whose visibility the test controls, recording every pulse. */
function fakeIndicator(visible = true) {
  const state = { visible, pulses: 0, visibilityChecks: 0 };
  const indicator: RhythmIndicator = {
    isVisible() {
      state.visibilityChecks += 1;
      return state.visible;
    },
    pulse() {
      state.pulses += 1;
    },
  };
  return { indicator, state };
}

/** A key source the test drives directly. */
function fakeSource() {
  const state = { listening: false };
  let emit: ((event: KeyEvent) => void) | null = null;
  let pulse: (() => void) | null = null;
  let abandon: ((reason: ScriptError) => void) | null = null;

  const source: KeySource = {
    listen(handlers) {
      state.listening = true;
      emit = handlers.onEvent;
      pulse = handlers.onPulse;
      abandon = handlers.onAbandon;
      return () => {
        state.listening = false;
        emit = null;
        pulse = null;
        abandon = null;
      };
    },
  };

  return {
    source,
    state,
    /** `modifiers` are recorded but do not pulse, as A-14.1 requires. */
    type(keys: string[], dwell = 40, gap = 80, modifiers: string[] = []) {
      let t = 0;
      for (const key of keys) {
        emit?.({ type: 'down', key, t });
        if (!modifiers.includes(key)) pulse?.();
        emit?.({ type: 'up', key, t: t + dwell });
        t += gap;
      }
    },
    abandon(reason: ScriptError) {
      abandon?.(reason);
    },
  };
}

const build = (visible = true) => {
  const light = fakeIndicator(visible);
  const keys = fakeSource();
  const adapter: CaptureAdapter = { indicator: light.indicator, source: keys.source };
  return { adapter, light, keys };
};

describe('the light is still the gate (X-1)', () => {
  test('a hidden indicator refuses capture', () => {
    const { adapter } = build(false);
    expect(() => startCaptureWith(adapter)).toThrow(RhythmLightNotVisible);
  });

  /**
   * Checked before a listener is attached, not after. A platform that hides its
   * indicator never sees an event, rather than seeing them and discarding them — the
   * second version has the timings in memory at some point, and this one never does.
   */
  test('a hidden indicator never attaches a listener', () => {
    const { adapter, keys } = build(false);
    expect(() => startCaptureWith(adapter)).toThrow();
    expect(keys.state.listening).toBe(false);
  });

  test('visibility is asked, not assumed', () => {
    const { adapter, light } = build();
    startCaptureWith(adapter);
    expect(light.state.visibilityChecks).toBe(1);
  });

  /** A light visible a minute ago says nothing about a window since minimised. */
  test('it is asked again on the next capture, not cached', () => {
    const { adapter, light } = build();
    startCaptureWith(adapter).stop();
    light.state.visible = false;

    expect(() => startCaptureWith(adapter)).toThrow(RhythmLightNotVisible);
    expect(light.state.visibilityChecks).toBe(2);
  });
});

describe('capturing', () => {
  test('events are collected in order', () => {
    const { adapter, keys } = build();
    const handle = startCaptureWith(adapter);
    keys.type(['a', 'b']);

    const events = handle.stop();
    expect(events).toHaveLength(4);
    expect(events[0]).toMatchObject({ type: 'down', key: 'a' });
    expect(events[3]).toMatchObject({ type: 'up', key: 'b' });
  });

  test('the indicator pulses once per keystroke', () => {
    const { adapter, light, keys } = build();
    const handle = startCaptureWith(adapter);
    keys.type(['c', 'o', 'r', 'r', 'e', 'c', 't']);
    handle.stop();

    expect(light.state.pulses).toBe(7);
  });

  /**
   * A-14.1 records a modifier's down/up pair, but a lone Shift is not a keystroke
   * anyone expects to see pulse. Which keys are modifiers is platform knowledge, so
   * the adapter decides and the contract does not guess.
   */
  test('a modifier is recorded without pulsing', () => {
    const { adapter, light, keys } = build();
    const handle = startCaptureWith(adapter);
    keys.type(['Shift', 'P'], 40, 80, ['Shift']);

    expect(handle.stop()).toHaveLength(4);
    expect(light.state.pulses).toBe(1);
  });

  test('stopping detaches the listener', () => {
    const { adapter, keys } = build();
    const handle = startCaptureWith(adapter);
    handle.stop();
    expect(keys.state.listening).toBe(false);
  });

  test('events after stopping are ignored', () => {
    const { adapter, keys } = build();
    const handle = startCaptureWith(adapter);
    keys.type(['a']);
    const first = handle.stop();

    keys.type(['b']);
    expect(handle.stop()).toEqual([]);
    expect(first).toHaveLength(2);
  });

  /** A cancelled attempt must not be recoverable by anything still holding the handle. */
  test('cancelling empties the buffer rather than flagging it', () => {
    const { adapter, keys } = build();
    const handle = startCaptureWith(adapter);
    keys.type(['a', 'b']);

    handle.cancel();
    expect(handle.stop()).toEqual([]);
  });

  test('an abandoned sample discards what it had', () => {
    const { adapter, keys } = build();
    const handle = startCaptureWith(adapter);
    keys.type(['a', 'b']);

    keys.abandon('unsupported_key');
    expect(handle.stop()).toEqual([]);
  });

  test('capture continues after an abandon, so a retry needs no new handle', () => {
    const { adapter, keys } = build();
    const handle = startCaptureWith(adapter);
    keys.type(['a']);
    keys.abandon('unsupported_key');
    keys.type(['b']);

    // The abandoned prefix is gone; what follows is a fresh attempt.
    expect(handle.stop()).toHaveLength(2);
  });
});

describe('it produces what the rest of the pipeline expects', () => {
  /**
   * The point of the contract: a platform with no DOM feeds the same tokenizer, so a
   * CLI and a browser derive the same script from the same typing.
   */
  test('collected events tokenize into a script', () => {
    const { adapter, keys } = build();
    const handle = startCaptureWith(adapter);
    keys.type([...'correct horse']);

    const result = eventsToScript(handle.stop());
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.resolved).toBe('correct horse');
    }
  });

  test('a blur variant still voids the sample downstream', () => {
    const { adapter, keys } = build();
    const handle = startCaptureWith(adapter);
    keys.type(['a']);

    // A terminal has no blur, so a platform that cannot detect focus loss simply never
    // emits one — but the union still carries it for those that can.
    const events = [...handle.stop(), { type: 'blur' as const, t: 999 }];
    const result = eventsToScript(events);
    expect('error' in result && result.error).toBe('focus_lost');
  });
});

describe('what the contract deliberately does not offer', () => {
  /**
   * A richer indicator interface invites an adapter to report "visible" from
   * configuration rather than from the world, which is the failure X-1 exists to
   * prevent. One method that must be answered honestly is the whole design.
   */
  test('the indicator has exactly two methods', () => {
    const { light } = build();
    expect(Object.keys(light.indicator).sort()).toEqual(['isVisible', 'pulse']);
  });

  test('there is no way to start capture without an indicator', async () => {
    const source = await Bun.file(`${import.meta.dir}/capture-contract.ts`).text();
    // No default, no opt-out, no "headless" flag.
    expect(source).not.toContain('skipVisibility');
    expect(source).not.toContain('headless');
    expect(source).toContain('if (!adapter.indicator.isVisible())');
  });
});
