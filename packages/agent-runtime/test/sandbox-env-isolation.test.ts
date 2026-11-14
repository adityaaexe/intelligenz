import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSandboxCommand, execSandboxed, resolveBwrap } from '@intelligenz/workspace-manager';

import { TranscriptBuffer, collectWorkspaceEvidence } from '../src/runtimes/opencode-cli';

/**
 * **Audit F1**: the sandbox must not inherit the worker's environment.
 *
 * ## The chain being tested
 *
 * 1. The workspace is agent-writable, so the agent writes `.git/config` with a
 *    `filter.<name>.clean` command and a matching `.gitattributes`.
 * 2. The worker collects evidence with `git status` / `git diff` **inside** the sandbox.
 * 3. git executes the filter. The filter reads `/proc/1/environ` and prints it.
 * 4. That output becomes the "cleaned" content git reports, so it lands in `diff.patch` —
 *    an artifact any organisation member can download; only the transcript is
 *    ADMIN-gated.
 *
 * `--clearenv` does not stop this: it applies to the command bwrap execs, not to bwrap's
 * own child, which is pid 1 in the sandbox's pid namespace. What stops it is spawning
 * bwrap with an allowlist (`SandboxCommand.env`), which `buildSandboxCommand` now derives
 * and `execSandboxed` is the only sanctioned way to use.
 *
 * ## Why there is a negative control
 *
 * A test that only asserts "no canary" passes on a host where the filter never ran, where
 * `/proc/1/environ` was unreadable for an unrelated reason, or where `bwrap` was missing
 * and evidence was `null`. The control spawns the **old call shape** — `execFile(file,
 * args)` with no `env`, which is exactly what the two production sites did before this
 * fix — and requires the canary to appear. The control is the proof that the assertion
 * is sensitive, not merely true.
 *
 * Two canaries, on purpose:
 *
 *   - `IZ_CANARY_SECRET` is the name in the audit report, and it matches `redact`'s
 *     credential denylist. It proves the **artifact** leak, because `diff.patch` is not
 *     redacted.
 *   - `IZ_WORKER_MARKER` matches nothing in `redact`, so a transcript assertion about it
 *     cannot be satisfied by the redactor. A pass there is a statement about the
 *     environment, which is what this test is about.
 */

const CANARY = 'iz-canary-7f3c9a1e-do-not-leak';
const MARKER = 'iz-worker-marker-5b8e2d4a-do-not-leak';

/** The filter: it ignores stdin and emits the process-1 environment instead. */
const FILTER_COMMAND = `sh -c 'tr "\\\\0" "\\\\n" < /proc/1/environ; cat'`;

let bwrapAvailable = true;
let skipReason = '';

try {
  resolveBwrap();
} catch (error) {
  bwrapAvailable = false;
  skipReason = error instanceof Error ? error.message : String(error);
}

