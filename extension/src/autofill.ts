import { type FillDecision, decideFill } from '../entrypoints/content/fill';

/**
 * Driving a fill from the popup.
 *
 * The extension holds `activeTab`, so nothing runs on a page until the user invokes it
 * there. That makes the popup the place where the decision is made: it reads the active
 * tab's URL, runs `decideFill`, and only then injects anything. A page never learns the
 * extension exists unless a fill was actually allowed.
 *
 * The credential travels by `executeScript` argument rather than by message. Arguments
 * are structured-cloned into the one call and go nowhere else; a message listener would
 * have to sit in the page waiting to be told a password, which is a strictly larger
 * target for anything else on that page.
 */

export type Credential = { username: string; password: string };

/** The slice of the extension API this needs, so tests supply a double. */
export type BrowserApi = {
  tabs: {
    query(info: { active: true; currentWindow: true }): Promise<
      Array<{ id?: number; url?: string }>
    >;
  };
  scripting: {
    executeScript(injection: {
      target: { tabId: number };
      func: (credential: Credential) => void;
      args: [Credential];
    }): Promise<unknown>;
  };
};

export type AutofillOutcome =
  | { filled: true; reason: FillDecision['reason'] }
  | { filled: false; reason: FillDecision['reason'] | 'no-tab' | 'injection-failed' };

/**
 * Runs in the *page*, not here.
 *
 * It is a standalone function because `executeScript` serialises it: nothing it closes
 * over comes with it, so it cannot import the detector and has to carry its own. Kept
 * deliberately small for that reason — the decision was already made in the popup, and
 * all that is left is putting two strings in two fields.
 *
 * Exported so it can be run against a DOM in tests. A source-grep would prove nothing:
 * a mistake in here only shows up when it executes.
 */
export function fillInPage(credential: Credential): void {
  if (window.top !== window.self) return;

  const passwords = [...document.querySelectorAll('input[type="password"]')].filter((el) => {
    const input = el as HTMLInputElement;
    return !input.disabled && !input.readOnly && input.type !== 'hidden';
  }) as HTMLInputElement[];

  // Two password fields is a change-password form. Filling the current password into a
  // "new password" box looks like it worked and silently sets the new one to the old.
  if (passwords.length !== 1) return;
  const password = passwords[0] as HTMLInputElement;

  const scope: ParentNode = password.form ?? document;
  const candidates = [...scope.querySelectorAll('input')].filter((el) => {
    const input = el as HTMLInputElement;
    return ['text', 'email', 'tel', ''].includes(input.type) && !input.disabled && !input.readOnly;
  }) as HTMLInputElement[];

  const declared = candidates.find((el) =>
    (el.getAttribute('autocomplete') ?? '').includes('username'),
  );
  const preceding = candidates.filter(
    (el) => (password.compareDocumentPosition(el) & password.DOCUMENT_POSITION_PRECEDING) !== 0,
  );
  const username = declared ?? preceding.at(-1) ?? null;

  const setValue = (input: HTMLInputElement, value: string): void => {
    // React and friends track an input's value on the node, so a direct assignment is
    // ignored by the framework and the form submits empty.
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter === undefined) input.value = value;
    else setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };

  if (username !== null && credential.username.length > 0) {
    setValue(username, credential.username);
  }
  setValue(password, credential.password);
}

/**
 * Decides, then fills.
 *
 * Nothing is injected unless `decideFill` allowed it, so a page on the wrong host never
 * receives the script at all — the refusal costs it no information beyond the fact that
 * the popup was opened.
 */
export async function autofillActiveTab(
  api: BrowserApi,
  savedHost: string,
  credential: Credential,
): Promise<AutofillOutcome> {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true });
  if (tab?.id === undefined || tab.url === undefined) {
    return { filled: false, reason: 'no-tab' };
  }

  let pageHost: string;
  try {
    pageHost = new URL(tab.url).hostname;
  } catch {
    return { filled: false, reason: 'unknown-host' };
  }

  // The popup is always the top frame's context for this purpose: `executeScript`
  // targets the tab, and `fillInPage` refuses to run in a subframe itself.
  const decision = decideFill({ pageHost, savedHost, isTopFrame: true });
  if (!decision.allowed) return { filled: false, reason: decision.reason };

  try {
    await api.scripting.executeScript({
      target: { tabId: tab.id },
      func: fillInPage,
      args: [credential],
    });
  } catch {
    // A tab can navigate or close between the query and the injection, and a
    // chrome:// page refuses injection outright. None of that is worth an exception.
    return { filled: false, reason: 'injection-failed' };
  }

  return { filled: true, reason: decision.reason };
}

/** What the user is told. Every refusal says something; none is silent. */
export function outcomeMessage(outcome: AutofillOutcome, savedHost: string): string {
  if (outcome.filled) return 'Filled.';
  switch (outcome.reason) {
    case 'punycode':
      return 'This address uses characters that can look like ordinary letters. CypherKey will not fill here — check the address bar.';
    case 'different-site':
      return `This item is saved for ${savedHost}, and that is not this site.`;
    case 'subframe':
      return 'CypherKey only fills the main page, not an embedded frame.';
    case 'unknown-host':
      return 'This page has no address CypherKey can check against.';
    case 'no-tab':
      return 'No page is open to fill.';
    default:
      return 'That page would not accept a fill. Some browser pages never do.';
  }
}
