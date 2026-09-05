import { getDomain } from 'tldts';
import { isPunycodeHost } from './banner';
import type { DetectedForm } from './detect';

/**
 * Whether a credential may be put on this page, and putting it there.
 *
 * This is the only place in the product where a mistake hands a password to someone
 * else, so the decision is a pure function with an explicit reason, kept separate from
 * the DOM work that acts on it. Every refusal names itself: a silent no is impossible
 * to debug and indistinguishable from a bug.
 */

export type FillDecision =
  | { allowed: true; reason: 'exact' | 'registrable' }
  | { allowed: false; reason: 'punycode' | 'different-site' | 'subframe' | 'unknown-host' };

export type FillContext = {
  /** `location.hostname` of the page asking to be filled. */
  pageHost: string;
  /** The host saved on the vault item. */
  savedHost: string;
  /** False inside any iframe. */
  isTopFrame: boolean;
};

/** Lower-cases, drops a port, and tolerates a saved value that includes a scheme or path. */
export function normalizeHost(raw: string): string {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length === 0) return '';
  const withoutScheme = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  const host = withoutScheme.split('/')[0] ?? '';
  // An IPv6 literal keeps its brackets; everything else loses a trailing :port.
  return host.startsWith('[') ? host : (host.split(':')[0] ?? '');
}

export function decideFill(context: FillContext): FillDecision {
  /**
   * Frames first, before anything else is considered.
   *
   * A content script runs in every frame. An attacker who can embed the real site in an
   * iframe cannot read what we type into it, but they control what surrounds it and
   * when it is clicked. Filling only the top frame gives that up in exchange for
   * removing a whole class of clickjacking, and the cost is that framed login widgets
   * are filled by hand.
   */
  if (!context.isTopFrame) return { allowed: false, reason: 'subframe' };

  const page = normalizeHost(context.pageHost);
  const saved = normalizeHost(context.savedHost);
  if (page.length === 0 || saved.length === 0) {
    return { allowed: false, reason: 'unknown-host' };
  }

  /**
   * Punycode, before any matching.
   *
   * `xn--` means the host contains non-ASCII that a browser renders as letters which
   * may be visually identical to Latin ones. The user cannot tell the difference by
   * looking, so neither the exact nor the registrable comparison below is evidence of
   * anything. Refusing costs a legitimate IDN site its autofill; that is the deliberate
   * trade, and the banner explains it rather than failing silently.
   */
  if (isPunycodeHost(page)) return { allowed: false, reason: 'punycode' };

  if (page === saved) return { allowed: true, reason: 'exact' };

  // Registrable-domain match, so gist.github.com fills a github.com credential.
  const pageDomain = getDomain(page);
  const savedDomain = getDomain(saved);
  // null means no public suffix — localhost, an IP, an intranet name. There is no
  // registrable domain to compare, so exact equality above was the only chance.
  if (pageDomain !== null && savedDomain !== null && pageDomain === savedDomain) {
    return { allowed: true, reason: 'registrable' };
  }

  return { allowed: false, reason: 'different-site' };
}

export type Credential = { username: string; password: string };

/**
 * Puts the credential into the fields, firing the events a page needs to notice.
 *
 * React and friends track an input's value on the node, so assigning `.value` directly
 * is ignored by the framework and the form submits empty. Going through the prototype
 * setter is what makes the change visible to them — the same problem the tests hit from
 * the other direction.
 */
export function applyFill(form: DetectedForm, credential: Credential): void {
  if (form.username !== null && credential.username.length > 0) {
    setValue(form.username, credential.username);
  }
  setValue(form.password, credential.password);
}

function setValue(input: HTMLInputElement, value: string): void {
  const view = input.ownerDocument.defaultView;
  const setter =
    view === null
      ? undefined
      : Object.getOwnPropertyDescriptor(view.HTMLInputElement.prototype, 'value')?.set;

  if (setter === undefined) input.value = value;
  else setter.call(input, value);

  // Constructed from the *document's* realm, not from whatever `Event` is in scope
  // here. A content script and its page are different realms, and an event built from
  // the wrong one is rejected by `dispatchEvent`.
  const EventCtor = view?.Event ?? Event;
  input.dispatchEvent(new EventCtor('input', { bubbles: true }));
  input.dispatchEvent(new EventCtor('change', { bubbles: true }));
}
