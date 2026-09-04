import { describe, expect, test } from 'bun:test';
import {
  BACKSPACE,
  DELETE,
  ESCAPE,
  MODIFIER_TOKENS,
  eventsToScript,
  resolveScript,
  scriptLength,
  scriptsEqual,
} from './script';
import type { KeyEvent } from './types';

/** Builds a plausible event stream: each key held 50 ms, 100 ms apart. */
function type(keys: string[], start = 1000): KeyEvent[] {
  const events: KeyEvent[] = [];
  let t = start;
  for (const key of keys) {
    events.push({ type: 'down', key, t });
    events.push({ type: 'up', key, t: t + 50 });
    t += 100;
  }
  return events;
}

/** A key held down across other keys, as Shift is when making a capital. */
function hold(key: string, inner: string[], start = 1000): KeyEvent[] {
  const events: KeyEvent[] = [{ type: 'down', key, t: start }];
  let t = start + 20;
  for (const k of inner) {
    events.push({ type: 'down', key: k, t });
    events.push({ type: 'up', key: k, t: t + 50 });
    t += 100;
  }
  events.push({ type: 'up', key, t: t + 10 });
  return events;
}

const ok = (r: ReturnType<typeof eventsToScript>) => {
  if ('error' in r) throw new Error(`expected a script, got ${r.error}`);
  return r;
};

describe('the eight cases of A-14.1', () => {
  // (1)
  test('a corrected passphrase keeps every keystroke and resolves to the text', () => {
    const r = ok(
      eventsToScript(
        type(['p', 'a', 's', 's', 's', 's', 'Backspace', 'Backspace', 'w', '0', 'r', 'd']),
      ),
    );
    expect(scriptLength(r.script)).toBe(12);
    expect(r.resolved).toBe('passw0rd');
    expect(r.script).toBe(`passss${BACKSPACE}${BACKSPACE}w0rd`);
  });

  // (2)
  test('Shift held to make a capital yields one token and no modifier token', () => {
    const r = ok(eventsToScript(hold('Shift', ['P'])));
    expect(r.script).toBe('P');
    expect(scriptLength(r.script)).toBe(1);
    expect(r.resolved).toBe('P');
  });

  // (3)
  test('a lone Ctrl tap is a token', () => {
    const events: KeyEvent[] = [
      { type: 'down', key: 'a', t: 1000 },
      { type: 'up', key: 'a', t: 1050 },
      { type: 'down', key: 'Control', t: 1100 },
      { type: 'up', key: 'Control', t: 1150 },
      { type: 'down', key: 'b', t: 1200 },
      { type: 'up', key: 'b', t: 1250 },
    ];
    const r = ok(eventsToScript(events));
    expect(r.script).toBe(`a${MODIFIER_TOKENS.Control}b`);
    expect(r.script).toBe('a\uE001b');
    expect(r.resolved).toBe('ab');
  });

  // (4)
  test('Ctrl+A cancels the sample', () => {
    expect(eventsToScript(hold('Control', ['a']))).toMatchObject({ error: 'unsupported_combo' });
  });

  // (5)
  test('ArrowLeft cancels the sample', () => {
    expect(eventsToScript(type(['a', 'ArrowLeft', 'b']))).toMatchObject({
      error: 'unsupported_key',
    });
  });

  // (6)
  test('a blur mid-sample cancels it', () => {
    const events = type(['a', 'b']);
    events.splice(2, 0, { type: 'blur', t: 1075 });
    expect(eventsToScript(events)).toMatchObject({ error: 'focus_lost' });
  });

  // (7)
  test('Escape is a token', () => {
    const r = ok(eventsToScript(type(['a', 'Escape', 'b'])));
    expect(r.script).toBe(`a${ESCAPE}b`);
    expect(r.script).toBe('a\u001Bb');
    expect(r.resolved).toBe('ab');
  });

  // (8)
  test('the corrected script is not equal to its own resolved text', () => {
    const r = ok(
      eventsToScript(
        type(['p', 'a', 's', 's', 's', 's', 'Backspace', 'Backspace', 'w', '0', 'r', 'd']),
      ),
    );
    expect(scriptsEqual(r.script, 'passw0rd')).toBe(false);
    expect(scriptsEqual(r.script, r.script)).toBe(true);
  });
});

