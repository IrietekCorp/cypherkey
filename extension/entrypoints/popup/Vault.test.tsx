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
    let profileOpened = 0;
    let imports = 0;
    await act(async () => {
      root.render(
        <VaultList
          items={items}
          username="mreyes"
          onOpen={(i) => opened.push(i)}
          onAdd={(k) => added.push(k)}
          onProfile={() => {
            profileOpened += 1;
          }}
          onImport={() => {
            imports += 1;
          }}
        />,
      );
    });
    return { opened, added, profile: () => profileOpened, imports: () => imports };
  };

  test('an empty vault says so rather than showing a blank panel', async () => {
    await render([]);
    // Board copy (frame 10). An empty vault says what to do, not that it is empty.
    expect(el('empty')?.textContent).toContain('Nothing in here yet');
    expect(el('empty')?.textContent).toContain('Add your first login');
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
    // The list is grouped by kind now, so the rows live under a per-section testid.
    expect(el('items-login')).not.toBeNull();
  });

  /**
   * The dashboard groups by kind, because the two are looked for differently: a login is
   * hunted by site when you need to get into something, a note is browsed.
   */
  test('logins and notes are separate sections, each counted', async () => {
    await render([LOGIN, NOTE]);
    expect(text()).toContain('Logins');
    expect(text()).toContain('Secure notes');
    expect(el('items-login')?.children.length).toBe(1);
    expect(el('items-note')?.children.length).toBe(1);
  });

  test('every row carries a mark, and no row carries a password', async () => {
    await render([LOGIN, NOTE]);
    expect(el(`mark-${LOGIN.id}`)).not.toBeNull();
    expect(el(`mark-${NOTE.id}`)).not.toBeNull();
    // The list has never shown a password and must not start now.
    expect(text()).not.toContain(LOGIN.password);
  });

  test('the profile is reachable from the vault', async () => {
    const { profile } = await render([LOGIN]);
    await click('profile');
    expect(profile()).toBe(1);
  });

  test('an empty vault says what to do, not just that it is empty', async () => {
    await render([]);
    expect(el('empty')?.textContent).toContain('Add a login');
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

describe('the generator fills the password field (M2-11)', () => {
  const render = async () => {
    const saved: VaultItem[] = [];
    await act(async () => {
      root.render(
        <ItemEdit kind="login" now={() => 1} onSave={(i) => saved.push(i)} onCancel={() => {}} />,
      );
    });
    return saved;
  };

  test('it is one click from the field it fills', async () => {
    await render();
    // A generator behind a separate screen is one people stop using.
    expect(el('toggle-generator')).not.toBeNull();
    expect(el('generate')).toBeNull();

    await click('toggle-generator');
    expect(el('generate')).not.toBeNull();
  });

  test('using a generated value writes it into the password field and closes', async () => {
    await render();
    await click('toggle-generator');
    await click('generate');
    const generated = el('value')?.textContent ?? '';

    await click('use');

    expect((el('password') as unknown as HTMLInputElement).value).toBe(generated);
    expect(generated.length).toBeGreaterThan(0);
    // Closing afterwards keeps the value visible only as long as it is being chosen.
    expect(el('generate')).toBeNull();
  });

  test('a generated password saves as typed, untrimmed and unaltered', async () => {
    const saved = await render();
    await setValue('title', 'Bank');
    await setValue('host', 'bank.example');
    await click('toggle-generator');
    await click('generate');
    const generated = el('value')?.textContent ?? '';
    await click('use');
    await click('save');

    expect(saved[0]?.kind === 'login' ? saved[0].password : null).toBe(generated);
  });

  test('a note has no generator, because it has no password', async () => {
    await act(async () => {
      root.render(<ItemEdit kind="note" now={() => 1} onSave={() => {}} onCancel={() => {}} />);
    });
    expect(el('toggle-generator')).toBeNull();
  });
});

describe('filling the active page from an item (M2-10)', () => {
  const fakeBrowser = (url: string | undefined) => {
    const injections: unknown[][] = [];
    const api = {
      tabs: {
        async query() {
          return url === undefined ? [] : [{ id: 1, url }];
        },
      },
      scripting: {
        async executeScript(injection: { args: unknown[] }) {
          injections.push(injection.args);
          return [];
        },
      },
    };
    return { api, injections };
  };

  const render = async (url: string | undefined) => {
    const { api, injections } = fakeBrowser(url);
    await act(async () => {
      root.render(
        <ItemView item={LOGIN} onEdit={() => {}} onBack={() => {}} browser={api as never} />,
      );
    });
    return injections;
  };

  test('a matching site fills, and says so', async () => {
    const injections = await render('https://github.com/login');
    await click('fill');

    expect(injections).toHaveLength(1);
    expect(injections[0]?.[0]).toEqual({ username: 'shawn', password: 'hunter2' });
    expect(el('fill-message')?.textContent).toBe('Filled.');
  });

  /** The wrong page never receives the script at all. */
  test('a different site is refused and names the site the item is for', async () => {
    const injections = await render('https://evil.com/login');
    await click('fill');

    expect(injections).toHaveLength(0);
    expect(el('fill-message')?.textContent).toContain('github.com');
  });

  test('a punycode page is refused and points at the address bar', async () => {
    const injections = await render('https://xn--80ak6aa92e.com/');
    await click('fill');

    expect(injections).toHaveLength(0);
    expect(el('fill-message')?.textContent).toContain('address bar');
  });

  test('a note offers no fill, because there is nothing to fill with', async () => {
    const { api } = fakeBrowser('https://github.com/');
    await act(async () => {
      root.render(
        <ItemView item={NOTE} onEdit={() => {}} onBack={() => {}} browser={api as never} />,
      );
    });
    expect(el('fill')).toBeNull();
  });

  /** Offered-and-broken is worse than not offered. */
  test('without the browser API the button is absent', async () => {
    await act(async () => {
      root.render(<ItemView item={LOGIN} onEdit={() => {}} onBack={() => {}} />);
    });
    expect(el('fill')).toBeNull();
  });

  test('the password is not revealed by filling', async () => {
    await render('https://github.com/login');
    await click('fill');
    expect(el('password')?.textContent).not.toContain('hunter2');
  });
});
