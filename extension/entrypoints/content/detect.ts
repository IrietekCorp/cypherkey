/**
 * Finding the login fields on a page.
 *
 * There is no reliable marker for "this is a login form", so this is a heuristic and is
 * treated as one: it decides *where* a fill could go, never *whether* one is allowed.
 * That decision belongs to `fill.ts`, which answers it from the origin alone.
 */

export type DetectedForm = {
  password: HTMLInputElement;
  /** Null when nothing plausible was found; a password-only form is common. */
  username: HTMLInputElement | null;
};

/** Attributes that name a username field across the sites that bother to say. */
const USERNAME_HINTS = ['username', 'email', 'login', 'user', 'account', 'identifier'];

/** A field the user cannot see or use is not a field to fill. */
function isUsable(input: HTMLInputElement): boolean {
  if (input.disabled || input.readOnly) return false;
  if (input.type === 'hidden') return false;
  const style = input.ownerDocument.defaultView?.getComputedStyle(input);
  if (style?.display === 'none' || style?.visibility === 'hidden') return false;
  return true;
}

/** Text-ish inputs that could hold a username. */
function couldBeUsername(input: HTMLInputElement): boolean {
  return ['text', 'email', 'tel', ''].includes(input.type) && isUsable(input);
}

function looksLikeUsername(input: HTMLInputElement): boolean {
  const haystack = [
    input.getAttribute('autocomplete') ?? '',
    input.name,
    input.id,
    input.getAttribute('aria-label') ?? '',
    input.placeholder,
  ]
    .join(' ')
    .toLowerCase();
  return USERNAME_HINTS.some((hint) => haystack.includes(hint));
}

/**
 * The username for a given password field.
 *
 * Order matters. The nearest *preceding* text input in the same form is right far more
 * often than any attribute heuristic, because it is what the page's own layout says.
 * Attributes are the fallback for forms that put the fields in separate containers, and
 * `autocomplete="username"` is checked first among them because it is the one signal a
 * site states deliberately rather than incidentally.
 */
function findUsername(password: HTMLInputElement, root: ParentNode): HTMLInputElement | null {
  const scope: ParentNode = password.form ?? root;
  const candidates = [...scope.querySelectorAll('input')].filter((el) =>
    couldBeUsername(el as HTMLInputElement),
  ) as HTMLInputElement[];
  if (candidates.length === 0) return null;

  const declared = candidates.find((el) =>
    (el.getAttribute('autocomplete') ?? '').includes('username'),
  );
  if (declared !== undefined) return declared;

  // Nearest preceding, by document order. The constant is read from the node rather
  // than from the `Node` global, which is not defined in every environment this runs in.
  const PRECEDING = password.DOCUMENT_POSITION_PRECEDING;
  const preceding = candidates.filter(
    (el) => (password.compareDocumentPosition(el) & PRECEDING) !== 0,
  );
  const nearest = preceding.at(-1);
  if (nearest !== undefined) return nearest;

  return candidates.find(looksLikeUsername) ?? null;
}

/**
 * Every password field on the page, paired with its likely username field.
 *
 * A page with two password fields is usually a change-password or sign-up form. Both
 * are returned; the caller decides, because filling a "new password" box with the old
 * one is a different mistake from filling the wrong site.
 */
export function detectLoginFields(root: ParentNode): DetectedForm[] {
  const passwords = [...root.querySelectorAll('input[type="password"]')].filter((el) =>
    isUsable(el as HTMLInputElement),
  ) as HTMLInputElement[];

  return passwords.map((password) => ({
    password,
    username: findUsername(password, root),
  }));
}

/**
 * True when a detected pair looks like *signing in* rather than setting a new password.
 *
 * Two password fields on a page is the clearest signal available, and it is worth
 * acting on: autofilling a change-password form with the current password looks like it
 * worked and silently sets the new password to the old one.
 */
export function looksLikeSignIn(forms: DetectedForm[]): boolean {
  return forms.length === 1;
}
