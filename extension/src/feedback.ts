/**
 * The beta feedback link.
 *
 * Everything here ends up in a URL: visible in the address bar, kept in browser
 * history, sent to GitHub, and readable by anyone who later looks at the issue. So the
 * rule is narrow and absolute — **nothing is attached automatically except the two
 * facts that cannot identify anyone**: which version of the extension, and which
 * browser. No logs, no scores, no feature vectors, no vault contents, no username, no
 * host the user was on.
 *
 * That is not caution for its own sake. A zero-knowledge client that quietly ships
 * diagnostics is a zero-knowledge client in name only, and the first person to notice
 * would be right to say so.
 */

export type FeedbackContext = {
  /** From the manifest, so a report names the build it came from. */
  version: string;
  /** Coarse: a name and a major version, never the full user-agent string. */
  browser: string;
};

/**
 * A browser name and major version, and nothing else.
 *
 * The full user-agent is a fingerprint — platform, architecture, build number, often
 * enough to single someone out. "Chrome 141" is what a maintainer needs to reproduce a
 * bug; the rest is only useful for identifying who filed it.
 */
export function coarseBrowser(userAgent: string): string {
  const patterns: Array<[string, RegExp]> = [
    // Edge and Opera both claim to be Chrome, so they are matched first.
    ['Edge', /Edg\/(\d+)/],
    ['Opera', /OPR\/(\d+)/],
    ['Firefox', /Firefox\/(\d+)/],
    ['Chrome', /Chrome\/(\d+)/],
    ['Safari', /Version\/(\d+).*Safari/],
  ];
  for (const [name, pattern] of patterns) {
    const match = pattern.exec(userAgent);
    if (match !== null) return `${name} ${match[1]}`;
  }
  return 'unknown browser';
}

/**
 * The issue body: a prompt for the user, and the two facts above.
 *
 * The prompts are questions rather than headings because a blank "Steps to reproduce"
 * gets left blank, and a report with no steps costs more to triage than it saves.
 */
export function issueBody(context: FeedbackContext): string {
  return [
    '<!-- Nothing was attached automatically. Please describe what happened. -->',
    '',
    '**What were you doing?**',
    '',
    '',
    '**What did you expect to happen?**',
    '',
    '',
    '**What happened instead?**',
    '',
    '',
    '---',
    `CypherKey ${context.version} · ${context.browser}`,
    '',
    '<!--',
    'Please do not paste your passphrase, a Recovery Kit, a Backup Code, or a screenshot',
    'of your vault. Nothing in this report needs them, and an issue is public.',
    '-->',
  ].join('\n');
}

/**
 * The `new issue` URL.
 *
 * `repo` is configurable because the repository is private during the beta: an issue
 * link to a repo the tester cannot see is a 404 and a dead end. Point it at a public
 * feedback repo, or replace it with a mailto, before handing the build to anyone
 * outside the org.
 */
export function buildIssueUrl(
  context: FeedbackContext & { repo: string; labels?: string[] },
): string {
  const url = new URL(`https://github.com/${context.repo}/issues/new`);
  url.searchParams.set('title', '');
  url.searchParams.set('body', issueBody(context));
  if (context.labels !== undefined && context.labels.length > 0) {
    url.searchParams.set('labels', context.labels.join(','));
  }
  return url.toString();
}
