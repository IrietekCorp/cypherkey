import { describe, expect, it } from 'bun:test';
import { extractFeatures } from './features';
import type { KeyEvent } from './types';

describe('extractFeatures', () => {
  const createValid6KeySequence = (): KeyEvent[] => [
    { key: 's', type: 'down', t: 100 },
    { key: 's', type: 'up', t: 180 },
    { key: 'e', type: 'down', t: 220 },
    { key: 'e', type: 'up', t: 290 },
    { key: 'c', type: 'down', t: 350 },
    { key: 'c', type: 'up', t: 440 },
    { key: 'u', type: 'down', t: 480 },
    { key: 'u', type: 'up', t: 560 },
    { key: 'r', type: 'down', t: 600 },
    { key: 'r', type: 'up', t: 670 },
    { key: 'e', type: 'down', t: 720 },
    { key: 'e', type: 'up', t: 820 },
  ];

  it('case 1: synthetic 6-key sequence yields length 23 with known dwell/flight/digraph values', () => {
    const events = createValid6KeySequence();
    const result = extractFeatures(events, 6);

    expect('error' in result).toBe(false);
    if ('error' in result) return;

    expect(result.version).toBe(1);
    expect(result.len).toBe(6);
    // length must be 3*len + 5 = 23
    expect(result.values.length).toBe(23);

    // Known dwells [0..5]
    expect(result.values.slice(0, 6)).toEqual([80, 70, 90, 80, 70, 100]);

    // Known flights [6..10]
    expect(result.values.slice(6, 11)).toEqual([40, 60, 40, 40, 50]);

    // Known digraphs [11..15]
    expect(result.values.slice(11, 16)).toEqual([120, 130, 130, 120, 120]);

    // Known globals [16..22]
    // [totalTime, meanDwell, stdDwell, meanFlight, stdFlight, meanDigraph, stdDigraph]
    expect(result.values[16]).toBe(720); // totalTime: 820 - 100
    expect(result.values[17]).toBeCloseTo(81.6667, 3); // meanDwell
    expect(result.values[19]).toBe(46); // meanFlight
    expect(result.values[21]).toBe(124); // meanDigraph
  });

  it('case 2: any Backspace event returns { error: "backspace" }', () => {
    const eventsWithBackspace: KeyEvent[] = [
      { key: 'a', type: 'down', t: 100 },
      { key: 'a', type: 'up', t: 180 },
      { key: 'Backspace', type: 'down', t: 200 },
      { key: 'Backspace', type: 'up', t: 250 },
      { key: 'b', type: 'down', t: 300 },
      { key: 'b', type: 'up', t: 380 },
    ];

    const result = extractFeatures(eventsWithBackspace, 2);
    expect(result).toEqual({ error: 'backspace' });
  });

  it('case 3: unmatched down/up returns { error: "malformed" }', () => {
    // Missing up event
    const missingUp: KeyEvent[] = [
      { key: 'a', type: 'down', t: 100 },
      { key: 'b', type: 'down', t: 200 },
      { key: 'b', type: 'up', t: 280 },
    ];
    expect(extractFeatures(missingUp, 2)).toEqual({ error: 'malformed' });

    // Up before down
    const upBeforeDown: KeyEvent[] = [
      { key: 'a', type: 'up', t: 100 },
      { key: 'a', type: 'down', t: 150 },
    ];
    expect(extractFeatures(upBeforeDown, 1)).toEqual({ error: 'malformed' });

    // Key mismatch in down/up pair
    const keyMismatch: KeyEvent[] = [
      { key: 'a', type: 'down', t: 100 },
      { key: 'b', type: 'up', t: 150 },
    ];
    expect(extractFeatures(keyMismatch, 1)).toEqual({ error: 'malformed' });
  });

  it('case 4: wrong key count returns { error: "length_mismatch" }', () => {
    const events = createValid6KeySequence(); // 6 keys
    // Expect 5 keys instead of 6
    expect(extractFeatures(events, 5)).toEqual({ error: 'length_mismatch' });
    // Expect 7 keys instead of 6
    expect(extractFeatures(events, 7)).toEqual({ error: 'length_mismatch' });
  });

  it('case 5: deterministic output for identical input', () => {
    const events1 = createValid6KeySequence();
    const events2 = createValid6KeySequence();

    const res1 = extractFeatures(events1, 6);
    const res2 = extractFeatures(events2, 6);

    expect(res1).toEqual(res2);
  });
});
