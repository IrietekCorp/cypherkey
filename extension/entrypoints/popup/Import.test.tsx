import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { VaultItem } from '../../src/vault/item';
import { Import } from './Import';

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
    'File',
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
  const imported: VaultItem[][] = [];
  const cancelled = { count: 0 };
  await act(async () => {
    root.render(
      <Import
        onImport={(items) => {
          imported.push(items);
        }}
        onCancel={() => {
          cancelled.count += 1;
        }}
        now={() => 1_788_000_000_000}
      />,
    );
  });
  return { imported, cancelled };
};

const click = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

/** Puts a file on the input without a real file picker. */
const choose = async (content: string) => {
  await act(async () => {
    const input = el('file') as unknown as HTMLInputElement;
    Object.defineProperty(input, 'files', {
      configurable: true,
      value: [{ text: async () => content }],
    });
  });
};

const BITWARDEN = JSON.stringify({
  items: [
    {
      type: 1,
      name: 'GitHub',
      login: { username: 'shawn', password: 'hunter2', uris: [{ uri: 'https://github.com' }] },
    },
    { type: 3, name: 'Visa' },
  ],
});

const CHROME = [
  'name,url,username,password,note',
  'GitHub,https://github.com/,shawn,hunter2,',
  'Bank,https://bank.example/,shawn,"a,b,c",',
  'NoPassword,https://x.example/,x,,',
].join('\n');

describe('reading a file', () => {
  test('nothing happens until a file is chosen', async () => {
    await render();
    await click('read');
    expect(el('error')?.textContent).toContain('Choose a file');
    expect(el('summary')).toBeNull();
  });

  test('a Bitwarden export previews what will and will not come in', async () => {
    await render();
    await choose(BITWARDEN);
    await click('read');

    expect(el('summary')?.textContent).toContain('1 of 2');
    expect(el('skipped')?.textContent).toContain('card');
  });

  test('a Chrome CSV previews the same way', async () => {
    await render();
    await click('format-chrome');
    await choose(CHROME);
    await click('read');

    expect(el('summary')?.textContent).toContain('2 of 3');
    expect(el('skipped')?.textContent).toContain('no password');
  });

  /** One message for a whole-file problem, not a complaint about every line. */
  test('an unreadable file gives one clear error and no preview', async () => {
    await render();
    await choose('{not json');
    await click('read');

    expect(el('error')?.textContent).toContain('not valid JSON');
    expect(el('summary')).toBeNull();
  });

  test('an encrypted export says what to do instead', async () => {
    await render();
    await choose(JSON.stringify({ encrypted: true, items: [] }));
    await click('read');
    expect(el('error')?.textContent).toContain('export unencrypted JSON');
  });

  test('switching format clears a stale preview', async () => {
    await render();
    await choose(BITWARDEN);
    await click('read');
    expect(el('summary')).not.toBeNull();

    await click('format-chrome');
    // A preview from the other parser would describe rows this format never had.
    expect(el('summary')).toBeNull();
  });
});

describe('nothing is saved until the user has seen it', () => {
  test('reading imports nothing on its own', async () => {
    const { imported } = await render();
    await choose(BITWARDEN);
    await click('read');
    expect(imported).toHaveLength(0);
  });

  test('confirming imports exactly what was previewed', async () => {
    const { imported } = await render();
    await choose(BITWARDEN);
    await click('read');
    await click('confirm');

    expect(imported).toHaveLength(1);
    expect(imported[0]).toHaveLength(1);
    expect(imported[0]?.[0]?.title).toBe('GitHub');
  });

  test('a password containing commas arrives intact', async () => {
    const { imported } = await render();
    await click('format-chrome');
    await choose(CHROME);
    await click('read');
    await click('confirm');

    const bank = imported[0]?.find((i) => i.title === 'Bank');
    expect(bank?.kind === 'login' ? bank.password : null).toBe('a,b,c');
  });

  test('a file with nothing importable cannot be confirmed', async () => {
    await render();
    await choose(JSON.stringify({ items: [{ type: 3, name: 'Visa' }] }));
    await click('read');

    expect((el('confirm') as unknown as HTMLButtonElement).disabled).toBe(true);
  });

  test('cancelling imports nothing', async () => {
    const { imported, cancelled } = await render();
    await choose(BITWARDEN);
    await click('read');
    await click('cancel');

    expect(cancelled.count).toBe(1);
    expect(imported).toHaveLength(0);
  });

  /** Holding it after the import keeps every imported password alive for no reason. */
  test('the preview is dropped once the import completes', async () => {
    await render();
    await choose(BITWARDEN);
    await click('read');
    await click('confirm');

    expect(el('summary')).toBeNull();
  });
});

describe('what the screen says and does not do', () => {
  test('it warns that the export file itself is plaintext', async () => {
    await render();
    expect(host.textContent).toContain('never saved');
    expect(host.textContent).toContain('every password in plain text');
  });

  test('it never writes the file anywhere', async () => {
    const source = await Bun.file(`${import.meta.dir}/Import.tsx`).text();
    expect(source).not.toContain('localStorage');
    expect(source).not.toContain('Bun.write');
    expect(source).not.toContain('console.');
  });

  test('a skipped reason never quotes a password', async () => {
    await render();
    await click('format-chrome');
    await choose('name,url,username,password,note\n,,u,supersecret,');
    await click('read');

    expect(el('skipped')?.textContent ?? '').not.toContain('supersecret');
  });
});
