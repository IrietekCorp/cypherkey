import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Profile } from './Profile';

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
const text = () => host.textContent ?? '';
const click = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

type Counts = { lock: number; signOut: number; back: number; settings: number };

const render = async (over: { username?: string; withSettings?: boolean } = {}) => {
  const counts: Counts = { lock: 0, signOut: 0, back: 0, settings: 0 };
  await act(async () => {
    root.render(
      <Profile
        username={over.username ?? 'shawn'}
        version="0.1.0"
        openSettings={
          over.withSettings === false
            ? undefined
            : () => {
                counts.settings += 1;
              }
        }
        onLock={() => {
          counts.lock += 1;
        }}
        onSignOut={() => {
          counts.signOut += 1;
        }}
        onBack={() => {
          counts.back += 1;
        }}
      />,
    );
  });
  return counts;
};

describe('Profile', () => {
  test('names the account this vault belongs to', async () => {
    await render({ username: 'shawn' });
    expect(el('profile-username')?.textContent).toBe('shawn');
    expect(el('profile-version')?.textContent).toBe('0.1.0');
  });

  test('an account with no name still renders something sensible', async () => {
    await render({ username: '  ' });
    expect(el('profile-username')?.textContent).toBe('This device');
  });

  test('lock, sign out and back each reach the caller', async () => {
    const counts = await render();
    await click('lock');
    await click('sign-out');
    await click('back');
    expect(counts).toEqual({ lock: 1, signOut: 1, back: 1, settings: 0 });
  });

  /**
   * Both exits say what they cost. Locking keeps the device registered; signing out ends
   * the session on the server and needs the full passphrase and rhythm to undo. Those
   * are very different acts and looked identical without the explanation.
   */
  test('the difference between locking and signing out is stated', async () => {
    await render();
    expect(el('lock')?.textContent).toContain('stays registered');
    expect(el('sign-out')?.textContent).toContain('passphrase and rhythm');
  });

  /** A-16: crossing into Strict re-keys the account, so it is not a popup control. */
  test('Strictness is not editable here', async () => {
    await render();
    expect(el('strictness-strict')).toBeNull();
    expect(el('strictness-relaxed')).toBeNull();
    // It points at the screen that has room to explain the consequence instead.
    expect(el('open-settings')?.textContent).toContain('Strictness');
  });

  test('no settings link where there is no options page to open', async () => {
    // The popup runs inside the options page during development, and in tests.
    const counts = await render({ withSettings: false });
    expect(el('open-settings')).toBeNull();
    expect(counts.settings).toBe(0);
  });

  test('shows no secret of any kind', async () => {
    await render();
    for (const forbidden of ['password', 'Recovery Kit code', 'Backup Code']) {
      expect(text()).not.toContain(forbidden);
    }
  });
});
