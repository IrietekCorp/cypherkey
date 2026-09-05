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
  {
    name: 'extension popup (eager, gzipped)',
    budgetBytes: 150 * KB,
    note: 'what every popup open pays: the entry chunk plus its STATIC import closure. This is the unlock-latency number, and it is the one that matters — a dynamic import costs nothing until its screen is reached',
  },
  {
    name: 'extension package (total)',
    budgetBytes: 3 * MB,
    note: 'install size. Grows with lazily-loaded screens, which cost nothing at open but everything at download; zxcvbn dictionaries alone are 428 KB',
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

const OUT = 'extension/.output/chrome-mv3';

/**
 * What the popup pays on every open: its entry script plus everything that script
 * *statically* imports, transitively.
 *
 * Dynamic `import()` is deliberately not followed. zxcvbn's dictionaries are 225 KB
 * gzipped and are only fetched on the onboarding screen; counting them here would
 * budget a cost the unlock path never pays, and would push us to inline things that
 * are correctly lazy.
 */
async function eagerPopupBytes(): Promise<number> {
  const html = await Bun.file(`${OUT}/popup.html`).text();
  const seen = new Set<string>();

  const walk = async (relative: string): Promise<void> => {
    const path = `${OUT}/${relative.replace(/^\//, '')}`;
    if (seen.has(path)) return;
    const file = Bun.file(path);
    if (!(await file.exists())) return;
    seen.add(path);

    const code = await file.text();
    const dir = path.slice(0, path.lastIndexOf('/'));
    // `from "..."` and `import "..."`, which excludes `import(\`...\`)`.
    for (const match of code.matchAll(/(?:from|import)\s*"([^"]+)"/g)) {
      const target = match[1];
      if (target === undefined || !target.startsWith('.')) continue;
      const resolved = new URL(target, `file:///${dir}/`).pathname.replace(/^\//, '');
      await walk(resolved.slice(OUT.length + 1));
    }
  };

  for (const match of html.matchAll(/src="([^"]+)"/g)) {
    const src = match[1];
    if (src !== undefined) await walk(src);
  }

  let total = 0;
  for (const path of seen) total += await gzippedSize(path);
  return total;
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

  const extension = Bun.spawnSync(['bun', 'run', 'build:extension']);
  if (extension.exitCode !== 0) {
    throw new Error(`extension build failed:\n${extension.stderr.toString()}`);
  }
  const eager = await eagerPopupBytes();
  let packageBytes = 0;
  for await (const file of new Bun.Glob('extension/.output/chrome-mv3/**/*').scan('.')) {
    packageBytes += Bun.file(file).size;
  }

  return [
    { name: 'server binary (total)', bytes: binary },
    { name: 'server binary (our payload)', bytes: Math.max(0, binary - runtime) },
    { name: 'site (gzipped)', bytes: siteBytes },
    { name: 'extension popup (eager, gzipped)', bytes: eager },
    { name: 'extension package (total)', bytes: packageBytes },
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
