import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSandboxCommand, type SandboxMount } from '@intelligenz/workspace-manager';

import { buildOpencodeStateMounts } from '../src/sandbox/state-mounts';

/**
 * F2 regression: **platform credentials are not readable in-sandbox.**
 *
 * The audited adapter mounted `$HOME/.local/share`, `$HOME/.local/state` and
 * `$HOME/.cache` into the sandbox. Measured from inside a run, that exposed six provider
 * credentials, 696 operator sessions, a 1.07 GB database, `mcp-auth.json`, the
 * agentmemory secret and the browser's NSS `key4.db`. The agent's tool output is written
 * to a downloadable transcript, so "readable inside" was also "downloadable outside".
 *
 * This test builds a synthetic `$HOME` that contains one of each of those things,
 * derives the mount plan from the production function, and then **reads from inside a
 * real sandbox**. It asserts both directions: the credential that a run needs is there,
 * and everything else is not.
 */

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

describe('the sandbox sees opencode state and nothing else from $HOME', () => {
  let home: string;
  let workspace: string;
  let mounts: SandboxMount[];
  let dirs: string[];
  let masks: string[];

  const run = async (argv: readonly string[]): Promise<RunResult> => {
    const command = buildSandboxCommand({ rootPath: workspace }, argv, {
      mounts,
      extraArgs: [
        ...masks.flatMap((mask) => ['--tmpfs', mask]),
        ...dirs.flatMap((dir) => ['--dir', dir]),
      ],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    return new Promise((resolvePromise) => {
      execFile(
        command.file,
        [...command.args],
        { timeout: 20_000, maxBuffer: 1024 * 1024, encoding: 'utf8' },
        (error, stdout, stderr) => {
          const code =
            error === null ? 0 : typeof (error as { code?: unknown }).code === 'number'
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
    const data = join(home, '.local', 'share', 'opencode');
    await mkdir(join(data, 'shell'), { recursive: true });
    await mkdir(join(data, 'snapshot'), { recursive: true });
    // The schema lives at the top of the data directory in this synthetic HOME; the
    // adapter applies `--dir`, so nothing here depends on the database being real.
    await mkdir(join(home, '.local', 'share', 'other-app'), { recursive: true });
    await mkdir(join(home, '.local', 'state', 'opencode'), { recursive: true });
    await mkdir(join(home, '.cache', 'opencode'), { recursive: true });
    await mkdir(join(home, '.config', 'opencode'), { recursive: true });
    await mkdir(join(home, '.agentmemory'), { recursive: true });
    await mkdir(join(home, '.ssh'), { recursive: true });

    await writeFile(join(data, 'opencode.db'), 'db-content\n');
    await writeFile(join(data, 'mcp-auth.json'), '{"token":"mcp-secret"}\n');
    await writeFile(join(data, 'shell', 'history.txt'), 'operator shell output\n');
    await writeFile(join(data, 'snapshot', 'snapshot.bin'), 'snapshot\n');

    await writeFile(join(home, '.local', 'share', 'other-app', 'credentials.json'), 'other-secret\n');
    await writeFile(join(home, '.local', 'state', 'opencode', 'service.json'), '{"pid":1}\n');
    await writeFile(join(home, '.cache', 'opencode', 'models.json'), '{"models":[]}\n');
    await writeFile(join(home, '.config', 'opencode', 'auth.json'), 'legacy-auth\n');
    await writeFile(join(home, '.config', 'opencode', 'cli.json'), 'cli-secret\n');
    await writeFile(join(home, '.agentmemory', 'secret'), 'agentmemory-secret\n');
    await writeFile(join(home, '.ssh', 'id_rsa'), 'private-key\n');

    const plan = await buildOpencodeStateMounts({
      dataHome: join(home, '.local', 'share'),
      stateHome: join(home, '.local', 'state'),
      cacheHome: join(home, '.cache'),
      configHome: join(home, '.config'),
    });

    mounts = plan.mounts;
    dirs = plan.dirs;
    masks = plan.masks;
  }, 60_000);

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  it('mounts only opencode paths, never $HOME or a sibling application', async () => {
    const mounted = mounts.map((mount) => `${mount.hostPath}->${mount.containerPath ?? mount.hostPath}`);

    // Every host path is either inside this `$HOME` or `/dev/null` (a mask, which
    // carries no bytes).
    for (const mount of mounts) {
      if (mount.hostPath === '/dev/null') continue;

      expect(mount.hostPath.startsWith(home)).toBe(true);
      expect(mount.hostPath === home).toBe(false);
    }

    expect(mounted.some((entry) => entry.includes('other-app'))).toBe(false);
    expect(mounted.some((entry) => entry.includes('.agentmemory'))).toBe(false);
    expect(mounted.some((entry) => entry.includes('.ssh'))).toBe(false);
    // The config directory itself is never mounted; only the legacy credential file.
    expect(mounted.some((entry) => entry.endsWith(`${join('.config', 'opencode')}->/xdg-config/opencode`))).toBe(false);
  });

  it('can read the credential database a run needs to authenticate', async () => {
    const result = await run(['/bin/cat', '/xdg-data/opencode/opencode.db']);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('db-content\n');
  });

  it('cannot read mcp-auth.json, which a run does not need', async () => {
    const result = await run(['/bin/cat', '/xdg-data/opencode/mcp-auth.json']);

    expect(result.code).not.toBe(0);
    expect(result.stdout).not.toContain('mcp-secret');
  });

  it('cannot see previous sessions\' shell output or snapshots', async () => {
    const shell = await run(['/bin/ls', '-A', '/xdg-data/opencode/shell']);
    const snapshot = await run(['/bin/ls', '-A', '/xdg-data/opencode/snapshot']);

    expect(shell.stdout.trim()).toBe('');
    expect(snapshot.stdout.trim()).toBe('');
  });

  it('cannot reach a sibling application\'s credential store or the agentmemory secret', async () => {
    const other = await run(['/bin/cat', '/xdg-data/other-app/credentials.json']);
    const memory = await run(['/bin/cat', '/xdg-data/agentmemory/secret']);
    const ssh = await run(['/bin/cat', '/xdg-data/.ssh/id_rsa']);

    expect(other.code).not.toBe(0);
    expect(memory.code).not.toBe(0);
    expect(ssh.code).not.toBe(0);
    expect(other.stdout).not.toContain('other-secret');
    expect(memory.stdout).not.toContain('agentmemory-secret');
    expect(ssh.stdout).not.toContain('private-key');
  });

  it('sees only opencode under /xdg-data', async () => {
    const result = await run(['/bin/ls', '-A', '/xdg-data']);

    expect(result.stdout.trim().split('\n')).toEqual(['opencode']);
  });

  it('reads the legacy auth file but not the rest of the global config directory', async () => {
    const auth = await run(['/bin/cat', '/xdg-config/opencode/auth.json']);
    const cli = await run(['/bin/cat', '/xdg-config/opencode/cli.json']);

    expect(auth.stdout).toBe('legacy-auth\n');
    expect(cli.code).not.toBe(0);
    expect(cli.stdout).not.toContain('cli-secret');
  });
});
