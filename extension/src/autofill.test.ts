import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { type BrowserApi, autofillActiveTab, fillInPage, outcomeMessage } from './autofill';

const CREDENTIAL = { username: 'shawn', password: 'hunter2' };

/** A browser API double that records what was asked of it. */
function fakeBrowser(options: { url?: string; tabId?: number; throws?: boolean } = {}) {
  const injections: Array<{ tabId: number; args: unknown[] }> = [];
  const api: BrowserApi = {
    tabs: {
      async query() {
        if (options.url === undefined) return [];
        return [{ id: options.tabId ?? 7, url: options.url }];
      },
    },
    scripting: {
      async executeScript(injection) {
        if (options.throws === true) throw new Error('cannot access chrome:// URL');
        injections.push({ tabId: injection.target.tabId, args: injection.args });
        return [];
      },
    },
  };
  return { api, injections };
}

describe('nothing is injected unless the fill was allowed', () => {
  /**
   * The refusal costs the page no information beyond the fact that the popup was
   * opened: it never receives the script at all.
   */
  test('a different site is refused without injecting', async () => {
    const { api, injections } = fakeBrowser({ url: 'https://evil.com/login' });
    const outcome = await autofillActiveTab(api, 'github.com', CREDENTIAL);

    expect(outcome).toEqual({ filled: false, reason: 'different-site' });
    expect(injections).toHaveLength(0);
  });

  test('a punycode host is refused without injecting', async () => {
    const { api, injections } = fakeBrowser({ url: 'https://xn--80ak6aa92e.com/' });
    const outcome = await autofillActiveTab(api, 'github.com', CREDENTIAL);

    expect(outcome.reason).toBe('punycode');
    expect(injections).toHaveLength(0);
  });

  test('an exact host match injects once, carrying the credential', async () => {
    const { api, injections } = fakeBrowser({ url: 'https://github.com/login', tabId: 42 });
    const outcome = await autofillActiveTab(api, 'github.com', CREDENTIAL);

    expect(outcome).toEqual({ filled: true, reason: 'exact' });
    expect(injections).toHaveLength(1);
    expect(injections[0]?.tabId).toBe(42);
    expect(injections[0]?.args[0]).toEqual(CREDENTIAL);
  });

  test('a subdomain of the saved registrable domain fills', async () => {
    const { api, injections } = fakeBrowser({ url: 'https://gist.github.com/x' });
    const outcome = await autofillActiveTab(api, 'github.com', CREDENTIAL);

    expect(outcome).toEqual({ filled: true, reason: 'registrable' });
    expect(injections).toHaveLength(1);
  });

  test('no open tab is reported rather than throwing', async () => {
    const { api } = fakeBrowser();
    expect(await autofillActiveTab(api, 'github.com', CREDENTIAL)).toEqual({
      filled: false,
      reason: 'no-tab',
    });
  });

  test('a URL the browser cannot parse is refused', async () => {
    const { api, injections } = fakeBrowser({ url: 'not a url' });
    const outcome = await autofillActiveTab(api, 'github.com', CREDENTIAL);

    expect(outcome.reason).toBe('unknown-host');
    expect(injections).toHaveLength(0);
  });

  /** A tab can navigate or close between the query and the injection. */
  test('a refused injection is reported rather than thrown', async () => {
    const { api } = fakeBrowser({ url: 'https://github.com/', throws: true });
    expect(await autofillActiveTab(api, 'github.com', CREDENTIAL)).toEqual({
      filled: false,
      reason: 'injection-failed',
    });
  });
});

describe('every outcome says something', () => {
  test('a refusal is never silent', () => {
    const reasons = [
      'punycode',
      'different-site',
      'subframe',
      'unknown-host',
      'no-tab',
      'injection-failed',
    ] as const;

    const messages = reasons.map((reason) =>
      outcomeMessage({ filled: false, reason } as never, 'github.com'),
    );
    for (const message of messages) expect(message.length).toBeGreaterThan(10);
    // Distinct, so a report says which rule fired rather than "it did not work".
    expect(new Set(messages).size).toBe(reasons.length);
  });

  test('the wrong-site message names the site the item is for', () => {
    const message = outcomeMessage({ filled: false, reason: 'different-site' }, 'github.com');
    expect(message).toContain('github.com');
  });

  test('the punycode message points at the address bar', () => {
    expect(outcomeMessage({ filled: false, reason: 'punycode' }, 'github.com')).toContain(
      'address bar',
    );
  });
});

