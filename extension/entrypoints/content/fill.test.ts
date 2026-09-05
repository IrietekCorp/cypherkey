import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { PUNYCODE_WARNING, isPunycodeHost, showWarning } from './banner';
import { detectLoginFields, looksLikeSignIn } from './detect';
import { type FillDecision, applyFill, decideFill, normalizeHost } from './fill';

const decide = (pageHost: string, savedHost: string, isTopFrame = true): FillDecision =>
  decideFill({ pageHost, savedHost, isTopFrame });

describe('normalizeHost', () => {
  test.each([
    ['GitHub.com', 'github.com'],
    ['https://github.com/login', 'github.com'],
    ['github.com:8443', 'github.com'],
    ['  github.com  ', 'github.com'],
  ])('%s becomes %s', (raw, expected) => {
    expect(normalizeHost(raw)).toBe(expected);
  });

  test('an IPv6 literal keeps its brackets', () => {
    expect(normalizeHost('[::1]')).toBe('[::1]');
  });

  test('an empty host stays empty rather than becoming a wildcard', () => {
    expect(normalizeHost('   ')).toBe('');
  });
});

describe('what may be filled', () => {
  test('an exact host match fills', () => {
    expect(decide('github.com', 'github.com')).toEqual({ allowed: true, reason: 'exact' });
  });

  /** gist.github.com should fill a github.com credential. */
  test('a subdomain of the saved registrable domain fills', () => {
    expect(decide('gist.github.com', 'github.com')).toEqual({
      allowed: true,
      reason: 'registrable',
    });
  });

  test('the reverse also fills: saved on a subdomain, used on the apex', () => {
    expect(decide('github.com', 'gist.github.com').allowed).toBe(true);
  });

  test('a different registrable domain never fills', () => {
    expect(decide('evil.com', 'github.com')).toEqual({
      allowed: false,
      reason: 'different-site',
    });
  });

  /** The lookalike that a substring match would have let through. */
  test('a domain that merely contains the saved one does not fill', () => {
    expect(decide('evil-github.com', 'github.com').allowed).toBe(false);
    expect(decide('github.com.evil.com', 'github.com').allowed).toBe(false);
  });

  test('a different public suffix is a different site', () => {
    expect(decide('github.co.uk', 'github.com').allowed).toBe(false);
  });

  /**
   * `getDomain` returns null for a host with no public suffix. There is no registrable
   * domain to compare, so exact equality is the only thing that can allow a fill —
   * treating null as a match would make every intranet host equivalent.
   */
  test('hosts with no public suffix match only exactly', () => {
    expect(decide('localhost', 'localhost')).toEqual({ allowed: true, reason: 'exact' });
    expect(decide('intranet', 'localhost').allowed).toBe(false);
    expect(decide('192.168.1.1', '192.168.1.1').allowed).toBe(true);
    expect(decide('192.168.1.2', '192.168.1.1').allowed).toBe(false);
  });

  test('an empty host on either side refuses', () => {
    expect(decide('', 'github.com')).toEqual({ allowed: false, reason: 'unknown-host' });
    expect(decide('github.com', '')).toEqual({ allowed: false, reason: 'unknown-host' });
  });
});

describe('punycode', () => {
  /**
   * `xn--` means the host renders as letters that may be visually identical to Latin
   * ones. The user cannot tell by looking, so no comparison below it is evidence.
   */
  test('a punycode host refuses even when it matches exactly', () => {
    const host = 'xn--80ak6aa92e.com';
    expect(decide(host, host)).toEqual({ allowed: false, reason: 'punycode' });
  });

  test('a punycode subdomain of a legitimate site refuses', () => {
    expect(decide('xn--80ak6aa92e.github.com', 'github.com')).toEqual({
      allowed: false,
      reason: 'punycode',
    });
  });

  test('punycode is checked before the site comparison, so the reason is accurate', () => {
    // If ordering were wrong this would report different-site and no banner would show.
    expect(decide('xn--pple-43d.com', 'apple.com').reason).toBe('punycode');
  });

  test('an ordinary ASCII host is unaffected', () => {
    expect(decide('github.com', 'github.com').allowed).toBe(true);
  });
});

