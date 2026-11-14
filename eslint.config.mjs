import js from '@eslint/js';
import tseslint from 'typescript-eslint';

/**
 * SEC-403 — spawn discipline on the sandbox boundary.
 *
 * `child_process` inherits the parent environment unless `env:` is passed, so a bare
 * `execFile`/`spawn` silently hands the worker's credentials to whatever it launches.
 * Two bwrap spawns did exactly that in Phase 3. They were fixed, but the class survived:
 * a new `execFile` written outside the helper leaked again (`p3-real-run.ts`), because
 * Node's default is inheritance and nothing enforced the helper.
 *
 * ESLint can see an import; it cannot reliably see whether an options object contains
 * `env:`. So the enforceable proxy is: production code on the sandbox boundary may not
 * import `child_process` at all. Everything goes through a sanctioned owner, and each
 * owner is listed below with the reason its environment handling is safe. A new spawn
 * site must either use the helper or add itself to `SPAWN_OWNERS` — a visible, reviewed
 * decision instead of an omission. Tests are excluded: they spawn to *measure* isolation
 * and are not shipped.
 */
const SPAWN_BOUNDARY_FILES = [
  'packages/agent-runtime/src/**/*.{ts,mts,cts}',
  'packages/workspace-manager/src/**/*.{ts,mts,cts}',
  'apps/worker/src/**/*.{ts,mts,cts}',
  // Operator scripts are where this leak was first found, so they are covered too.
  'infra/scripts/**/*.{ts,mts,cts}',
];

/**
 * The complete allowlist of files permitted to reach `child_process`. Each entry is a
 * spawn site that exists today; adding another is a deliberate, reviewable diff.
 */
const SPAWN_OWNERS = [
  // Passes `env: command.env`, built by `sandboxSpawnEnv` from PATH/LANG/HOME/TMPDIR.
  // Also probes `bwrap --help` via spawnSync (fixed argv) to decide rlimit flags.
  'packages/workspace-manager/src/sandbox.ts',
  // Host-side git only (clone/worktree/rev-parse). It deliberately inherits the
  // operator's environment so git config and credential helpers work; argv is an array
  // and `shell: true` is never used. Residual by design — see the SEC-403 report.
  'packages/workspace-manager/src/manager.ts',
  // The process-group owner. Its env default is itself an allowlist ({PATH, LANG}).
  'packages/agent-runtime/src/process-group.ts',
  // `opencode --version`: a capability probe with a constant argv and no caller data.
  // Residual: it inherits the worker env (constant argv, so no injection — report §4).
  'packages/agent-runtime/src/runtimes/opencode-cli.ts',
  // cgroup probe: `node -e 'setTimeout(...)'`, constant argv, no caller data.
  // Residual: it inherits the worker env (constant argv, so no injection — report §4).
  'apps/worker/src/capabilities.ts',
  // Host-side git for the Phase 3 fixture (init/add/commit/status/rev-parse). Like
  // manager.ts it deliberately inherits the operator env for git config; argv is an
  // array, never a shell string. The sandboxed run beside it goes through execSandboxed.
  'infra/scripts/p3-real-run.ts',
  // Read-only sandbox audit; already passes an explicit scrubbed env to every spawn.
  'infra/scripts/p3-sandbox-audit.ts',
  // Egress-broker proof; already passes an explicit scrubbed env to every spawn.
  'infra/scripts/p4-broker-proof.ts',
];

const SPAWN_MESSAGE =
  'Do not import child_process directly (SEC-403): Node inherits the parent environment, ' +
  'so a bare spawn leaks the worker env. Use execSandboxed()/probeSandbox() from ' +
  '@intelligenz/workspace-manager (env comes from the PATH/LANG/HOME/TMPDIR allowlist) or ' +
  'the process-group helper from @intelligenz/agent-runtime. If this file genuinely owns ' +
  'spawning, add it to SPAWN_OWNERS in eslint.config.mjs with the reason its env is safe.';

/**
 * Flat config. Deliberately not type-aware: `tsc --noEmit` is the type gate and
 * runs separately, so linting does not need to build a program (it stays fast).
 */
export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/.next/**',
      '**/coverage/**',
      '**/.turbo/**',
      '**/.temporal/**',
      '**/.artifacts/**',
      '**/playwright-report/**',
      '**/test-results/**',
      '**/*.d.ts',
      // Generated Prisma client: `prisma generate` output, never hand-edited.
      'packages/database/generated/**',
      // Frozen Phase 1 artifacts: deliberately not linted (contract §0).
      'prototype/**',
      'qa/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'separate-type-imports' },
      ],
      // Structured logging only. `pino` is the logger (contract §2).
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
  // ── SEC-403: no unsanctioned spawns on the sandbox boundary ─────────────────
  {
    files: SPAWN_BOUNDARY_FILES,
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            { name: 'node:child_process', message: SPAWN_MESSAGE },
            { name: 'child_process', message: SPAWN_MESSAGE },
          ],
        },
      ],
      // A static import is not the only door: `await import(...)` and `require(...)`
      // reach the same module. Close those two as well.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression > Literal[value=/child_process/]',
          message: SPAWN_MESSAGE,
        },
        {
          selector: 'CallExpression > Literal[value=/child_process/]',
          message: SPAWN_MESSAGE,
        },
      ],
    },
  },
  {
    files: SPAWN_OWNERS,
    rules: {
      'no-restricted-imports': 'off',
      'no-restricted-syntax': 'off',
    },
  },
);
