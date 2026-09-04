import { equalBytes, utf8Encode } from '../crypto/encoding';
import type { KeyEvent, ScriptError } from './types';

/** One script token: a single code point, per the A-14.1 table. */
export type Token = string;

/** Non-printable tokens (A-14.1). */
export const BACKSPACE = '\u0008';
export const DELETE = '\u007F';
export const ESCAPE = '\u001B';

/** Lone modifier taps, in the Unicode private-use area so they cannot collide with text. */
export const MODIFIER_TOKENS: Readonly<Record<string, Token>> = {
  Shift: '\uE000',
  Control: '\uE001',
  Alt: '\uE002',
  Meta: '\uE003',
  CapsLock: '\uE004',
};

const MODIFIER_TOKEN_VALUES = new Set(Object.values(MODIFIER_TOKENS));

/** Holding any of these while pressing another key is a chord, which voids the sample. */
const CHORD_MODIFIERS = new Set(['Control', 'Alt', 'Meta']);

/** A token together with the timings of the physical key that produced it. */
export type TimedToken = { token: Token; downT: number; upT: number };

export type ScriptResult = { script: string; resolved: string };
export type TimedResult = { tokens: TimedToken[]; resolved: string };

/**
 * A rejection, with enough detail to act on.
 *
 * `error` is the A-14.1 category; `detail` says which specific condition tripped and
 * which key was involved. Five different conditions used to report a bare
 * `'malformed'`, which told a user nothing and told us less.
 */
export type ScriptFailure = { error: ScriptError; detail: string };

/** Renders a token so an invisible one is visible in a message. */
export function readableToken(token: Token): string {
  if (token === BACKSPACE) return '⌫';
  if (token === DELETE) return '⌦';
  if (token === ESCAPE) return '⎋';
  const modifier = Object.entries(MODIFIER_TOKENS).find(([, value]) => value === token);
  if (modifier !== undefined) return `${modifier[0]}-tap`;
  return token === ' ' ? '␣' : token;
}

/** The raw key sequence, for diagnostics. Keys only — no timings, ever. */
export function describeEvents(events: KeyEvent[]): string {
  return events
    .map((e) =>
      e.type === 'blur'
        ? '⟨blur⟩'
        : `${e.key === ' ' ? '␣' : e.key}${e.type === 'down' ? '↓' : '↑'}`,
    )
    .join(' ');
}

function isPrintableAscii(key: string): boolean {
  if (key.length !== 1) return false;
  const code = key.charCodeAt(0);
  return code >= 0x20 && code <= 0x7e;
}

/** Maps a `KeyboardEvent.key` to its token, or null if it does not produce one. */
function tokenFor(key: string): Token | null {
  if (isPrintableAscii(key)) return key;
  if (key === 'Backspace') return BACKSPACE;
  if (key === 'Delete') return DELETE;
  if (key === 'Escape') return ESCAPE;
  return null;
}

/**
 * Applies the script to an empty field, left to right, to get the text a normal form
 * would have received.
 *
 * Every key that could move the caret voids the sample (A-14.1), so the caret is
 * always at the end and no caret tracking is needed: Backspace removes the last
 * character, Delete at end-of-text is a no-op, and Escape and modifier taps are
 * pure phantoms.
 */
export function resolveScript(script: string): string {
  let out = '';
  for (const token of script) {
    if (token === BACKSPACE) out = out.slice(0, -1);
    else if (token === DELETE || token === ESCAPE) continue;
    else if (MODIFIER_TOKEN_VALUES.has(token)) continue;
    else out += token;
  }
  return out;
}

/**
 * Turns raw key events into the ordered token sequence of A-14.1, keeping the timing
 * of each token so feature extraction does not have to tokenize a second time.
 *
 * This is the single definition of tokenization; `eventsToScript` and
 * `extractFeatures` both go through it.
 */
