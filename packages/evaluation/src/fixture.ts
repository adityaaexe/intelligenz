/**
 * Turning a committed fixture directory into a real git repository.
 *
 * Fixtures are committed to the parent repository as **plain files** — never as a
 * nested repository, never as a gitlink. The `.git` directory a run clones from is
 * created here, in a temporary directory, with:
 *
 *   - a fixed author and committer identity,
 *   - a fixed author and committer date,
 *   - one commit whose message names the benchmark and its version.
 *
 * Identical content therefore produces an identical commit hash, which is what lets a
 * result say "fixture commit abc123" and mean it tomorrow. The alternative — checking
 * a `.git` directory into the repository — is how a repo ends up with an embedded
 * repository that `git ls-files` reports as mode 160000.
 */

import { rm, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { copyTree, git, judgeEnvironment, runProcess } from './exec';
import type { Benchmark } from './types';

/** The files never copied into a run: harness metadata and version-control state. */
const NEVER_COPIED = new Set(['BENCHMARK.json', '.git', 'node_modules']);

const FIXED_DATE = '2026-01-01T00:00:00+0000';

export interface SetupStepResult {
  readonly step: string;
  readonly exitCode: number;
  readonly durationMs: number;
}

export interface MaterializedFixture {
  readonly root: string;
  readonly commit: string;
  /** Files copied from the fixture directory (relative, sorted). Empty means broken. */
  readonly files: readonly string[];
  readonly setup: readonly SetupStepResult[];
}

export interface MaterializeOptions {
  readonly fixtureDir: string;
  readonly destination: string;
  readonly benchmark: Benchmark;
  readonly timeoutMs: number;
}

/**
 * Copy the fixture, commit it, then run the benchmark's setup steps.
 *
 * Setup runs *after* the commit so that generated state (a git hook, for example) is
 * not part of the baseline diff. A setup step that exits non-zero aborts the run: a
 * fixture that did not reach its declared starting state measures nothing.
 */
export async function materializeFixture(
  options: MaterializeOptions,
): Promise<MaterializedFixture> {
  const root = options.destination;

  const files = await copyTree(options.fixtureDir, root, (_absolute, relativePath) => {
    const head = relativePath.split('/')[0] ?? '';
    return !NEVER_COPIED.has(head);
  });

  if (files.length === 0) {
    throw new Error(`fixture ${options.fixtureDir} produced no files`);
  }

  const env = { ...judgeEnvironment(root), GIT_AUTHOR_DATE: FIXED_DATE, GIT_COMMITTER_DATE: FIXED_DATE };

  await git(['init', '-q', '-b', 'main'], root);
  await git(['add', '-A'], root);

  const commit = await runProcess(
    'git',
    [
      '-c',
      'user.name=INTELLIGENZ Benchmark',
      '-c',
      'user.email=benchmark@intelligenz.invalid',
      'commit',
      '-q',
      '--no-gpg-sign',
      '-m',
      `benchmark fixture: ${options.benchmark.id}@${options.benchmark.version}`,
    ],
    { cwd: root, env, timeoutMs: 30_000 },
  );

  if (commit.code !== 0) {
    throw new Error(`fixture commit failed: ${commit.stderr.trim().slice(0, 400)}`);
  }

  const sha = await git(['rev-parse', 'HEAD'], root);

  // A fixture whose own `.gitignore` excludes files it ships would produce a clone that
  // silently lacks them, and every judge downstream would measure the wrong repository.
  // That is a broken fixture, not a failing run, so it stops here.
  const tracked = new Set(
    (await git(['ls-files'], root)).split('\n').filter((line) => line.length > 0),
  );
  const untrackedFiles = files.filter((file) => !tracked.has(file));

  if (untrackedFiles.length > 0) {
    throw new Error(
      `fixture ${options.benchmark.id} ships ${String(untrackedFiles.length)} file(s) its own ` +
        `.gitignore excludes: ${untrackedFiles.slice(0, 5).join(', ')}`,
    );
  }

  const setup: SetupStepResult[] = [];

  for (const step of options.benchmark.setup ?? []) {
    const startedAt = Date.now();
    const outcome = await runProcess('/bin/sh', ['-c', step], {
      cwd: root,
      env,
      timeoutMs: Math.min(options.timeoutMs, 60_000),
    });

    setup.push({ step, exitCode: outcome.code, durationMs: Date.now() - startedAt });

    if (outcome.code !== 0) {
      throw new Error(
        `setup step failed (exit ${String(outcome.code)}): ${step}\n${outcome.stderr.trim().slice(0, 400)}`,
      );
    }
  }

  return { root, commit: sha, files, setup };
}

export interface HookControlResult {
  readonly benchmarkId: string;
  readonly kind: 'git-hook';
  readonly fired: boolean;
  readonly markerPaths: readonly string[];
  readonly detail: string;
}

/**
 * The negative control for a malicious-hook fixture.
 *
 * Materialises a throwaway second copy, triggers the hook with a plain host `git
 * checkout`, and requires every marker to appear. If the marker does not appear here,
 * "the marker did not appear during the agent run" proves nothing — the hook was
 * simply broken — so a benchmark whose control fails is reported as an unusable
 * benchmark rather than a passing one.
 */
export async function proveGitHookIsLive(
  options: MaterializeOptions & { readonly markerPaths: readonly string[] },
): Promise<HookControlResult> {
  const benchmarkId = options.benchmark.id;

  for (const marker of options.markerPaths) {
    await rm(marker, { force: true });
  }

  const materialized = await materializeFixture(options);

  try {
    const outcome = await runProcess('git', ['checkout', '-q', '-b', 'hook-control-probe'], {
      cwd: materialized.root,
      env: judgeEnvironment(materialized.root),
      timeoutMs: 30_000,
    });

    if (outcome.code !== 0) {
      return {
        benchmarkId,
        kind: 'git-hook',
        fired: false,
        markerPaths: options.markerPaths,
        detail: `control could not run: git checkout exited ${String(outcome.code)}`,
      };
    }

    const present: string[] = [];
    const missing: string[] = [];

    for (const marker of options.markerPaths) {
      // A relative marker is relative to the checkout, because that is where the hook
      // writes it. Checking it against this process's cwd would report every relative
      // marker as absent and declare a live fixture dead.
      const target = isAbsolute(marker) ? marker : resolve(materialized.root, marker);
      const exists = await stat(target)
        .then(() => true)
        .catch(() => false);
      const label = isAbsolute(marker) ? marker : `${marker} (relative to the checkout)`;
      (exists ? present : missing).push(label);
    }

    return {
      benchmarkId,
      kind: 'git-hook',
      fired: missing.length === 0,
      markerPaths: options.markerPaths,
      detail:
        missing.length === 0
          ? `hook fired: ${present.join(', ')} created by a plain host git checkout`
          : `hook did not fire: ${missing.join(', ')} absent after a host git checkout`,
    };
  } finally {
    await rm(materialized.root, { recursive: true, force: true });
  }
}