describe('frames', () => {
  /**
   * An attacker who embeds the real site cannot read what we type into it, but they
   * control what surrounds it and when it is clicked. Filling only the top frame gives
   * up framed login widgets to remove a class of clickjacking.
   */
  test('an iframe never receives a fill, even on a matching host', () => {
    expect(decide('github.com', 'github.com', false)).toEqual({
      allowed: false,
      reason: 'subframe',
    });
  });

  test('the frame check comes first, so a framed punycode page still refuses', () => {
    expect(decide('xn--80ak6aa92e.com', 'github.com', false).allowed).toBe(false);
  });
});

describe('every refusal names itself', () => {
  test('there is no silent no', () => {
    const refusals: FillDecision[] = [
      decide('evil.com', 'github.com'),
      decide('xn--pple-43d.com', 'apple.com'),
      decide('github.com', 'github.com', false),
      decide('', 'github.com'),
    ];
    for (const decision of refusals) {
      expect(decision.allowed).toBe(false);
      expect(typeof decision.reason).toBe('string');
    }
    // Four distinct reasons, so a report says which rule fired.
    expect(new Set(refusals.map((r) => r.reason)).size).toBe(4);
  });
});

// --- detection and the DOM ---------------------------------------------------------

const pageWith = (html: string) => {
  const win = new Window();
  win.document.body.innerHTML = html;
  return win;
};

describe('detectLoginFields', () => {
  test('a classic form pairs the password with the preceding text input', () => {
    const win = pageWith(`
      <form>
        <input name="user" type="text" />
        <input name="pass" type="password" />
        <button type="submit">Go</button>
      </form>`);
    const [form] = detectLoginFields(win.document as unknown as ParentNode);
    expect(form?.username?.getAttribute('name')).toBe('user');
    expect(form?.password.getAttribute('name')).toBe('pass');
  });

  test('an email field is a valid username field', () => {
    const win = pageWith(`
      <form><input type="email" name="email" /><input type="password" /></form>`);
    const [form] = detectLoginFields(win.document as unknown as ParentNode);
    expect(form?.username?.getAttribute('type')).toBe('email');
  });

  /** The one signal a site states deliberately rather than incidentally. */
  test('autocomplete="username" wins over document order', () => {
    const win = pageWith(`
      <form>
        <input type="text" name="search" />
        <input type="text" name="whatever" autocomplete="username" />
        <input type="password" />
      </form>`);
    const [form] = detectLoginFields(win.document as unknown as ParentNode);
    expect(form?.username?.getAttribute('name')).toBe('whatever');
  });

  test('fields split across containers are still paired', () => {
    const win = pageWith(`
      <form>
        <div><label>User</label><input type="text" id="login-id" /></div>
        <div><label>Pass</label><input type="password" /></div>
      </form>`);
    const [form] = detectLoginFields(win.document as unknown as ParentNode);
    expect(form?.username?.getAttribute('id')).toBe('login-id');
  });

  test('a password-only form is detected with no username', () => {
    const win = pageWith('<form><input type="password" /></form>');
    const [form] = detectLoginFields(win.document as unknown as ParentNode);
    expect(form).toBeDefined();
    expect(form?.username).toBeNull();
  });

  test('a hidden or disabled field is not a field to fill', () => {
    const win = pageWith(`
      <form>
        <input type="password" disabled />
        <input type="hidden" name="csrf" />
      </form>`);
    expect(detectLoginFields(win.document as unknown as ParentNode)).toHaveLength(0);
  });

  test('a form outside a <form> element still works', () => {
    const win = pageWith(`
      <div><input type="text" name="user" /><input type="password" /></div>`);
    const [form] = detectLoginFields(win.document as unknown as ParentNode);
    expect(form?.username?.getAttribute('name')).toBe('user');
  });

  /**
   * Autofilling a change-password form with the current password looks like it worked
   * and silently sets the new password to the old one.
   */
  test('two password fields are not treated as a sign-in', () => {
    const win = pageWith(`
      <form>
        <input type="password" name="new" />
        <input type="password" name="confirm" />
      </form>`);
    const forms = detectLoginFields(win.document as unknown as ParentNode);
    expect(forms).toHaveLength(2);
    expect(looksLikeSignIn(forms)).toBe(false);
  });

  test('one password field is a sign-in', () => {
    const win = pageWith('<form><input type="text" /><input type="password" /></form>');
    expect(looksLikeSignIn(detectLoginFields(win.document as unknown as ParentNode))).toBe(true);
  });
});