describe('the other modifier taps', () => {
  test.each([
    ['Shift', '\uE000'],
    ['Control', '\uE001'],
    ['Alt', '\uE002'],
    ['Meta', '\uE003'],
    ['CapsLock', '\uE004'],
  ])('a lone %s tap is %s', (key, token) => {
    const events: KeyEvent[] = [
      { type: 'down', key, t: 1000 },
      { type: 'up', key, t: 1050 },
      { type: 'down', key: 'a', t: 1100 },
      { type: 'up', key: 'a', t: 1150 },
    ];
    expect(ok(eventsToScript(events)).script).toBe(`${token}a`);
  });

  test('Alt or Meta held over a key is a chord, not a tap', () => {
    expect(eventsToScript(hold('Alt', ['a']))).toMatchObject({ error: 'unsupported_combo' });
    expect(eventsToScript(hold('Meta', ['a']))).toMatchObject({ error: 'unsupported_combo' });
  });

  test('CapsLock held over a key is not a chord — it changes case, it does not command', () => {
    expect(ok(eventsToScript(hold('CapsLock', ['A']))).script).toBe('A');
  });
});

describe('resolution (A-14.1 caret model)', () => {
  test('Delete is always a pure phantom, since the caret is always at the end', () => {
    const r = ok(eventsToScript(type(['a', 'Delete', 'b'])));
    expect(scriptLength(r.script)).toBe(3);
    expect(r.resolved).toBe('ab');
  });

  test('Backspace on an empty field is still a token and still a no-op', () => {
    const r = ok(eventsToScript(type(['Backspace', 'a'])));
    expect(scriptLength(r.script)).toBe(2);
    expect(r.resolved).toBe('a');
  });

  test('a script of nothing but phantoms resolves to the empty string', () => {
    expect(resolveScript(`${ESCAPE}${DELETE}\uE001`)).toBe('');
  });

  test('two different scripts can share one resolved text — that is the whole point', () => {
    const plain = ok(eventsToScript(type(['a', 'b'])));
    const phantom = ok(eventsToScript(type(['a', 'x', 'Backspace', 'b'])));
    expect(plain.resolved).toBe(phantom.resolved);
    expect(scriptsEqual(plain.script, phantom.script)).toBe(false);
  });
});

describe('keys that cancel a sample', () => {
  test.each([
    'Tab',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'Insert',
    'F1',
  ])('%s is unsupported', (key) => {
    expect(eventsToScript(type(['a', key, 'b']))).toMatchObject({ error: 'unsupported_key' });
  });

  test('a non-ASCII character is unsupported', () => {
    for (const key of ['é', '密', '🔑']) {
      expect(eventsToScript(type(['a', key]))).toMatchObject({ error: 'unsupported_key' });
    }
  });

  test('Enter terminates when it comes last, and cancels anywhere else', () => {
    expect(ok(eventsToScript(type(['a', 'b', 'Enter']))).script).toBe('ab');
    expect(eventsToScript(type(['a', 'Enter', 'b']))).toMatchObject({ error: 'unsupported_key' });
  });
});