describe.skipIf(!bwrapAvailable)('sandbox environment isolation (audit F1)', () => {
  let root: string;
  let workspaceRoot: string;
  let repo: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'intelligenz-f1-'));
    workspaceRoot = join(root, 'workspace');
    repo = join(workspaceRoot, 'repo');

    await mkdir(repo, { recursive: true });

    await git(repo, ['init', '-q', '.']);
    await git(repo, ['config', 'user.email', 'f1@example.test']);
    await git(repo, ['config', 'user.name', 'f1']);
    await writeFile(join(repo, 'sum.js'), 'export const sum = (a, b) => a - b;\n');
    await git(repo, ['add', 'sum.js']);
    await git(repo, ['commit', '-qm', 'initial']);

    // What the agent writes. Both files are inside the checkout, so both are inside the
    // one writable bind, and neither is a "config override" the worker passes on argv.
    await writeFile(join(repo, '.gitattributes'), '* filter=canary\n');
    await git(repo, ['config', 'filter.canary.clean', FILTER_COMMAND]);

    // Dirty the file so `git status` and `git diff` both consult the filter.
    await writeFile(join(repo, 'sum.js'), 'export const sum = (a, b) => a + b;\n');

    process.env['IZ_CANARY_SECRET'] = CANARY;
    process.env['IZ_WORKER_MARKER'] = MARKER;
  }, 60_000);

  afterAll(async () => {
    delete process.env['IZ_CANARY_SECRET'];
    delete process.env['IZ_WORKER_MARKER'];
    await rm(root, { recursive: true, force: true });
  });

  it('proves the fixture can leak: the old call shape puts the canary in the diff', async () => {
    const command = buildSandboxCommand({ rootPath: workspaceRoot }, ['git', 'diff'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    // The pre-fix production shape: `execFile(file, args, { timeout, maxBuffer })` and no
    // `env`, so bwrap inherits `process.env`. This is the finding, reproduced.
    const stdout = await legacySpawn(command.file, [...command.args]);

    expect(stdout).toContain(CANARY);
    expect(stdout).toContain(MARKER);
  }, 60_000);

  it('collects evidence through the production path with no canary in the patch', async () => {
    const evidence = await collectWorkspaceEvidence({ workspaceRoot });

    expect(evidence).not.toBeNull();

    // `diff.patch` is `status` + `diff` with headers; assert on all three so a future
    // refactor cannot move the leak into a field the test stopped looking at.
    expect(evidence?.status).not.toContain(CANARY);
    expect(evidence?.diff).not.toContain(CANARY);
    expect(evidence?.patch).not.toContain(CANARY);

    // And the redaction-invisible marker, which no denylist would have removed.
    expect(evidence?.patch).not.toContain(MARKER);

    // The filter still runs — the sandbox cannot stop a repo-defined filter, which is a
    // documented residual. What it sees is the allowlist.
    expect(evidence?.diff).toContain('PATH=/usr/local/bin:/usr/bin:/bin');
  }, 60_000);

  it('shows pid 1 inside the sandbox carries the allowlist and nothing else', async () => {
    const command = buildSandboxCommand(
      { rootPath: workspaceRoot },
      ['/bin/sh', '-c', 'tr "\\0" "\\n" < /proc/1/environ'],
      // The same call shape the production spawner uses: the builder's own env.
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin' } },
    );

    const { stdout } = await execSandboxed(command, { timeoutMs: 30_000, maxBuffer: 1024 * 1024 });

    const names = stdout
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => line.split('=')[0])
      .sort();

    expect(stdout).not.toContain(CANARY);
    expect(stdout).not.toContain(MARKER);
    expect(names).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
  }, 60_000);

  it('produces no transcript line carrying the worker environment', async () => {
    // The transcript is the run's stdout, captured by `TranscriptBuffer`. An agent that
    // prints its own `/proc/1/environ` is the transcript version of the same attack; the
    // marker is chosen so `redact` cannot be what saves us.
    const command = buildSandboxCommand(
      { rootPath: workspaceRoot },
      ['/bin/sh', '-c', 'tr "\\0" "\\n" < /proc/1/environ'],
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin' } },
    );

    const { stdout } = await execSandboxed(command, { timeoutMs: 30_000, maxBuffer: 1024 * 1024 });

    const transcript = new TranscriptBuffer();
    transcript.push(Buffer.from(stdout, 'utf8'));

    const rendered = transcript.finish();

    expect(rendered.length).toBeGreaterThan(0);
    expect(rendered).not.toContain(CANARY);
    expect(rendered).not.toContain(MARKER);
  }, 60_000);

  it('keeps the legacy shape leaking even for the marker, so the control above is real', async () => {
    // Belt and braces on the control: the marker is the value `redact` ignores, and the
    // old shape exposes it too. If this ever stops failing to protect, the leak has moved
    // and both the negative control and this assertion need updating together.
    const command = buildSandboxCommand(
      { rootPath: workspaceRoot },
      ['/bin/sh', '-c', 'tr "\\0" "\\n" < /proc/1/environ'],
      { env: { PATH: '/usr/local/bin:/usr/bin:/bin' } },
    );

    const stdout = await legacySpawn(command.file, [...command.args]);

    expect(stdout).toContain(MARKER);
  }, 60_000);
});

if (!bwrapAvailable) {
  console.warn(`[sandbox-env-isolation] suite skipped — ${skipReason}`);
}

/**
 * The pre-fix spawn: no `env`, so the child inherits the test process's environment.
 *
 * Kept in the test as the negative control, and named for what it is rather than
 * inlined, so the diff that removed it from production is visible in the suite.
 */
function legacySpawn(file: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`${error.message}: ${stderr.slice(0, 600)}`));
          return;
        }

        resolvePromise(stdout);
      },
    );
  });
}

function git(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      'git',
      [...args],
      { cwd, timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error !== null) {
          reject(new Error(`git ${args.join(' ')}: ${stderr.slice(0, 400)}`));
          return;
        }

        resolvePromise(stdout);
      },
    );
  });
}
