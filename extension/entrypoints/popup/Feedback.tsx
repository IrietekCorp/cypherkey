import { buildIssueUrl, coarseBrowser } from '../../src/feedback';

/**
 * The beta feedback link.
 *
 * It builds a URL and opens it. It takes no session, no vault and no capture state —
 * not as a matter of discipline but structurally: there is nothing here that *could*
 * attach them, so a future edit that wanted to would have to add a prop and explain
 * itself in review.
 */

/** Private during the beta. A tester who is not a collaborator sees a 404. */
export const FEEDBACK_REPO = 'IrietekCorp/cypherkey';

export type FeedbackProps = {
  version: string;
  userAgent: string;
  /** Injected so the test does not open a tab. */
  open?: (url: string) => void;
};

export function Feedback({ version, userAgent, open }: FeedbackProps) {
  const url = buildIssueUrl({
    repo: FEEDBACK_REPO,
    version,
    browser: coarseBrowser(userAgent),
    labels: ['beta'],
  });

  const go = () => {
    if (open !== undefined) open(url);
    else window.open(url, '_blank', 'noopener,noreferrer');
  };

  return (
    <section className="card flex flex-col" style={{ gap: 'var(--ck-s3)' }}>
      {/* Frame 16. A panel, not a page: it is reached from the profile. */}
      <h2 className="ck-h2">Report a problem</h2>
      <p className="ck-small ck-muted">
        {/*
          Said plainly, because the opposite is what people assume: a bug report from a
          password manager sounds like it might carry diagnostics, and this one does not.
        */}
        Nothing is attached automatically — no logs, no scores, nothing from your vault. The report
        carries only which version you are running and which browser.
      </p>
      <p
        data-testid="attached"
        className="ck-small ck-muted"
        style={{
          padding: 'var(--ck-s2) var(--ck-s3)',
          borderRadius: 'var(--ck-r-md)',
          background: 'var(--ck-inset)',
        }}
      >
        CypherKey {version} · {coarseBrowser(userAgent)}
      </p>
      <button
        type="button"
        data-testid="report"
        onClick={go}
        className="btn btn-secondary self-start"
      >
        Open a report
      </button>
    </section>
  );
}
