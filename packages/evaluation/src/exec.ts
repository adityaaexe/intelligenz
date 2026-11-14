/**
 * Process, hash and filesystem primitives.
 *
 * Everything here is deterministic on purpose: fixtures are committed as plain files
 * and materialised into a git repository with a fixed identity and fixed dates, so the
 * same fixture content always produces the same base commit and two runs of the same
 * benchmark are comparable byte for byte.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

export interface ProcessOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  /** Set when the binary could not be spawned at all (ENOENT and friends). */
  readonly spawnError: string | null;
}

export interface ProcessOptions {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly timeoutMs: number;
  readonly maxBuffer?: number;
}

/** Run a command, never throw on a non-zero exit, and report a timeout distinctly. */
export function runProcess(
  file: string,
  argv: readonly string[],
  options: ProcessOptions,
): Promise<ProcessOutcome> {
  return new Promise((resolvePromise) => {
    const child = execFile(
      file,
      [...argv],
      {
        cwd: options.cwd,
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolvePromise({ code: 0, stdout, stderr, timedOut: false, spawnError: null });
          return;
        }

        const candidate = error as { code?: unknown; killed?: unknown; signal?: unknown };
        const timedOut = candidate.killed === true && typeof candidate.signal === 'string';
        const spawnError = typeof candidate.code === 'string' ? candidate.code : null;
        const code =
          typeof candidate.code === 'number' ? candidate.code : spawnError === 'ENOENT' ? 127 : 1;

        resolvePromise({ code, stdout, stderr, timedOut, spawnError });
      },
    );

    child.on('error', () => {
      // `execFile`'s callback already receives the error; this listener only stops an
      // unhandled 'error' event from taking the process down.
    });
  });
}

/**
 * A scrubbed environment for judge commands.
 *
 * `HOME` points into the workspace and the git identity is pinned, so a judge that
 * happens to run `git` cannot read the host's config or write with the operator's
 * identity. `PATH` starts with the directory of the running `node`, because a fixture
 * has no `node_modules/.bin` and the host `node` may live under a version manager.
 */
export function judgeEnvironment(workspace: string): NodeJS.ProcessEnv {
  const nodeDir = dirname(process.execPath);

  return {
    PATH: [nodeDir, '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: workspace,
    TMPDIR: '/tmp',
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
    CI: '1',
    // Never prompt, never touch a system-wide config, never rewrite line endings.
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_AUTHOR_NAME: 'INTELLIGENZ Benchmark',
    GIT_AUTHOR_EMAIL: 'benchmark@intelligenz.invalid',
    GIT_COMMITTER_NAME: 'INTELLIGENZ Benchmark',
    GIT_COMMITTER_EMAIL: 'benchmark@intelligenz.invalid',
  };
}

/**
 * Resolve `argv[0]`. `node` becomes the absolute path of the interpreter running the
 * harness, so a judge cannot be defeated by a stale `node` earlier in `PATH`.
 */
export function resolveArgv(argv: readonly string[]): readonly string[] {
  const head = argv[0];
  if (head === undefined) return argv;
  if (head === 'node') return [process.execPath, ...argv.slice(1)];
  return argv;
}

export async function git(
  args: readonly string[],
  cwd: string,
  timeoutMs = 30_000,
): Promise<string> {
  const outcome = await runProcess('git', args, {
    cwd,
    env: judgeEnvironment(cwd),
    timeoutMs,
  });

  if (outcome.code !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed (exit ${String(outcome.code)}): ${outcome.stderr.trim().slice(0, 400)}`,
    );
  }

  return outcome.stdout.trim();
}

export function sha256Bytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function sha256File(path: string): Promise<string | null> {
  try {
    return sha256Bytes(await readFile(path));
  } catch {
    return null;
  }
}

/** `path` is dropped when `skip` says so. Used to keep `BENCHMARK.json` and `.git` out. */
export type CopyFilter = (sourcePath: string, relativePath: string) => boolean;

export async function copyTree(
  source: string,
  destination: string,
  filter: CopyFilter,
): Promise<string[]> {
  const copied: string[] = [];

  const walk = async (from: string, to: string): Promise<void> => {
    const entries = await readdir(from, { withFileTypes: true });

    for (const entry of entries) {
      const fromPath = join(from, entry.name);
      const toPath = join(to, entry.name);
      const relativePath = relative(source, fromPath).split(sep).join('/');

      if (!filter(fromPath, relativePath)) {
        if (entry.isDirectory()) continue;
        // A file that the filter rejects can never be part of the fixture.
        continue;
      }

      if (entry.isDirectory()) {
        await mkdir(toPath, { recursive: true });
        await walk(fromPath, toPath);
        continue;
      }

      if (entry.isFile()) {
        await copyFile(fromPath, toPath);
        copied.push(relativePath);
      }
    }
  };

  await mkdir(destination, { recursive: true });
  await walk(source, destination);

  return copied.sort();
}

export interface FileEntry {
  readonly path: string;
  readonly absolute: string;
  readonly bytes: number;
}

/**
 * Every regular file under `root`, relative and POSIX-separated.
 *
 * Bounded: a runaway agent can create a hundred thousand files, and a judge is not the
 * place to discover that. The cap is reported rather than silently applied.
 */
export async function listFiles(
  root: string,
  options: { readonly skipDotGit?: boolean; readonly limit?: number } = {},
): Promise<{ files: readonly FileEntry[]; truncated: boolean }> {
  const limit = options.limit ?? 5_000;
  const files: FileEntry[] = [];
  let truncated = false;

  const walk = async (directory: string): Promise<void> => {
    if (truncated) return;

    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      if (files.length >= limit) {
        truncated = true;
        return;
      }

      const absolute = join(directory, entry.name);

      if (entry.isDirectory()) {
        if (options.skipDotGit === true && entry.name === '.git') continue;
        if (entry.name === 'node_modules') continue;
        await walk(absolute);
        continue;
      }

      if (!entry.isFile()) continue;

      const stats = await stat(absolute);
      files.push({
        path: relative(root, absolute).split(sep).join('/'),
        absolute,
        bytes: stats.size,
      });
    }
  };

  await walk(root);
  files.sort((left, right) => left.path.localeCompare(right.path));

  return { files, truncated };
}

export async function readTextIfSmall(path: string, maxBytes: number): Promise<string | null> {
  try {
    const stats = await stat(path);
    if (stats.size > maxBytes) return null;
    const bytes = await readFile(path);
    // Binary content is not scannable and not a secret leak this harness can judge.
    if (bytes.includes(0)) return null;
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}

export async function ensureDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
}

export async function writeText(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}
