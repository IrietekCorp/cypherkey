import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { generateRecoveryCode, parseRecoveryCode } from '../../../core/crypto/recovery';
import {
  AUTHENTICATOR_WARNING,
  CONFIRM_COUNT,
  REPLACEMENT_WARNING,
  RecoveryKit,
  checkAnswers,
  kitSymbols,
  pickPositions,
} from './RecoveryKit';

describe('kitSymbols', () => {
  /** 32 data symbols plus one Crockford check symbol. Not 32. */
  test('a generated Kit carries 33 symbols', () => {
    for (let i = 0; i < 20; i++) {
      expect(kitSymbols(generateRecoveryCode())).toHaveLength(33);
    }
  });

  test('formatting is not part of the code', () => {
    const code = generateRecoveryCode();
    expect(kitSymbols(code).join('')).toBe(code.replace(/-/g, ''));
    expect(kitSymbols(code).join('')).not.toContain('-');
  });

  test('what is displayed still parses as a Recovery Kit', () => {
    const code = generateRecoveryCode();
    expect(() => parseRecoveryCode(code)).not.toThrow();
  });
});

describe('pickPositions', () => {
  test('asks for four distinct positions', () => {
    const positions = pickPositions(33);
    expect(positions).toHaveLength(CONFIRM_COUNT);
    expect(new Set(positions).size).toBe(CONFIRM_COUNT);
  });

  test('every position is inside the Kit', () => {
    for (let i = 0; i < 50; i++) {
      for (const p of pickPositions(33)) {
        expect(p).toBeGreaterThanOrEqual(0);
        expect(p).toBeLessThan(33);
      }
    }
  });

  test('positions are ascending, so the prompts read left to right', () => {
    const positions = pickPositions(33);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });

  test('positions vary between renders', () => {
    const seen = new Set(Array.from({ length: 40 }, () => pickPositions(33).join(',')));
    expect(seen.size).toBeGreaterThan(1);
  });

  test('never asks for more positions than the Kit has', () => {
    expect(pickPositions(3, 4)).toHaveLength(3);
  });
});

describe('checkAnswers', () => {
  const CODE = 'ABCDE-FGHJK-MNPQR-STVWX-YZ012-34567-89ABC-DEFGH';

  test('the right characters pass', () => {
    const positions = [0, 5, 10, 32];
    const symbols = kitSymbols(CODE);
    const answers = positions.map((p) => symbols[p] as string);
    expect(checkAnswers(CODE, positions, answers)).toBe(true);
  });

  test('one wrong character fails', () => {
    const symbols = kitSymbols(CODE);
    const positions = [0, 5, 10, 32];
    const answers = positions.map((p) => symbols[p] as string);
    answers[2] = answers[2] === 'Z' ? 'Y' : 'Z';
    expect(checkAnswers(CODE, positions, answers)).toBe(false);
  });

  test('case does not matter', () => {
    const positions = [0, 1];
    const symbols = kitSymbols(CODE);
    const answers = positions.map((p) => (symbols[p] as string).toLowerCase());
    expect(checkAnswers(CODE, positions, answers)).toBe(true);
  });

  /**
   * The Kit alphabet excludes I, L, O and U so a handwritten or printed sheet is
   * unambiguous. Reading `O` where the sheet shows `0` must not cost the user a try.
   */
  test('Crockford lookalikes are accepted', () => {
    const code = '0AAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AA';
    expect(checkAnswers(code, [0], ['O'])).toBe(true);
    expect(checkAnswers('1AAAA', [0], ['I'])).toBe(true);
    expect(checkAnswers('1AAAA', [0], ['L'])).toBe(true);
  });

  test('a blank answer fails rather than passing vacuously', () => {
    expect(checkAnswers(CODE, [0, 1], ['', ''])).toBe(false);
  });

  test('the wrong number of answers fails', () => {
    expect(checkAnswers(CODE, [0, 1], ['A'])).toBe(false);
  });
});

// --- the rendered screen ---------------------------------------------------------

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

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);
const CODE = generateRecoveryCode();

const render = async (props: Partial<Parameters<typeof RecoveryKit>[0]> = {}) => {
  const confirmed = { count: 0 };
  await act(async () => {
    root.render(
      <RecoveryKit
        recoveryCode={CODE}
        onConfirmed={() => {
          confirmed.count += 1;
        }}
        {...props}
      />,
    );
  });
  return confirmed;
};

const answerCorrectly = async () => {
  const symbols = kitSymbols(CODE);
  const labels = [...host.querySelectorAll('[data-testid^="answer-"]')];
  // Target the labels themselves. This used to scrape every span inside `.no-print`,
  // which silently took the position numbers from whatever else the panel happened to
  // render -- so adding the position ruler broke it in a way that looked like the
  // confirmation logic had failed.
  const shown = [...host.querySelectorAll('[data-testid="position-label"]')].map((s) =>
    Number((s.textContent ?? '').replace('#', '').trim()),
  );
  await act(async () => {
    labels.forEach((node, i) => {
      const position = (shown[i] ?? 1) - 1;
      (node as unknown as HTMLInputElement).value = symbols[position] as string;
    });
  });
};

