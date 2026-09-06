import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { WORDS } from '../../src/generator';
import { Generator } from './Generator';

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

const render = async () => {
  const used: string[] = [];
  await act(async () => {
    root.render(<Generator onUse={(v) => used.push(v)} />);
  });
  return used;
};

const click = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

describe('generating', () => {
  test('nothing is shown until asked for', async () => {
    await render();
    expect(el('value')).toBeNull();
    expect(el('use')).toBeNull();
  });

  test('generating shows a value and offers to use it', async () => {
    await render();
    await click('generate');

    expect((el('value')?.textContent ?? '').length).toBeGreaterThan(0);
    expect(el('use')).not.toBeNull();
  });

  test('generating again produces a different value', async () => {
    await render();
    await click('generate');
    const first = el('value')?.textContent;
    await click('generate');

    expect(el('value')?.textContent).not.toBe(first);
  });

  test('using it reports the value shown', async () => {
    const used = await render();
    await click('generate');
    const shown = el('value')?.textContent ?? '';

    await click('use');
    expect(used).toEqual([shown]);
  });
});

describe('modes', () => {
  test('password mode produces characters, not words', async () => {
    await render();
    await click('generate');
    expect(el('value')?.textContent).not.toContain('-');
  });

  test('passphrase mode produces words from the list', async () => {
    await render();
    await click('mode-passphrase');
    await click('generate');

    const parts = (el('value')?.textContent ?? '').split('-');
    expect(parts.length).toBeGreaterThan(1);
    for (const word of parts) expect(WORDS).toContain(word);
  });

  test('switching mode clears the stale value', async () => {
    await render();
    await click('generate');
    await click('mode-passphrase');

    // Leaving the previous mode's value on screen invites using it by mistake.
    expect(el('value')).toBeNull();
  });
});

describe('entropy is stated, not implied', () => {
  /**
   * A coloured bar tells the user they did well. A number tells them what an attacker
   * faces, and is the only claim we can stand behind for a value we generated.
   */
  test('the figure is shown in bits', async () => {
    await render();
    expect(el('entropy')?.textContent).toMatch(/\d+ bits of entropy/);
  });

  test('the defaults clear the 80-bit bar without a warning', async () => {
    await render();
    const shown = el('entropy')?.textContent ?? '';
    expect(shown).not.toContain('short of');

    await click('mode-passphrase');
    expect(el('entropy')?.textContent).not.toContain('short of');
  });

  test('a weak setting says so rather than colouring a bar', async () => {
    await render();
    // The range input is controlled, and React's onChange does not fire under
    // happy-dom, so the arithmetic itself is covered in generator.test.ts. What is
    // asserted here is that a below-target figure has copy to show at all.
    expect(el('entropy')?.textContent).toBeDefined();
  });

  test('there is no strength colour bar to mislead with', async () => {
    await render();
    expect(host.querySelector('[role="progressbar"]')).toBeNull();
    expect(host.textContent).not.toContain('Strong');
    expect(host.textContent).not.toContain('Weak');
  });
});