describe('malformed streams', () => {
  /**
   * A key released but never pressed is a straggler from before capture began — most
   * often Shift held across the end of one sample and into the next. It contributed
   * nothing to a field that was cleared when capture started, so it is dropped rather
   * than allowed to void a sample the user typed correctly.
   */
  test('a leading orphan keyup is ignored, not fatal', () => {
    const events: KeyEvent[] = [{ type: 'up', key: 'Shift', t: 900 }, ...type(['a', 'b'], 1000)];
    const r = eventsToScript(events);
    if ('error' in r) throw new Error(`expected a script, got ${r.error}: ${r.detail}`);
    expect(r.script).toBe('ab');
  });

  test('an orphan keyup mid-sample is ignored too', () => {
    const events: KeyEvent[] = [
      ...type(['a'], 1000),
      { type: 'up', key: 'Control', t: 1150 },
      ...type(['b'], 1200),
    ];
    const r = eventsToScript(events);
    if ('error' in r) throw new Error(`expected a script, got ${r.error}`);
    expect(r.script).toBe('ab');
  });

  test('but releasing a key more often than it was pressed is still malformed', () => {
    expect(
      eventsToScript([
        { type: 'down', key: 'a', t: 1000 },
        { type: 'up', key: 'a', t: 1050 },
        { type: 'up', key: 'a', t: 1060 },
      ]),
    ).toEqual({ error: 'malformed', detail: 'a released more times than it was pressed' });
  });

  test('a keydown that is never released says which key', () => {
    expect(eventsToScript([{ type: 'down', key: 'a', t: 1000 }])).toEqual({
      error: 'malformed',
      detail: 'a still held when the sample ended',
    });
  });

  test('a keyup before its keydown', () => {
    expect(
      eventsToScript([
        { type: 'down', key: 'a', t: 1000 },
        { type: 'up', key: 'a', t: 900 },
      ]),
    ).toMatchObject({ error: 'malformed' });
  });

  test('an empty sample says so', () => {
    expect(eventsToScript([])).toEqual({ error: 'malformed', detail: 'no keystrokes captured' });
  });

  test('a sample of nothing but an orphan keyup has no keystrokes at all', () => {
    expect(eventsToScript([{ type: 'up', key: 'Shift', t: 1000 }])).toEqual({
      error: 'malformed',
      detail: 'no keystrokes captured',
    });
  });

  test('every rejection carries a non-empty detail', () => {
    const cases: KeyEvent[][] = [
      [],
      [{ type: 'up', key: 'a', t: 1 }],
      [
        { type: 'down', key: 'a', t: 1 },
        { type: 'up', key: 'a', t: 2 },
        { type: 'up', key: 'a', t: 3 },
      ],
      [{ type: 'down', key: 'a', t: 1 }],
      [{ type: 'blur', t: 1 }],
      type(['a', 'ArrowLeft']),
      hold('Control', ['a']),
    ];
    for (const events of cases) {
      const result = eventsToScript(events);
      if (!('error' in result)) throw new Error('expected a rejection');
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });
});

describe('scriptsEqual', () => {
  test('is true only for identical scripts', () => {
    expect(scriptsEqual('abc', 'abc')).toBe(true);
    expect(scriptsEqual('abc', 'abd')).toBe(false);
    expect(scriptsEqual('abc', 'ab')).toBe(false);
    expect(scriptsEqual('', '')).toBe(true);
  });

  test('distinguishes phantoms that resolve alike', () => {
    expect(scriptsEqual(`ab${ESCAPE}`, 'ab')).toBe(false);
    expect(scriptsEqual(`a${DELETE}b`, `a${ESCAPE}b`)).toBe(false);
  });

  test('does not short-circuit on the first differing token', () => {
    const base = 'a'.repeat(512);
    expect(scriptsEqual(base, `b${base.slice(1)}`)).toBe(false);
    expect(scriptsEqual(base, `${base.slice(0, -1)}b`)).toBe(false);
  });
});

describe('scriptLength', () => {
  test('counts tokens, including the invisible ones', () => {
    expect(scriptLength(`pass${BACKSPACE}word`)).toBe(9);
    expect(scriptLength(`${ESCAPE}\uE001${DELETE}`)).toBe(3);
    expect(scriptLength('')).toBe(0);
  });
});
