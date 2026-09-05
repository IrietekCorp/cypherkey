import { describe, expect, test } from 'bun:test';
import {
  BUDGETS,
  type Budget,
  allWithinBudget,
  evaluate,
  formatBytes,
  formatReport,
} from './size-check';

const MB = 1024 * 1024;
const KB = 1024;

const FIXTURE: Budget[] = [
  { name: 'small thing', budgetBytes: 100 * KB, note: 'fixture' },
  { name: 'big thing', budgetBytes: 10 * MB, note: 'fixture' },
];

describe('evaluate', () => {
  test('passes when everything is under budget', () => {
    const results = evaluate(
      [
        { name: 'small thing', bytes: 40 * KB },
        { name: 'big thing', bytes: 5 * MB },
      ],
      FIXTURE,
    );
    expect(results.every((r) => r.withinBudget)).toBe(true);
    expect(allWithinBudget(results)).toBe(true);
    expect(results[0]?.used).toBeCloseTo(0.4, 5);
  });

  test('fails when one is over budget, and names which', () => {
    const results = evaluate(
      [
        { name: 'small thing', bytes: 40 * KB },
        { name: 'big thing', bytes: 11 * MB },
      ],
      FIXTURE,
    );
    expect(allWithinBudget(results)).toBe(false);
    expect(results.filter((r) => !r.withinBudget).map((r) => r.name)).toEqual(['big thing']);
  });

  test('exactly at the budget passes; one byte over does not', () => {
    const at = evaluate([{ name: 'small thing', bytes: 100 * KB }], [FIXTURE[0] as Budget]);
    expect(at[0]?.withinBudget).toBe(true);
    expect(at[0]?.used).toBe(1);

    const over = evaluate([{ name: 'small thing', bytes: 100 * KB + 1 }], [FIXTURE[0] as Budget]);
    expect(over[0]?.withinBudget).toBe(false);
  });

  /**
   * A target that stops being measured must fail, not vanish. Skipping it silently is
   * how a budget stops being enforced without anyone noticing.
   */
  test('an unmeasured budget fails rather than being skipped', () => {
    const results = evaluate([{ name: 'small thing', bytes: 1 * KB }], FIXTURE);
    expect(results).toHaveLength(2);
    expect(results[1]?.withinBudget).toBe(false);
    expect(results[1]?.bytes).toBe(Number.POSITIVE_INFINITY);
    expect(allWithinBudget(results)).toBe(false);
  });

  test('a measurement with no budget is ignored', () => {
    const results = evaluate(
      [
        { name: 'small thing', bytes: 1 * KB },
        { name: 'big thing', bytes: 1 * KB },
        { name: 'something nobody budgeted', bytes: 999 * MB },
      ],
      FIXTURE,
    );
    expect(results.map((r) => r.name)).toEqual(['small thing', 'big thing']);
    expect(allWithinBudget(results)).toBe(true);
  });

  test('carries the note through, so a failure explains the number', () => {
    const results = evaluate([{ name: 'small thing', bytes: 1 }], FIXTURE);
    expect(results[0]?.note).toBe('fixture');
  });
});

describe('formatBytes', () => {
  test('scales to the unit a reader expects', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2 * KB)).toBe('2.0 KB');
    expect(formatBytes(79 * MB)).toBe('79.0 MB');
  });
});

describe('formatReport', () => {
  test('marks the failing row and shows the percentage used', () => {
    const report = formatReport(
      evaluate(
        [
          { name: 'small thing', bytes: 50 * KB },
          { name: 'big thing', bytes: 20 * MB },
        ],
        FIXTURE,
      ),
    );
    expect(report).toContain('ok');
    expect(report).toContain('OVER');
    expect(report).toContain('50%');
    expect(report).toContain('200%');
  });

  test('says so when something was never measured', () => {
    expect(formatReport(evaluate([], FIXTURE))).toContain('not measured');
  });
});

describe('the real budgets', () => {
  test('cover every target A-15 names for this milestone', () => {
    expect(BUDGETS.map((b) => b.name)).toEqual([
      'server binary (total)',
      'server binary (our payload)',
      'site (gzipped)',
      'extension popup (eager, gzipped)',
      'extension package (total)',
    ]);
  });

  test('every budget carries a note explaining its number', () => {
    for (const budget of BUDGETS) {
      expect(budget.note.length).toBeGreaterThan(10);
      expect(budget.budgetBytes).toBeGreaterThan(0);
    }
  });
});
