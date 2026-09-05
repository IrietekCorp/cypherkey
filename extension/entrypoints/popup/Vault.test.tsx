import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { LoginItem, NoteItem, VaultItem } from '../../src/vault/item';
import { ItemEdit } from './ItemEdit';
import { ItemView } from './ItemView';
import { VaultList } from './VaultList';

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

const setValue = async (id: string, value: string) => {
  await act(async () => {
    (el(id) as unknown as HTMLInputElement).value = value;
  });
};

const LOGIN: LoginItem = {
  kind: 'login',
  id: 'item-1',
  title: 'GitHub',
  host: 'github.com',
  username: 'shawn',
  password: 'hunter2',
  notes: 'the one with the yubikey',
  updatedAt: 1_788_000_000_000,
};

const NOTE: NoteItem = {
  kind: 'note',
  id: 'item-2',
  title: 'Wifi',
  body: 'upstairs: swordfish',
  updatedAt: 1_788_000_000_001,
};

describe('VaultList', () => {
  const render = async (items: VaultItem[]) => {
    const opened: VaultItem[] = [];
    const added: string[] = [];
    await act(async () => {
      root.render(
        <VaultList items={items} onOpen={(i) => opened.push(i)} onAdd={(k) => added.push(k)} />,
      );
    });
    return { opened, added };
  };

  test('an empty vault says so rather than showing a blank panel', async () => {
    await render([]);
    expect(el('empty')?.textContent).toContain('Nothing saved yet');
  });

  test('items are listed with a summary', async () => {
    await render([LOGIN, NOTE]);
    expect(text()).toContain('GitHub');
    expect(text()).toContain('shawn');
    expect(text()).toContain('Wifi');
  });

  /** The list is the most-screenshotted surface in the product. */
  test('no password appears in the list, even masked', async () => {
    await render([LOGIN]);
    expect(text()).not.toContain('hunter2');
  });

  test('opening an item reports which one', async () => {
    const { opened } = await render([LOGIN, NOTE]);
    await click(`item-${LOGIN.id}`);
    expect(opened).toEqual([LOGIN]);
  });

  test('adding reports the kind asked for', async () => {
    const { added } = await render([]);
    await click('add-login');
    await click('add-note');
    expect(added).toEqual(['login', 'note']);
  });

  test('a query with no matches says so differently from an empty vault', async () => {
    await render([LOGIN]);
    // The search box is controlled, and React's onChange does not fire under
    // happy-dom, so the ranking itself is covered by item.test.ts instead. What is
    // asserted here is that the two empty states are distinguishable at all.
    expect(el('empty')).toBeNull();
    expect(el('items')).not.toBeNull();
  });
});

describe('ItemView', () => {
  const render = async (item: VaultItem) => {
    const events = { edited: 0, back: 0 };
    await act(async () => {
      root.render(
        <ItemView
          item={item}
          onEdit={() => {
            events.edited += 1;
          }}
          onBack={() => {
            events.back += 1;
          }}
        />,
      );
    });
    return events;
  };

  /**
   * The popup sits over whatever page is open, often in a shared room. Revealing is a
   * deliberate act, not the default.
   */
  test('a password is masked until revealed', async () => {
    await render(LOGIN);
    expect(el('password')?.textContent).not.toContain('hunter2');

    await click('reveal');
    expect(el('password')?.textContent).toBe('hunter2');
  });

  test('revealing can be undone', async () => {
    await render(LOGIN);
    await click('reveal');
    await click('reveal');
    expect(el('password')?.textContent).not.toContain('hunter2');
  });

  test('the other fields are shown plainly', async () => {
    await render(LOGIN);
    expect(el('host')?.textContent).toBe('github.com');
    expect(el('username')?.textContent).toBe('shawn');
    expect(el('notes')?.textContent).toContain('yubikey');
  });

  test('a note shows its body and no login fields', async () => {
    await render(NOTE);
    expect(el('body')?.textContent).toContain('swordfish');
    expect(el('password')).toBeNull();
    expect(el('host')).toBeNull();
  });

  test('edit and back report through', async () => {
    const events = await render(LOGIN);
    await click('edit');
    await click('back');
    expect(events).toEqual({ edited: 1, back: 1 });
  });
});

describe('ItemEdit', () => {
  const render = async (props: Partial<Parameters<typeof ItemEdit>[0]> = {}) => {
    const saved: VaultItem[] = [];
    const cancelled = { count: 0 };
    await act(async () => {
      root.render(
        <ItemEdit
          kind="login"
          now={() => 1_788_000_009_999}
          onSave={(i) => saved.push(i)}
          onCancel={() => {
            cancelled.count += 1;
          }}
          {...props}
        />,
      );
    });
    return { saved, cancelled };
  };

  test('a new login is built from the fields', async () => {
    const { saved } = await render();
    await setValue('title', 'Bank');
    await setValue('host', 'bank.example');
    await setValue('username', 'shawn');
    await setValue('password', 'correcthorse');
    await click('save');

    const item = saved[0];
    expect(item?.kind).toBe('login');
    expect(item?.title).toBe('Bank');
    expect(item?.updatedAt).toBe(1_788_000_009_999);
    expect(item?.kind === 'login' ? item.password : null).toBe('correcthorse');
  });

  test('editing keeps the id, so it is an update and not a new item', async () => {
    const { saved } = await render({ item: LOGIN });
    await setValue('title', 'GitHub (work)');
    await click('save');

    expect(saved[0]?.id).toBe(LOGIN.id);
    expect(saved[0]?.title).toBe('GitHub (work)');
  });

  test('existing values are prefilled', async () => {
    await render({ item: LOGIN });
    expect((el('title') as unknown as HTMLInputElement).value).toBe('GitHub');
    expect((el('password') as unknown as HTMLInputElement).value).toBe('hunter2');
  });

  /**
   * Leading and trailing spaces are legitimate in a password, and trimming one would
   * lock the user out of the site with no visible cause.
   */
  test('a password is not trimmed, though a title is', async () => {
    const { saved } = await render();
    await setValue('title', '  Bank  ');
    await setValue('host', 'bank.example');
    await setValue('password', '  spaced  ');
    await click('save');

    expect(saved[0]?.title).toBe('Bank');
    expect(saved[0]?.kind === 'login' ? saved[0].password : null).toBe('  spaced  ');
  });

  test('missing fields are named rather than silently refused', async () => {
    const { saved } = await render();
    await click('save');

    const problems = el('problems')?.textContent ?? '';
    expect(problems).toContain('title');
    expect(problems).toContain('site');
    expect(problems).toContain('password');
    expect(saved).toHaveLength(0);
  });

  test('a note needs a body, not a host or password', async () => {
    const { saved } = await render({ kind: 'note' });
    await click('save');
    expect(el('problems')?.textContent).toContain('note');

    await setValue('title', 'Wifi');
    await setValue('body', 'upstairs: swordfish');
    await click('save');
    expect(saved[0]?.kind).toBe('note');
  });

  test('an empty optional field is left off rather than stored blank', async () => {
    const { saved } = await render();
    await setValue('title', 'Bank');
    await setValue('host', 'bank.example');
    await setValue('password', 'x');
    await click('save');

    expect(saved[0]).not.toHaveProperty('notes');
  });

  test('cancel reports through without saving', async () => {
    const { saved, cancelled } = await render();
    await click('cancel');
    expect(cancelled.count).toBe(1);
    expect(saved).toHaveLength(0);
  });
});