/**
 * The injected function is serialised by `executeScript`, so nothing it closes over
 * travels with it. It is run here against a real DOM: a source-grep would prove
 * nothing, because a mistake in here only shows up when it executes.
 */
describe('the injected filler', () => {
  const page = (html: string) => {
    const win = new Window();
    win.document.body.innerHTML = html;
    for (const key of ['window', 'document', 'Event', 'HTMLInputElement', 'Node']) {
      (globalThis as Record<string, unknown>)[key] = (win as unknown as Record<string, unknown>)[
        key
      ];
    }
    return win;
  };

  const inputs = (win: Window) =>
    [...win.document.querySelectorAll('input')] as unknown as HTMLInputElement[];

  test('it fills a classic login form', () => {
    const win = page(
      '<form><input name="u" type="text" /><input name="p" type="password" /></form>',
    );
    fillInPage(CREDENTIAL);

    const [username, password] = inputs(win);
    expect(username?.value).toBe('shawn');
    expect(password?.value).toBe('hunter2');
  });

  test('it fires the events a framework listens for', () => {
    const win = page('<form><input type="text" /><input type="password" /></form>');
    const seen: string[] = [];
    const [, password] = inputs(win);
    password?.addEventListener('input', () => seen.push('input'));
    password?.addEventListener('change', () => seen.push('change'));

    fillInPage(CREDENTIAL);
    // Without these a React-backed form submits empty.
    expect(seen).toEqual(['input', 'change']);
  });

  test('autocomplete="username" wins over document order', () => {
    const win = page(
      '<form><input type="text" name="search" /><input type="text" name="u" autocomplete="username" /><input type="password" /></form>',
    );
    fillInPage(CREDENTIAL);

    const [search, username] = inputs(win);
    expect(search?.value).toBe('');
    expect(username?.value).toBe('shawn');
  });

  test('a password-only form fills the password alone', () => {
    const win = page('<form><input type="password" /></form>');
    fillInPage(CREDENTIAL);
    expect(inputs(win)[0]?.value).toBe('hunter2');
  });

  /** Filling a change-password form with the current password is silent damage. */
  test('two password fields fill nothing at all', () => {
    const win = page(
      '<form><input type="password" name="new" /><input type="password" name="confirm" /></form>',
    );
    fillInPage(CREDENTIAL);

    for (const input of inputs(win)) expect(input.value).toBe('');
  });

  test('a disabled or hidden password field is not a field to fill', () => {
    const win = page(
      '<form><input type="password" disabled /><input type="hidden" name="csrf" /></form>',
    );
    fillInPage(CREDENTIAL);
    expect(inputs(win)[0]?.value).toBe('');
  });

  test('an empty username does not overwrite what is already there', () => {
    const win = page('<form><input type="text" /><input type="password" /></form>');
    const [username] = inputs(win);
    if (username !== undefined) username.value = 'already here';

    fillInPage({ username: '', password: 'hunter2' });
    expect(username?.value).toBe('already here');
  });

  test('a page with no password field is left alone', () => {
    const win = page('<form><input type="text" name="search" /></form>');
    expect(() => fillInPage(CREDENTIAL)).not.toThrow();
    expect(inputs(win)[0]?.value).toBe('');
  });

  /**
   * The credential goes as an `executeScript` argument rather than by message. A
   * listener sitting in the page waiting to be told a password is a strictly larger
   * target for anything else running there.
   */
  test('no message listener is registered in the page', async () => {
    const source = await Bun.file(`${import.meta.dir}/autofill.ts`).text();
    expect(source).not.toContain('onMessage');
    expect(source).not.toContain('sendMessage');
  });
});
