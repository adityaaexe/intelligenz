import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildSandboxCommand,
  createWorkspaceManager,
  execSandboxed,
  probeSandbox,
  resolveBwrap,
  type SandboxProbeResult,
  type WorkspaceHandle,
} from '../src';

/**
 * The sandbox tests. These do not assert that a promise resolves — they run commands
 * inside a real namespace and read what happened. `probeSandbox` is the same function
 * the adapter uses to declare its capabilities, so a false claim here would be a
 * false claim in production.
 */

const FIXTURE = resolve(fileURLToPath(new URL('../../../infra/fixtures/sample-repo', import.meta.url)));

describe('sandbox', () => {
  let root: string;
  let handle: WorkspaceHandle;
  let probe: SandboxProbeResult;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'intelligenz-sandbox-'));
    const manager = createWorkspaceManager({ root });
    handle = await manager.provision({
      orgId: 'org-1',
      taskId: 'task-sandbox',
      workspaceId: 'ws-sandbox',
      source: { kind: 'clone', repoPath: FIXTURE },
    });

    // `env` is required at every build: the sandbox's own environment, and the only
    // source for the values bwrap itself inherits.
    probe = await probeSandbox(handle, { env: {} });
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('blocks network egress — measured, not declared', () => {
    expect(probe.networkBlocked).toBe(true);
    expect(probe.evidence.network).toContain('BLOCKED');
  });

  it('mounts the root filesystem read-only: /etc/pwned cannot be created', () => {
    expect(probe.rootReadOnly).toBe(true);
    expect(probe.evidence.rootWrite).toContain('Read-only file system');
  });

  it('leaves the workspace writable', () => {
    expect(probe.canWriteWorkspace).toBe(true);
    expect(probe.evidence.workspaceWrite).toContain('WROTE');
  });

  it('rejects an env var that looks like a credential', () => {
    expect(() =>
      buildSandboxCommand(handle, ['/bin/true'], { env: { SOME_API_KEY: 'sk-live-123' } }),
    ).toThrow(/credential/);

    expect(() =>
      buildSandboxCommand(handle, ['/bin/true'], { env: { GITHUB_TOKEN: 'ghp_x' } }),
    ).toThrow(/credential/);

    expect(() =>
      buildSandboxCommand(handle, ['/bin/true'], { env: { DB_PASSWORD: 'hunter2' } }),
    ).toThrow(/credential/);
  });

  it('fails closed when bwrap is absent', () => {
    expect(() => resolveBwrap('/nonexistent/bwrap')).toThrow(/refusing to execute unsandboxed/);
  });

  it('builds an argv array with no shell and the expected mounts', () => {
    const command = buildSandboxCommand(handle, ['/bin/true'], {
      env: { PATH: '/usr/bin:/bin' },
      readOnlyMounts: [{ hostPath: '/home/ubuntu/.config/opencode', mode: 'ro' }],
    });

    expect(command.file).toMatch(/bwrap$/);
    expect(command.args).not.toContain('shell');
    expect(command.args.join(' ')).not.toMatch(/[;&|]{1,2}\s/);

    const args = command.args;

    // The workspace is the only writable bind.
    const writable = args.reduce<string[]>((acc, arg, index) => {
      if (args[index - 1] === '--bind') acc.push(arg);
      return acc;
    }, []);

    expect(writable).toEqual([join(handle.rootPath, 'repo')]);
    expect(args).toContain('--chdir');
    expect(args[args.indexOf('--chdir') + 1]).toBe('/workspace');
    expect(args).toContain('--unshare-net');
    expect(args).toContain('--clearenv');
    expect(args).toContain('--die-with-parent');
    expect(args).toContain('--new-session');
    expect(args.slice(args.indexOf('--ro-bind'))).toContain('/home/ubuntu/.config/opencode');
    expect(args.slice(-1)).toEqual(['/bin/true']);
  });

  it('gives the bwrap process an allowlisted environment, never the parent\'s', () => {
    process.env['IZ_SPAWN_CANARY'] = 'canary-that-must-not-cross';
    process.env['DATABASE_URL'] = 'postgres://user:pass@host/db';

    try {
      const command = buildSandboxCommand(handle, ['/bin/true'], {
        // The run's own extras belong inside the sandbox, not at pid 1.
        env: { IZ_BROKER_CAPABILITY: 'iz-canary-capability' },
      });

      // `--clearenv` governs the exec'd command; `command.env` is what bwrap itself
      // inherits, and anything there is readable at `/proc/1/environ` from inside.
      expect(Object.keys(command.env).sort()).toEqual(['HOME', 'LANG', 'PATH', 'TMPDIR']);
      expect(JSON.stringify(command.env)).not.toContain('canary-that-must-not-cross');
      expect(JSON.stringify(command.env)).not.toContain('postgres://user:pass@host/db');
      expect(command.env['HOME']).toBe('/tmp/home');

      // The sandbox's own environment still carries it: this is the documented channel.
      expect(command.args).toContain('IZ_BROKER_CAPABILITY');
    } finally {
      delete process.env['IZ_SPAWN_CANARY'];
      delete process.env['DATABASE_URL'];
    }
  });

  /**
   * SEC-403. The lint rule forbids new spawns, but `sandbox.ts` is allowlisted — so this
   * test is what keeps the allowlisted helper honest. Node inherits the parent
   * environment when `env:` is omitted; if someone drops `env: command.env` from
   * `execSandboxed`, the canary crosses and this fails.
   */
  it('execSandboxed passes command.env only — the parent environment never crosses', async () => {
    process.env['IZ_SPAWN_CANARY'] = 'canary-that-must-not-cross';

    try {
      const outcome = await execSandboxed(
        {
          file: '/bin/sh',
          args: ['-c', 'printf "%s|%s" "${IZ_SPAWN_CANARY-unset}" "${LANG:-unset}"'],
          env: { PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
        },
        { timeoutMs: 5_000, maxBuffer: 64 * 1024 },
      );

      // `unset` proves the host variable did not cross; `C.UTF-8` proves the declared
      // value did — the child got `command.env`, not an empty environment.
      expect(outcome.stdout).toBe('unset|C.UTF-8');
    } finally {
      delete process.env['IZ_SPAWN_CANARY'];
    }
  });

  it('drops the network namespace only when a caller says so explicitly', () => {    const host = buildSandboxCommand(handle, ['/bin/true'], { env: {}, network: 'host' });

    expect(host.args).not.toContain('--unshare-net');
    expect(host.args).toContain('--unshare-pid');
  });

  /**
   * `--rlimit-*` is not universal: the bubblewrap shipped here (0.11.1) rejects it, and
   * an unknown option makes every sandbox fail to start. The builder therefore probes
   * and emits only what the binary advertises; the entry wrapper enforces the same
   * ceilings with `prlimit` regardless.
   */
  it('emits rlimit flags when the local bwrap advertises them', () => {
    const command = buildSandboxCommand(handle, ['/bin/true'], {
      env: {},
      rlimits: { nofile: 1024, nproc: 2048, asBytes: 6 * 1024 * 1024 * 1024 },
      bwrapFeatures: { rlimitFlags: true },
    });

    expect(command.args.join(' ')).toContain('--rlimit-nofile 1024');
    expect(command.args.join(' ')).toContain('--rlimit-nproc 2048');
    expect(command.args.join(' ')).toContain('--rlimit-as 6442450944');
  });

  it('omits rlimit flags when the local bwrap does not advertise them', () => {
    const command = buildSandboxCommand(handle, ['/bin/true'], {
      env: {},
      rlimits: { nofile: 1024 },
      bwrapFeatures: { rlimitFlags: false },
    });

    expect(command.args).not.toContain('--rlimit-nofile');
  });

  it('refuses a non-positive rlimit instead of passing it through', () => {
    expect(() =>
      buildSandboxCommand(handle, ['/bin/true'], {
        env: {},
        rlimits: { nofile: 0 },
        bwrapFeatures: { rlimitFlags: true },
      }),
    ).toThrow(/positive integer/);
  });
});
