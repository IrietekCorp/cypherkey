import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Credential, Session } from '../../../core/client/session';
import { refreshingRequest } from '../../src/authed';
import { type LockController, createLockController } from '../../src/lock';
import { type ResumeRefusal, loadResume, touchResume, watchResume } from '../../src/resume';
import type { StorageArea } from '../../src/storage';
import { Settings } from './Settings';

/**
 * The options page's session, which it is not given and has to go and find.
 *
 * **Why this is the whole problem.** Every control on Settings is an authenticated
 * request, and this is a second document: the popup's keys are in the popup's heap, and
 * a tab has no claim on them. Until now the page rendered a placeholder saying so.
 *
 * **Why it does not ask for the passphrase.** It could: a passphrase box and one Argon2id
 * pass would unlock this document on its own. It deliberately does not, because a
 * password prompt on a tab the user did not unlock is indistinguishable — to the user —
 * from the phishing page that copies it. The extension has exactly one place where a
 * passphrase is typed, and adding a second teaches the wrong habit to protect a
 * convenience.
 *
 * **So it resumes instead.** M2-18 already keeps a snapshot in `chrome.storage.session`,
 * bounded by an idle deadline and a hard cap, wiped when the browser shuts down. This
 * page reads the same snapshot the popup does. Nothing resumable means "unlock in the
 * popup", and `watchResume` means the page notices when that happens rather than making
 * the user reload it.
 */
export type OptionsAppProps = {
  session: Session;
  /** `chrome.storage.session`, or null outside the extension. Never `storage.local`. */
  memory: StorageArea | null;
  now?: () => number;
  /** Injected by tests; production watches `chrome.storage.session`. */
  watch?: (listener: () => void) => () => void;
  /** Injected by tests. Production builds one over the real clock. */
  lock?: LockController;
};

/** Why the page is not showing settings, in the words the user reads. */
export const CLOSED_MESSAGES: Record<ResumeRefusal | 'locked', string> = {
  none: 'Open CypherKey from the toolbar and unlock. This page will pick it up on its own.',
  // A snapshot we cannot read is not worth explaining; the action is the same either way.
  malformed: 'Open CypherKey from the toolbar and unlock. This page will pick it up on its own.',
  idle: 'That session timed out. Open CypherKey from the toolbar and unlock again.',
  expired:
    'Sessions end after a day, however busy you have been. Open CypherKey from the toolbar and unlock again.',
  locked:
    'This page locked itself after sitting idle. Open CypherKey from the toolbar and unlock again.',
};

/**
 * Said on the closed screen, every time.
 *
 * The absence of a passphrase box is a decision, and an unexplained absence reads as a
 * missing feature. Stating it also does a small amount of teaching: a page that asks for
 * the passphrase is one to be suspicious of.
 */
export const NO_PROMPT_HERE =
  'There is no passphrase box on this page on purpose. Your passphrase is typed in one place — the extension itself — so that a page asking for it is always the wrong page.';

/** The Strict crossing, and why it is not this screen's to make. */
export const REKEY_MESSAGE =
  'Crossing into or out of Strict re-derives your keys from your passphrase, so it cannot be a settings change — it needs the passphrase typed and every device re-authenticated. No screen does it yet; this one states your level and refuses to pretend.';

type Gate =
  | { status: 'checking' }
  | { status: 'open'; token: string }
  | { status: 'closed'; reason: ResumeRefusal | 'locked' };