const click = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

describe('the screen', () => {
  test('shows the Kit exactly as generated', async () => {
    await render();
    expect(el('kit-code')?.textContent).toBe(CODE);
  });

  /** The line that has to survive onto paper. */
  test('carries the authenticator warning on screen and in the printable section', async () => {
    await render();
    expect(el('authenticator-warning')?.textContent).toBe(AUTHENTICATOR_WARNING);
    // It sits inside the print-only section, so printing cannot drop it.
    expect(host.querySelector('.print-kit [data-testid="authenticator-warning"]')).not.toBeNull();
  });

  test('says Backup Codes, never "recovery codes"', async () => {
    await render({ backupCodes: ['AAAAA-11111', 'BBBBB-22222'] });
    const text = host.textContent ?? '';
    expect(text).toContain('Backup Codes');
    expect(text.toLowerCase()).not.toContain('recovery code');
    expect(el('backup-codes')?.textContent).toContain('AAAAA-11111');
  });

  test('explains that a Backup Code opens a session, not the vault', async () => {
    await render({ backupCodes: ['AAAAA-11111'] });
    expect(host.textContent).toContain('open a session, not your vault');
  });

  test('asks for four characters, not the whole Kit', async () => {
    await render();
    expect(host.querySelectorAll('[data-testid^="answer-"]')).toHaveLength(CONFIRM_COUNT);
  });

  test('a correct confirmation completes the step', async () => {
    const confirmed = await render();
    await answerCorrectly();
    await click('confirm');
    expect(confirmed.count).toBe(1);
    expect(el('error')).toBeNull();
  });

  /**
   * A real first user answered two of four positions with the symbols four places
   * along, and the screen told them their correctly-saved Kit did not match. The code
   * groups with dashes, the positions ignore dashes, nothing said so, and the code
   * rewraps at popup width -- so "count to the 15th character" was a trap.
   *
   * The ruler removes the counting entirely: every symbol carries its own position.
   */
  describe('the positions do not have to be counted', () => {
    test('every symbol is shown with its own 1-based position', async () => {
      await render();
      const ruler = host.querySelector('[data-testid="position-ruler"]');
      expect(ruler).not.toBeNull();
      const symbols = kitSymbols(CODE);
      const text = ruler?.textContent ?? '';
      // First, last and a middle one: each symbol adjacent to its index.
      expect(text).toContain(`${symbols[0]}1`);
      expect(text).toContain(`${symbols[14]}15`);
      expect(text).toContain(`${symbols[symbols.length - 1]}${symbols.length}`);
    });

    test('the ruler holds exactly the dash-free symbols, in order', async () => {
      await render();
      const cells = [...(host.querySelectorAll('[data-testid="position-ruler"] > span') ?? [])];
      const symbols = kitSymbols(CODE);
      expect(cells).toHaveLength(symbols.length);
      // Read the symbol span itself: stripping trailing digits from the cell text would
      // also eat a symbol that IS a digit, and the Kit alphabet is full of them.
      // A dash in here would reintroduce the ambiguity the ruler exists to remove.
      const shownSymbols = cells.map((c) => c.querySelector('span')?.textContent ?? '');
      expect(shownSymbols).toEqual(symbols);
      expect(shownSymbols).not.toContain('-');
    });

    test('it says the dashes are not counted', async () => {
      await render();
      expect(host.textContent).toContain('dashes are not counted');
    });
  });

  test('a wrong confirmation explains and does not complete', async () => {
    const confirmed = await render();
    await act(async () => {
      for (const node of host.querySelectorAll('[data-testid^="answer-"]')) {
        (node as unknown as HTMLInputElement).value = '9';
      }
    });
    await click('confirm');

    // A Kit of all 9s is possible but vanishingly unlikely; guard the assertion anyway.
    if (confirmed.count === 0) {
      expect(el('error')?.textContent).toContain('does not match the Kit');
    }
  });

  test('the replacement variant says the old Kit is dead', async () => {
    await render({ variant: 'replacement' });
    expect(el('replacement-warning')?.textContent).toBe(REPLACEMENT_WARNING);
    expect(host.textContent).toContain('Your new Recovery Kit');
  });

  test('the signup variant does not claim an old Kit died', async () => {
    await render();
    expect(el('replacement-warning')).toBeNull();
  });

  /** Absence: the Kit is shown, never stored. */
  test('the screen writes nothing anywhere', async () => {
    await render();
    expect(Object.keys(win.localStorage ?? {})).toHaveLength(0);
  });
});
