/**
 * Enforces the A-15 size budgets, and fails the build when one is exceeded.
 *
 * The evaluation is a pure function so it can be tested against fixtures without
 * building anything; the CLI at the bottom does the measuring.
 */

export type Budget = {
  name: string;
  budgetBytes: number;
  /** Why this number, so a future reader can tell a real regression from a stale limit. */
  note: string;
};

export type Measurement = { name: string; bytes: number };

export type Result = {
  name: string;
  bytes: number;
  budgetBytes: number;
  withinBudget: boolean;
  /** Fraction of the budget used. 1.0 is exactly at the limit. */
  used: number;
  note: string;
};

const MB = 1024 * 1024;
const KB = 1024;

/**
 * docs/02 A-15.
 *
 * The server binary budget is expressed twice on purpose. The total is dominated by
 * the Bun runtime, which we do not control and which grows between Bun releases; the
 * payload is our own code and dependencies, and it is the number that actually
 * regresses when someone adds a package.
 */
export const BUDGETS: Budget[] = [
  {
    name: 'server binary (total)',
    budgetBytes: 95 * MB,
    note: 'Bun 1.4 runtime alone is ~77 MB, so this tracks the runtime more than our code',
  },
  {
    name: 'server binary (our payload)',
    budgetBytes: 8 * MB,
    note: 'binary minus the Bun runtime — this is the number a new dependency moves',
  },
  {
    name: 'site (gzipped)',
    budgetBytes: 120 * KB,
    note: 'A-15: cypherkey.io under 120 KB total',
  },
];

/** Formats a byte count the way a build log should read. */
export function formatBytes(bytes: number): string {
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Compares measurements against budgets. A budget with no measurement is reported as
 * a failure rather than skipped: a target that silently stopped being measured is how
 * a budget quietly stops being enforced.
 */
export function evaluate(measurements: Measurement[], budgets: Budget[] = BUDGETS): Result[] {
  const found = new Map(measurements.map((m) => [m.name, m.bytes]));
  return budgets.map((budget) => {
    const bytes = found.get(budget.name) ?? Number.POSITIVE_INFINITY;
    return {
      name: budget.name,
      bytes,
      budgetBytes: budget.budgetBytes,
      withinBudget: bytes <= budget.budgetBytes,
      used: bytes / budget.budgetBytes,
      note: budget.note,
    };
  });
}

/** True when every budget held. */
export function allWithinBudget(results: Result[]): boolean {
  return results.every((r) => r.withinBudget);
}

/** A table for the build log and the PR summary. */
export function formatReport(results: Result[]): string {
  const lines = results.map((r) => {
    const mark = r.withinBudget ? 'ok  ' : 'OVER';
    const size = Number.isFinite(r.bytes) ? formatBytes(r.bytes) : 'not measured';
    const pct = Number.isFinite(r.used) ? `${(r.used * 100).toFixed(0)}%` : '—';
    return `  ${mark} ${r.name.padEnd(28)} ${size.padStart(12)} / ${formatBytes(r.budgetBytes).padStart(9)}  ${pct.padStart(5)}`;
  });
  return ['', '  A-15 size budgets', ...lines, ''].join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function gzippedSize(path: string): Promise<number> {
  return Bun.gzipSync(await Bun.file(path).bytes()).byteLength;
}

async function measure(): Promise<Measurement[]> {
  const out = `${Bun.env.TMPDIR ?? '/tmp'}/cypherkey-size-check`;

  const built = Bun.spawnSync([
    'bun',
    'build',
    '--compile',
    '--minify',
    '--target=bun',
    'server/src/index.ts',
    '--outfile',
    `${out}/cypherkey`,
  ]);
  if (built.exitCode !== 0) {
    throw new Error(`bun build --compile failed:\n${built.stderr.toString()}`);
  }
  const binary = Bun.file(`${out}/cypherkey`).size;

  // The Bun runtime is the floor of a compiled binary; subtracting it leaves our code.
  const runtimePath = Bun.which('bun');
  const runtime = runtimePath === null ? 0 : Bun.file(runtimePath).size;

  const site = Bun.spawnSync(['bun', 'run', 'build:site']);
  if (site.exitCode !== 0) {
    throw new Error(`site build failed:\n${site.stderr.toString()}`);
  }
  const assets = new Bun.Glob('site/dist/**/*.{html,js,css}');
  let siteBytes = 0;
  for await (const file of assets.scan('.')) {
    siteBytes += await gzippedSize(file);
  }

  return [
    { name: 'server binary (total)', bytes: binary },
    { name: 'server binary (our payload)', bytes: Math.max(0, binary - runtime) },
    { name: 'site (gzipped)', bytes: siteBytes },
  ];
}

if (import.meta.main) {
  const results = evaluate(await measure());
  console.log(formatReport(results));
  if (!allWithinBudget(results)) {
    console.error('  A size budget was exceeded. See docs/02 A-15.\n');
    process.exit(1);
  }
}