describe('applyFill', () => {
  test('it fills both fields and fires the events a page listens for', () => {
    const win = pageWith('<form><input type="text" /><input type="password" /></form>');
    const [form] = detectLoginFields(win.document as unknown as ParentNode);
    const events: string[] = [];
    form?.password.addEventListener('input', () => events.push('input'));
    form?.password.addEventListener('change', () => events.push('change'));

    applyFill(form as never, { username: 'shawn', password: 'hunter2' });

    expect(form?.username?.value).toBe('shawn');
    expect(form?.password.value).toBe('hunter2');
    // Without these a framework-backed form submits empty.
    expect(events).toEqual(['input', 'change']);
  });

  test('a password-only form fills what it has', () => {
    const win = pageWith('<form><input type="password" /></form>');
    const [form] = detectLoginFields(win.document as unknown as ParentNode);
    applyFill(form as never, { username: 'shawn', password: 'hunter2' });
    expect(form?.password.value).toBe('hunter2');
  });

  test('an empty username is not written over whatever is there', () => {
    const win = pageWith('<form><input type="text" /><input type="password" /></form>');
    const [form] = detectLoginFields(win.document as unknown as ParentNode);
    if (form?.username != null) form.username.value = 'already here';

    applyFill(form as never, { username: '', password: 'hunter2' });
    expect(form?.username?.value).toBe('already here');
  });
});

describe('the warning banner', () => {
  test('only a punycode host earns one', () => {
    expect(isPunycodeHost('xn--pple-43d.com')).toBe(true);
    expect(isPunycodeHost('XN--PPLE-43D.COM')).toBe(true);
    expect(isPunycodeHost('sub.xn--80ak6aa92e.com')).toBe(true);
    // Interrupting for an ordinary "not here" trains people to dismiss without reading.
    expect(isPunycodeHost('evil.com')).toBe(false);
    expect(isPunycodeHost('github.com')).toBe(false);
  });

  /**
   * The banner runs on every page the user visits. Importing the public suffix list
   * here put 265 KB into every page; without it the content script is 5.5 KB.
   */
  test('neither the banner nor the content script imports tldts', async () => {
    for (const file of ['banner.ts', 'detect.ts', 'index.ts']) {
      const source = await Bun.file(`${import.meta.dir}/${file}`).text();
      // The word appears in comments explaining why it is absent; an import does not.
      expect(source).not.toMatch(/^\s*import[^\n]*'tldts'/m);
      expect(source).not.toMatch(/from '\.\/fill'/m);
    }
  });

  test('it renders once and says what to check', () => {
    const win = pageWith('<p>a page</p>');
    const doc = win.document as unknown as Document;
    showWarning(doc);
    showWarning(doc);

    expect(doc.querySelectorAll('#cypherkey-warning')).toHaveLength(1);
    expect(PUNYCODE_WARNING).toContain('address bar');
  });

  /** A page that could restyle or hide a security warning makes it worse than nothing. */
  test('it lives in a closed shadow root, out of the page stylesheet', () => {
    const win = pageWith('<p>a page</p>');
    const doc = win.document as unknown as Document;
    showWarning(doc);

    const banner = doc.getElementById('cypherkey-warning');
    expect(banner).not.toBeNull();
    // Closed: the page cannot reach in through `.shadowRoot`.
    expect(banner?.shadowRoot).toBeNull();
  });
});
