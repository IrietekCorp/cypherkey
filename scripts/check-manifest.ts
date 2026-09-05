/**
 * Validates the built extension manifest against the rules Chrome applies at load time.
 *
 * These cannot be checked from the WXT config object: the manifest is generated, and a
 * config that looks right can still produce an artefact Chrome refuses. An empty
 * `matches` on a content script does not warn during the build and does not degrade
 * gracefully — the extension fails to load entirely.
 */

type Manifest = {
  manifest_version?: number;
  version?: string;
  permissions?: string[];
  content_security_policy?: { extension_pages?: string };
  content_scripts?: Array<{ matches?: string[] }>;
  web_accessible_resources?: Array<{ matches?: string[]; extension_ids?: string[] }>;
};

const MANIFEST_PATH = 'extension/.output/chrome-mv3/manifest.json';

/** Returns the problems found, so the checks are testable without a build. */
export function validateManifest(manifest: Manifest): string[] {
  const problems: string[] = [];

  if (manifest.manifest_version !== 3) {
    problems.push('manifest_version must be 3');
  }
  if (manifest.version === undefined || manifest.version.length === 0) {
    problems.push('version is required');
  }

  // M2-01 requirement 1: without this the Argon2 WASM module will not instantiate.
  const csp = manifest.content_security_policy?.extension_pages ?? '';
  if (!csp.includes("'wasm-unsafe-eval'")) {
    problems.push("extension_pages CSP lost 'wasm-unsafe-eval'");
  }
  if (csp.includes("'unsafe-eval'") && !csp.includes("'wasm-unsafe-eval'")) {
    problems.push("extension_pages CSP allows 'unsafe-eval'");
  }
  if (csp.includes("'unsafe-inline'")) {
    problems.push("extension_pages CSP allows 'unsafe-inline'");
  }

  manifest.content_scripts?.forEach((entry, i) => {
    if ((entry.matches ?? []).length === 0) {
      problems.push(`content_scripts[${i}].matches is empty — Chrome refuses to load this`);
    }
  });

  manifest.web_accessible_resources?.forEach((entry, i) => {
    if ((entry.matches ?? []).length === 0 && (entry.extension_ids ?? []).length === 0) {
      problems.push(`web_accessible_resources[${i}] needs matches or extension_ids`);
    }
  });

  return problems;
}

if (import.meta.main) {
  const file = Bun.file(MANIFEST_PATH);
  if (!(await file.exists())) {
    console.error(`  ${MANIFEST_PATH} not found. Run \`bun run build:extension\` first.\n`);
    process.exit(1);
  }

  const problems = validateManifest((await file.json()) as Manifest);
  if (problems.length > 0) {
    console.error('\n  The built manifest would not load:\n');
    for (const p of problems) console.error(`    - ${p}`);
    console.error('');
    process.exit(1);
  }
  console.log(`\n  ${MANIFEST_PATH} is valid\n`);
}