export function eventsToTokens(events: KeyEvent[]): TimedResult | ScriptFailure {
  const held = new Map<string, { downT: number; used: boolean }>();
  const pending = new Map<string, number[]>();
  const tokens: TimedToken[] = [];

  const lastDownIndex = events.reduce((last, e, i) => (e.type === 'down' ? i : last), -1);

  for (let i = 0; i < events.length; i++) {
    const event = events[i] as KeyEvent;

    if (event.type === 'blur') return { error: 'focus_lost', detail: `blur at event ${i}` };

    if (event.type === 'down') {
      const key = event.key;

      if (key in MODIFIER_TOKENS) {
        held.set(key, { downT: event.t, used: false });
        continue;
      }

      // A-14.1: Ctrl/Alt/Meta plus a key is a chord, reserved for a future feature.
      for (const modifier of held.keys()) {
        if (CHORD_MODIFIERS.has(modifier)) {
          return { error: 'unsupported_combo', detail: `${modifier}+${key}` };
        }
      }
      // Shift held to make a capital is not a token of its own — the key it modified
      // already carries the uppercase character.
      for (const state of held.values()) state.used = true;

      // Enter ends the sample when it comes last; anywhere else it is a key this
      // format does not carry.
      if (key === 'Enter') {
        if (i === lastDownIndex) continue;
        return { error: 'unsupported_key', detail: 'Enter pressed mid-sample' };
      }

      const token = tokenFor(key);
      if (token === null) return { error: 'unsupported_key', detail: key };

      const queue = pending.get(key) ?? [];
      queue.push(tokens.length);
      pending.set(key, queue);
      tokens.push({ token, downT: event.t, upT: Number.NaN });
      continue;
    }

    // keyup
    const key = event.key;
    if (key in MODIFIER_TOKENS) {
      const state = held.get(key);
      if (state === undefined) {
        // A straggler: capture began while this modifier was already down, so its
        // press belongs to whatever happened before the sample started. Holding Shift
        // across the end of one sample and into the next does this every time. It
        // contributed nothing to a field that was cleared when capture began, so it is
        // dropped rather than allowed to void a sample the user typed correctly.
        continue;
      }
      held.delete(key);
      if (!state.used) {
        // Down and up with nothing in between: a deliberate phantom keystroke.
        tokens.push({ token: MODIFIER_TOKENS[key] as Token, downT: state.downT, upT: event.t });
      }
      continue;
    }

    const queue = pending.get(key);
    const index = queue?.shift();
    if (index === undefined) {
      // An Enter terminator produces no token, so its keyup has nothing to close.
      if (key === 'Enter') continue;
      // Never pressed during this sample: a straggler from before capture began, same
      // as the modifier case above. A key we *did* see pressed but whose presses are
      // all accounted for is a genuine double-release, and that is still malformed.
      if (!pending.has(key)) continue;
      return { error: 'malformed', detail: `${key} released more times than it was pressed` };
    }
    const token = tokens[index] as TimedToken;
    if (event.t < token.downT)
      return { error: 'malformed', detail: `${key} released before it was pressed` };
    token.upT = event.t;
  }

  if (tokens.length === 0) return { error: 'malformed', detail: 'no keystrokes captured' };
  const unreleased = tokens.find((t) => Number.isNaN(t.upT));
  if (unreleased !== undefined) {
    // Pressed but never released before the sample ended — usually a key still down
    // when the sample was submitted.
    return {
      error: 'malformed',
      detail: `${readableToken(unreleased.token)} still held when the sample ended`,
    };
  }

  tokens.sort((a, b) => a.downT - b.downT);
  return { tokens, resolved: resolveScript(tokens.map((t) => t.token).join('')) };
}

/**
 * The A-14.1 script for a sample, and the text a normal form would have received.
 * The script includes the Phantom Keys; the resolved text is what the KDF sees in
 * Medium and Relaxed (A-14.2).
 */
export function eventsToScript(events: KeyEvent[]): ScriptResult | ScriptFailure {
  const result = eventsToTokens(events);
  if ('error' in result) return result;
  return { script: result.tokens.map((t) => t.token).join(''), resolved: result.resolved };
}

/**
 * Constant-time script comparison, for the enrollment check that both typings match
 * (A-14). Length is compared first and is not secret — the server learns the script
 * length anyway — but the contents are compared without an early exit.
 */
export function scriptsEqual(a: string, b: string): boolean {
  return equalBytes(utf8Encode(a), utf8Encode(b));
}

/** Number of tokens in a script. Counts code points, not UTF-16 units. */
export function scriptLength(script: string): number {
  return [...script].length;
}
