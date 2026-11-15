import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * Fixture git repositories, built by the **test**, never by the code under test.
 *
 * The snapshot walker must not invoke git — that is what makes it authority. Building an
 * adversarial repository, however, is exactly what `git init`, an index and a config file
 * are for, and there is no other way to produce a real one. So the fixture builder spawns
 * git here, in a file that is not named `*.test.ts` and is imported only by tests.
 *
 * Two rules, both load-bearing for the hostile fixture:
 *
 * 1. **Every invocation gets a scrubbed environment.** `GIT_CONFIG_GLOBAL` and
 *    `GIT_CONFIG_SYSTEM` point at `/dev/null`, and `GIT_CONFIG_NOSYSTEM=1`, so a host
 *    configuration cannot change what the fixture looks like. Tests that pass with the
 *    operator's git setup and fail in CI are not tests.
 * 2. **`hooksPath` is neutralised while the fixture is being built.** The hostile fixture
 *    installs a `pre-commit` hook that writes a marker; a later `git add` must not run it,
 *    or the marker would exist for a reason that has nothing to do with the snapshot.
 */
const GIT_ENV: Readonly<Record<string, string>> = {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.test',
  GIT_COMMITTER_NAME: 'Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.test',
  GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z',
  GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z',
};

/** Run git in `cwd` with a deterministic environment. Throws with git's stderr attached. */
export async function git(cwd: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', [...args], {
      cwd,
      env: GIT_ENV,
      maxBuffer: 8 * 1024 * 1024,
    });

    return stdout;
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? '';
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${stderr}`);
  }
}

/**
 * An initialised repository with one commit and no hooks that can fire.
 *
 * `core.hooksPath=/dev/null` is set on the command line, not in the config, so the fixture
 * does not carry a "safe" setting that a later test might mistake for the hostile one.
 */
export async function initRepo(root: string, files: Readonly<Record<string, string>>): Promise<void> {
  await mkdir(root, { recursive: true });
  await git(root, ['-c', 'core.hooksPath=/dev/null', 'init', '--quiet', '--initial-branch=main']);

  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }

  await git(root, ['-c', 'core.hooksPath=/dev/null', 'add', '-A']);
  await git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'base']);
}

/** Commit whatever is staged, without letting a hook run. */
export async function commit(root: string, message: string): Promise<void> {
  await git(root, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', message]);
}

/** `git add -A` without letting a hook or a filter run through the index path. */
export async function addAll(root: string): Promise<void> {
  await git(root, ['-c', 'core.hooksPath=/dev/null', 'add', '-A']);
}