export function OptionsApp({
  session,
  memory,
  now = Date.now,
  watch = watchResume,
  lock,
}: OptionsAppProps) {
  const [gate, setGate] = useState<Gate>({ status: 'checking' });
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * A-5, for a document that can sit open for days.
   *
   * A resumed page holds the vault key in its own heap, and the snapshot's deadlines
   * bound the *snapshot*, not this tab. Locking here zeroes this document's keys and
   * leaves the shared snapshot alone: an idle settings tab is not the browser being
   * idle, and it must not sign the popup out.
   */
  const controller = useMemo(() => lock ?? createLockController({ session }), [lock, session]);

  const resume = useCallback(
    async (options: { touch: boolean }) => {
      if (memory === null) {
        setGate({ status: 'closed', reason: 'none' });
        return;
      }
      const found = await loadResume(memory, now());
      if (!found.resumed) {
        setGate({ status: 'closed', reason: found.reason });
        return;
      }
      if (!session.resumeFrom(found.stored.snapshot)) {
        setGate({ status: 'closed', reason: 'malformed' });
        return;
      }
      // Only on the way in. Touching on every notification would write to the area this
      // page is watching, and the write would notify it again.
      if (options.touch) await touchResume(memory, now());
      controller.touch();
      const token = session.tokens()?.accessToken ?? '';
      setGate((previous) =>
        previous.status === 'open' && previous.token === token
          ? previous
          : { status: 'open', token },
      );
    },
    [controller, memory, now, session],
  );

  useEffect(() => {
    void resume({ touch: true });
  }, [resume]);

  /*
    The popup unlocking, or locking, while this page is open.

    Both directions matter. Someone who lands here locked, unlocks in the popup and comes
    back should find settings rather than the same refusal; and a manual lock in the popup
    clears the snapshot, which must close this page too rather than leave a second
    unlocked surface behind the one the user just locked.
  */
  useEffect(() => watch(() => void resume({ touch: false })), [watch, resume]);

  useEffect(() => {
    const off = controller.onLock(() => setGate({ status: 'closed', reason: 'locked' }));
    return () => {
      off();
      // Teardown, not a security event: `dispose` stops the timer and does not lock.
      controller.dispose();
    };
  }, [controller]);

  // Activity, for the idle clock. No `pagehide` handler: this is a tab, and a tab
  // navigating away destroys the document and its keys with it.
  useEffect(() => {
    const target = (globalThis as { window?: typeof globalThis.window }).window;
    if (target === undefined) return;
    const activity = () => controller.touch();
    for (const event of ['keydown', 'pointerdown', 'focus'] as const) {
      target.addEventListener(event, activity);
    }
    return () => {
      for (const event of ['keydown', 'pointerdown', 'focus'] as const) {
        target.removeEventListener(event, activity);
      }
    };
  }, [controller]);

  /**
   * Every request Settings makes, with the token renewal attached.
   *
   * Memoized over the session because Settings reloads whenever `request` changes, and
   * an identity that changed per render would put it in a loop.
   */
  const request = useMemo(
    () =>
      refreshingRequest({
        session,
        memory,
        now,
        onTokens: (token) => setGate({ status: 'open', token }),
        onLost: () => setGate({ status: 'closed', reason: 'expired' }),
      }),
    [session, memory, now],
  );

  const prove = useCallback((input: Credential) => session.authProof(input), [session]);

  if (gate.status === 'checking') {
    // One frame of nothing beats a frame of the wrong answer, and "unlock first" is the
    // wrong answer to say to someone who is already unlocked.
    return (
      <main className="ck-app" style={{ padding: 'var(--ck-s6)' }}>
        <p className="ck-small ck-muted">Looking for your session…</p>
      </main>
    );
  }

  if (gate.status === 'closed') {
    return (
      <main
        className="ck-app flex flex-col"
        style={{ padding: 'var(--ck-s6)', gap: 'var(--ck-s5)', maxWidth: 620, minHeight: '100vh' }}
      >
        <header className="flex items-baseline" style={{ gap: 'var(--ck-s2)' }}>
          <span className="ck-wordmark">CypherKey</span>
          <h1 className="ck-h1 ck-muted">settings</h1>
        </header>

        <section className="card flex flex-col" style={{ gap: 'var(--ck-s2)' }}>
          <h2 className="ck-h2">Locked</h2>
          <p data-testid="closed-message" className="ck-small">
            {CLOSED_MESSAGES[gate.reason]}
          </p>
          <p data-testid="no-prompt-here" className="ck-small ck-muted">
            {NO_PROMPT_HERE}
          </p>
        </section>
      </main>
    );
  }

  return (
    <>
      <Settings
        request={request}
        accessToken={gate.token}
        prove={prove}
        onRekeyRequested={() => setNotice(REKEY_MESSAGE)}
        now={now}
      />
      {notice !== null && (
        <p
          data-testid="rekey-notice"
          className="ck-small ck-muted"
          style={{ padding: '0 var(--ck-s6) var(--ck-s6)', maxWidth: 620 }}
        >
          {notice}
        </p>
      )}
    </>
  );
}
