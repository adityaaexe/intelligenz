import { defineConfig } from 'vitest/config';
import type { Reporter, TestModule } from 'vitest/node';

/**
 * Skips are a report, not a pass.
 *
 * `describe.skipIf(!temporalEnabled)` is the right shape for a suite that needs a live
 * server — the alternative is a test seam, which AG-603 removed. The hazard is the
 * summary line: a file whose tests all skipped reads as "green", and so did a file whose
 * `beforeAll` timed out (10 s default, against Temporal activities with a 30 s
 * `startToCloseTimeout`). Neither is evidence that anything was checked.
 *
 * Two guards, because they catch different regressions:
 *
 *   1. **Undeclared skip — hard fail, no baseline.** A test carries `options.mode ===
 *      'skip'` when it was declared skipped (`skipIf`, `skip`, `todo`). A test that is
 *      skipped while its mode is `'run'` was skipped by the runner, not by the suite:
 *      a failed hook, a hook timeout, an abort. Measured in Vitest 5.1: a throwing
 *      `beforeAll` and a timed-out `beforeAll` both leave `state=skipped, mode=run`,
 *      while `describe.skipIf` leaves `mode=skip`. That signature is the incident this
 *      guard exists for, and it is exact — it does not depend on how many tests skip.
 *   2. **Skip budget — a ceiling.** More than `VITEST_SKIP_BASELINE` (default 15)
 *      skipped tests fails the run. The baseline is the count recorded in
 *      `TEST-RESULTS.md` for this host. Note the provenance was corrected while this was
 *      written: those 15 are the **environment-limited** gates (cgroup enforcement, I/O
 *      limits, bwrap tier probes), not the live-Temporal ones. A single number therefore
 *      catches *growth* in the declared-skip population, and guard 1 covers the rest.
 *
 * Limits, stated rather than papered over: `--reporter=json` (the CI shape) replaces
 * config reporters, so neither guard is installed in that run — a CLI reporter override
 * necessarily owns the summary. Neither guard can prove a test was meaningful; they only
 * stop "did not run" from being reported as "passed".
 */
const skipBaseline = Number.parseInt(process.env['VITEST_SKIP_BASELINE'] ?? '15', 10);

interface SkipTally {
  readonly file: string;
  readonly skipped: number;
  readonly executed: number;
  readonly undeclared: readonly string[];
}

function skipBudgetReporter(): Reporter {
  return {
    onTestRunEnd(testModules: ReadonlyArray<TestModule>) {
      const tallies: SkipTally[] = [];
      let skipped = 0;
      let executed = 0;

      for (const testModule of testModules) {
        let fileSkipped = 0;
        let fileExecuted = 0;
        const undeclared: string[] = [];

        for (const test of testModule.children.allTests()) {
          // `result()` is an object in Vitest 5 (`{ state }`), not the state string.
          const { state } = test.result();

          if (state === 'skipped') {
            fileSkipped += 1;

            // `mode` is declared intent; `state` is what happened. A skip with no
            // declaration is the runner giving up on the test.
            const mode = test.options.mode;
            if (mode !== 'skip' && mode !== 'todo') undeclared.push(test.fullName);
          } else if (state === 'passed' || state === 'failed') {
            fileExecuted += 1;
          }
        }

        skipped += fileSkipped;
        executed += fileExecuted;

        if (fileSkipped > 0) {
          tallies.push({
            file: testModule.relativeModuleId,
            skipped: fileSkipped,
            executed: fileExecuted,
            undeclared,
          });
        }
      }

      if (skipped === 0) return;

      const ceiling = Number.isNaN(skipBaseline) ? 15 : skipBaseline;
      const undeclared = tallies.flatMap((tally) =>
        tally.undeclared.map((name) => `${tally.file} :: ${name}`),
      );
      const overBudget = skipped > ceiling;

      // stderr, not `console.*`: this runs in the main process after the run, and the
      // record must exist even when the summary is being piped or reformatted.
      const lines = [
        `[skip-budget] ${skipped} skipped test(s) in ${tallies.length} file(s), ${executed} executed — baseline ${ceiling}`,
        ...tallies.map(
          (tally) =>
            `[skip-budget]   ${tally.file}: ${tally.skipped} skipped, ${tally.executed} executed`,
        ),
      ];

      if (undeclared.length > 0) {
        lines.push(
          `[skip-budget] FAIL: ${undeclared.length} test(s) skipped without a declared gate (mode=run).`,
          '[skip-budget] That is the runner abandoning tests — a failed or timed-out hook, or an abort — not a suite decision:',
          ...undeclared.slice(0, 20).map((name) => `[skip-budget]   ${name}`),
          ...(undeclared.length > 20
            ? [`[skip-budget]   … and ${undeclared.length - 20} more`]
            : []),
        );
        process.exitCode = 1;
      }

      if (overBudget) {
        lines.push(
          `[skip-budget] FAIL: ${skipped} > ${ceiling}. A suite that did not run is not a passing suite.`,
          '[skip-budget] If this is a new intentional skip, record it in TEST-RESULTS.md and raise VITEST_SKIP_BASELINE.',
        );
        process.exitCode = 1;
      }

      process.stderr.write(`${lines.join('\n')}\n`);
    },
  };
}

export default defineConfig({
  test: {
    environment: 'node',
    include: ['apps/**/*.{test,spec}.{ts,tsx}', 'packages/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/coverage/**'],
    // A run that collected no test files is a mis-glob, not a pass: `apps/api`'s
    // `*.e2e-spec.ts` files are already invisible to the `include` glob above, and the
    // previous `true` made "the pattern matched nothing" exit 0.
    passWithNoTests: false,
    reporters: ['default', skipBudgetReporter()],
    // The worker integration suites start a real Temporal worker in `beforeAll`. That
    // hook's cold path is `NativeConnection.connect` + `Worker.create({workflowsPath})`,
    // and `Worker.create` bundles the workflows with webpack — measured on this host at
    // 2.46–2.52 s for the full `createExecutionHarness()` (bundle alone: 1.29–1.64 s
    // across five cold processes; there is no on-disk bundle cache, so each Vitest fork
    // pays it again). 60 s is ~24x that measurement and stays 60 s on purpose: the
    // tension is real but small — a hook that genuinely hangs fails in a minute instead
    // of ten seconds, while a cold bundle under parallel load cannot be mistaken for a
    // hang. `afterAll`'s `harness.close()` was measured at 12–42 ms.
    hookTimeout: 60_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      reportsDirectory: 'coverage',
      exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**', '**/*.test.ts', '**/*.config.*'],
    },
  },
});
