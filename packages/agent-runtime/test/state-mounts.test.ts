import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSandboxCommand } from '@intelligenz/workspace-manager';

import { buildEphemeralStatePlan } from '../src/sandbox/state-mounts';
import { BROKER_RELAY_PORT, BROKER_RELAY_SOCKET } from '../src';

/**
 * F2 regression, Phase 4 form: **the sandbox sees no host state at all.**
 *
 * Phase 3 narrowed `$HOME` to four opencode paths and masked what it could. The
 * credential database could not be masked, because opencode read its key from it, so
 * the audit's evidence was:
 *
 * ```
 * /xdg-data/opencode:
 *   opencode.db   1,068,654,592 bytes   <- the provider credential + 696 sessions
 * ```
 *
 * Phase 4 does not narrow the mount; it removes the requirement. Authentication is
 * terminated by the host broker, so nothing under `$HOME` is mounted and the state tree
 * is created empty inside the sandbox.
 *
 * This test builds a synthetic `$HOME` containing one of each thing the audit found,
 * derives the plan from the production function, and then **reads from inside a real
 * sandbox**. It asserts absence, not masking — a masked file is still a file with a
 * known name on a known path.
 */

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe('the sandbox sees no host state', () => {
  let home: string;
  let workspace: string;
  let data: string;

  const run = async (argv: readonly string[]): Promise<RunResult> => {
    const plan = buildEphemeralStatePlan();
    const command = buildSandboxCommand({ rootPath: workspace }, argv, {
      mounts: plan.mounts,
      extraArgs: plan.dirs.flatMap((dir) => ['--dir', dir]),
      env: {
        PATH: '/usr/local/bin:/usr/bin:/bin',
        IZ_BROKER_SOCKET: BROKER_RELAY_SOCKET,
        IZ_BROKER_PORT: String(BROKER_RELAY_PORT),
      },
    });

    return new Promise((resolvePromise) => {
      execFile(
        command.file,
        [...command.args],
        { timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const code =
            error === null
              ? 0
              : typeof (error as { code?: unknown }).code === 'number'
                ? ((error as { code?: number }).code ?? 1)
                : 1;

          resolvePromise({ code, stdout, stderr });
        },
      );
    });
  };

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'intelligenz-home-'));
    workspace = await mkdtemp(join(tmpdir(), 'intelligenz-mount-ws-'));
    await mkdir(join(workspace, 'repo'), { recursive: true });

    // What the audit found, in miniature.
    data = join(home, '.local', 'share', 'opencode');
    await mkdir(join(data, 'shell'), { recursive: true });
    await mkdir(join(home, '.local', 'share', 'other-app'), { recursive: true });
    await mkdir(join(home, '.local', 'state', 'opencode'), { recursive: true });
    await mkdir(join(home, '.cache', 'opencode'), { recursive: true });
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await mkdir(join(home, '.agentmemory'), { recursive: true });
    await mkdir(join(home, '.ssh'), { recursive: true });

    await writeFile(join(data, 'opencode.db'), 'SQLite format 3\0credential-inside\n');
    await writeFile(join(data, 'mcp-auth.json'), '{"token":"mcp-secret"}\n');
    await writeFile(join(data, 'shell', 'history.txt'), 'operator shell output\n');
    await writeFile(join(home, '.local', 'share', 'other-app', 'credentials.json'), 'other-secret\n');
    await writeFile(join(home, '.local', 'state', 'opencode', 'service.json'), '{"pid":1}\n');
    await writeFile(join(home, '.cache', 'opencode', 'models.json'), '{"models":[]}\n');
    await writeFile(join(home, '.config', 'opencode', 'auth.json'), 'legacy-auth\n');
    await writeFile(join(home, '.config', 'opencode', 'cli.json'), 'cli-secret\n');
    await writeFile(join(home, '.agentmemory', 'secret'), 'agentmemory-secret\n');
    await writeFile(join(home, '.ssh', 'id_rsa'), 'private-key\n');
  }, 60_000);

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it('mounts nothing from the host', () => {
    const plan = buildEphemeralStatePlan();

    expect(plan.mounts).toEqual([]);
    expect(plan.masks).toEqual([]);
    expect(plan.dirs).toContain('/xdg-data/opencode');
  });

  it('has no opencode data directory: the credential database is absent, not masked', async () => {
    // Relative to the sandbox HOME, which is an empty tmpfs (`/tmp/home`).
    const relative = await run(['/bin/ls', '-A', '/tmp/home/.local/share/opencode']);
    expect(relative.code).not.toBe(0);

    const absolute = await run(['/bin/cat', join(data, 'opencode.db')]);
    expect(absolute.code).not.toBe(0);
    expect(absolute.stdout).not.toContain('SQLite');
  });

  it('has an empty, writable state tree of its own', async () => {
    const listed = await run(['/bin/ls', '-A', '/xdg-data/opencode']);
    expect(listed.code).toBe(0);
    expect(listed.stdout.trim()).toBe('');

    // Writable: the run's own session database has to live somewhere disposable.
    const written = await run([
      '/bin/sh',
      '-c',
      'printf "session" > /xdg-data/opencode/opencode.db && cat /xdg-data/opencode/opencode.db',
    ]);
    expect(written.code).toBe(0);
    expect(written.stdout).toBe('session');
  });

  it('cannot read any host credential path', async () => {
    const probes: readonly (readonly [string, string])[] = [
      ['operator credential database', join(data, 'opencode.db')],
      ['mcp auth', join(data, 'mcp-auth.json')],
      ['previous shell output', join(data, 'shell', 'history.txt')],
      ['sibling app', join(home, '.local', 'share', 'other-app', 'credentials.json')],
      ['legacy auth.json', join(home, '.config', 'opencode', 'auth.json')],
      ['global config cli.json', join(home, '.config', 'opencode', 'cli.json')],
      ['agentmemory secret', join(home, '.agentmemory', 'secret')],
      ['ssh key', join(home, '.ssh', 'id_rsa')],
    ];

    for (const [label, path] of probes) {
      const result = await run(['/bin/cat', path]);

      expect(result.code, `${label} should not be readable`).not.toBe(0);
    }
  });
});
