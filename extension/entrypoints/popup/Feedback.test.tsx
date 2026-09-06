import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { buildIssueUrl, coarseBrowser, issueBody } from '../../src/feedback';
import { FEEDBACK_REPO, Feedback } from './Feedback';

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

const CHROME_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

const el = (id: string) => host.querySelector(`[data-testid="${id}"]`);

const render = async (userAgent = CHROME_UA) => {
  const opened: string[] = [];
  await act(async () => {
    root.render(
      <Feedback version="0.1.0" userAgent={userAgent} open={(url) => opened.push(url)} />,
    );
  });
  return opened;
};

const click = async (id: string) => {
  await act(async () => {
    el(id)?.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  });
};

describe('coarseBrowser', () => {
  /**
   * The full user-agent is a fingerprint — platform, architecture, build number, often
   * enough to single someone out. "Chrome 141" is what a maintainer needs; the rest is
   * only useful for identifying who filed the report.
   */
  test.each([
    [CHROME_UA, 'Chrome 141'],
    ['Mozilla/5.0 ... Firefox/130.0', 'Firefox 130'],
    ['Mozilla/5.0 ... Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge 141'],
    ['Mozilla/5.0 ... Chrome/140.0.0.0 Safari/537.36 OPR/125.0.0.0', 'Opera 125'],
    ['Mozilla/5.0 (Macintosh) ... Version/18.0 Safari/605.1.15', 'Safari 18'],
  ])('reduces a user-agent to a name and major version', (ua, expected) => {
    expect(coarseBrowser(ua)).toBe(expected);
  });

  test('an unrecognised agent says so rather than guessing', () => {
    expect(coarseBrowser('something else entirely')).toBe('unknown browser');
  });

  /** Edge and Opera both claim to be Chrome, so order matters. */
  test('Edge is not reported as Chrome', () => {
    expect(coarseBrowser('Chrome/141.0.0.0 Edg/141.0.0.0')).not.toContain('Chrome');
  });

  test('no build number, platform or architecture survives', () => {
    const reduced = coarseBrowser(CHROME_UA);
    expect(reduced).not.toContain('X11');
    expect(reduced).not.toContain('Linux');
    expect(reduced).not.toContain('x86_64');
    expect(reduced).not.toContain('537.36');
    expect(reduced).not.toContain('141.0.0.0');
  });
});

describe('the issue body', () => {
  test('it carries the version and the browser', () => {
    const body = issueBody({ version: '0.1.0', browser: 'Chrome 141' });
    expect(body).toContain('CypherKey 0.1.0 · Chrome 141');
  });

  test('it says outright that nothing was attached', () => {
    expect(issueBody({ version: '0.1.0', browser: 'Chrome 141' })).toContain(
      'Nothing was attached automatically',
    );
  });

  /** A blank "Steps to reproduce" gets left blank; a question gets answered. */
  test('it asks questions rather than offering headings', () => {
    const body = issueBody({ version: '0.1.0', browser: 'Chrome 141' });
    expect(body).toContain('What were you doing?');
    expect(body).toContain('What happened instead?');
  });

  test('it warns against pasting secrets, since an issue is public', () => {
    const body = issueBody({ version: '0.1.0', browser: 'Chrome 141' });
    expect(body).toContain('passphrase');
    expect(body).toContain('Recovery Kit');
    expect(body).toContain('Backup Code');
  });
});

describe('the URL carries nothing else', () => {
  const url = () => buildIssueUrl({ repo: FEEDBACK_REPO, version: '0.1.0', browser: 'Chrome 141' });

  test('it points at a new issue on the configured repo', () => {
    expect(url()).toContain(`github.com/${FEEDBACK_REPO}/issues/new`);
  });

  /**
   * Everything here is visible in the address bar, kept in history, and readable by
   * anyone who later opens the issue.
   */
  test('it has only the parameters we set', () => {
    const params = new URL(url()).searchParams;
    expect([...params.keys()].sort()).toEqual(['body', 'title']);
  });

  test('it contains the version and the browser', () => {
    const body = new URL(url()).searchParams.get('body') ?? '';
    expect(body).toContain('0.1.0');
    expect(body).toContain('Chrome 141');
  });

  test('labels are added only when asked for', () => {
    const withLabels = buildIssueUrl({
      repo: FEEDBACK_REPO,
      version: '0.1.0',
      browser: 'Chrome 141',
      labels: ['beta'],
    });
    expect(new URL(withLabels).searchParams.get('labels')).toBe('beta');
  });
});

describe('the component attaches nothing', () => {
  test('clicking opens the report', async () => {
    const opened = await render();
    await click('report');

    expect(opened).toHaveLength(1);
    expect(opened[0]).toContain('issues/new');
  });

  test('it shows exactly what will be sent, before sending it', async () => {
    await render();
    expect(el('attached')?.textContent).toBe('CypherKey 0.1.0 · Chrome 141');
  });

  test('it says plainly that nothing is attached', async () => {
    await render();
    const text = host.textContent ?? '';
    expect(text).toContain('Nothing is attached automatically');
    expect(text).toContain('nothing from your vault');
  });

  /**
   * Structural, not disciplinary: the component takes no session, vault or capture
   * prop, so a future edit that wanted to attach diagnostics would have to add one and
   * explain itself in review.
   */
  test('it takes no session, vault or capture state', async () => {
    const source = await Bun.file(`${import.meta.dir}/Feedback.tsx`).text();
    for (const forbidden of ['Session', 'vaultKey', 'useCapture', 'VaultItem', 'featureVector']) {
      expect(source).not.toContain(forbidden);
    }
  });

  test('nothing in the built URL resembles vault or rhythm data', async () => {
    const opened = await render();
    await click('report');
    const decoded = decodeURIComponent(opened[0] ?? '');

    for (const forbidden of ['score', 'featureVector', 'ciphertext', 'authHash', 'commitments']) {
      expect(decoded).not.toContain(forbidden);
    }
  });
});
