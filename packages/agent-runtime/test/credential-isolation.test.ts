import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  BROKER_RELAY_PORT,
  BROKER_RELAY_SOCKET,
  RUNTIME_RLIMITS,
  buildRuntimeSandbox,
} from '../src';
import { buildSandboxCommand } from '@intelligenz/workspace-manager';

/**
 * Credential isolation, measured from **inside the production sandbox layout**.
 *
 * The layout comes from `buildRuntimeSandbox` — the same function `execute()` uses to
 * build its `bwrap` argv. That matters: a test that re-typed the mount list would pass
 * while the adapter mounted the operator's `$HOME`, which is precisely how the Phase 3
 * exposure survived its own regression test.
 *
 * What is asserted here, in the directive's terms:
 *
 * 1. `~/.local/share/opencode` is not present; `opencode.db` is unreadable/absent.
 * 2. Host credential paths are unreadable or absent, including `/proc/*\/environ`.
 * 3. The sandbox environment contains no key matching `/KEY|TOKEN|SECRET|PASSWORD/i`.
 * 7. Direct provider egress is still blocked.
 */

interface Probe {
  readonly envNames: string[];
  readonly secretLikeNames: string[];
  readonly highEntropyValues: string[];
  readonly paths: Record<string, boolean>;
  readonly pidCount: number;
  readonly procEnvironReadable: number;
  readonly procEnvironWithSecretMarker: number;
  readonly pid1LooksLikeHostInit: boolean;
  readonly directTcp: string;
  readonly dns: string;
  readonly proxyVariables: string[];
  readonly rlimits: { nofile: string; nproc: string; asBytes: string };
}

function runProbe(
  file: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      file,
      [...args],
      { timeout: 60_000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', env },
      (error, out, err) => {
        if (error !== null && out.trim().length === 0) {
          reject(new Error(`sandbox probe failed: ${error.message} ${err.slice(0, 600)}`));
          return;
        }

        resolvePromise(out);
      },
    );
  });
}

const PROBE_SOURCE = `import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import net from 'node:net';

const env = Object.entries(process.env);
const secretLikeNames = env.map(([k]) => k).filter((n) => /KEY|TOKEN|SECRET|PASSWORD/i.test(n));
const highEntropyValues = env
  .filter(([, v]) => typeof v === 'string' && v.length >= 20 && /^[A-Za-z0-9+/=_-]+$/.test(v) && /[0-9]/.test(v) && /[A-Za-z]/.test(v))
  .map(([k]) => k);
const proxyVariables = env.map(([k]) => k).filter((n) => /PROXY/i.test(n));

const paths = [
  '/tmp/home/.local/share/opencode',
  '/tmp/home/.local/share/opencode/opencode.db',
  '/tmp/home/.local/state/opencode',
  '/tmp/home/.cache/opencode',
  '/tmp/home/.config/opencode',
  '/tmp/home/.config/opencode/auth.json',
  '/tmp/home/.ssh/id_rsa',
  '/home/ubuntu/.local/share/opencode/opencode.db',
  '/home/ubuntu/.config/opencode/opencode.jsonc',
  '/xdg-data/opencode',
];
const readable = {};
for (const p of paths) {
  try {
    statSync(p);
    readable[p] = true;
  } catch {
    readable[p] = false;
  }
}

let pidCount = 0;
let procEnvironReadable = 0;
let procEnvironWithSecretMarker = 0;
for (const entry of readdirSync('/proc')) {
  if (!/^\\d+$/.test(entry)) continue;
  pidCount += 1;
  try {
    const text = readFileSync('/proc/' + entry + '/environ', 'utf8');
    procEnvironReadable += 1;
    if (/OPENAI_API_KEY|ANTHROPIC_API_KEY|VELONA_API_KEY|GEMINI_API_KEY|DATABASE_URL|JWT_SECRET|GITHUB_TOKEN/.test(text)) {
      procEnvironWithSecretMarker += 1;
    }
  } catch {}
}

let pid1 = '';
try {
  pid1 = readFileSync('/proc/1/comm', 'utf8').trim();
} catch {}
const pid1LooksLikeHostInit = /^(systemd|init|tmux|sshd|bash|zsh)$/.test(pid1);

const directTcp = await new Promise((res) => {
  const socket = net.connect(443, '1.1.1.1');
  const timer = setTimeout(() => { socket.destroy(); res('timeout'); }, 4000);
  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); res('REACHABLE'); });
  socket.on('error', (error) => { clearTimeout(timer); res('blocked:' + error.code); });
});

const dns = await new Promise((res) => {
  import('node:dns').then((dns) =>
    dns.lookup('api.commandcode.ai', (error, address) => res(error ? 'blocked:' + error.code : 'resolved:' + address)),
  );
});

process.stdout.write(
  JSON.stringify({
    envNames: env.map(([k]) => k).sort(),
    secretLikeNames,
    highEntropyValues,
    paths: readable,
    pidCount,
    procEnvironReadable,
    procEnvironWithSecretMarker,
    pid1LooksLikeHostInit,
    directTcp,
    dns,
    proxyVariables,
    rlimits: {
      nofile: process.env.AGENT_RLIMIT_NOFILE ?? '',
      nproc: process.env.AGENT_RLIMIT_NPROC ?? '',
      asBytes: process.env.AGENT_RLIMIT_AS ?? '',
    },
  }),
);
`;

describe('the production sandbox holds no credential', () => {
  let directory: string;
  let probe: Probe;
  let dirtyProbe: { pid1SeesSecret: boolean; pid1EnvNames: string[] };
  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), 'intelligenz-isolation-'));
    const configDir = join(directory, 'config');
    const brokerDir = join(directory, 'broker');
    const entryDir = join(directory, 'entry');
    const probeDir = join(directory, 'probe');
    const workspace = join(directory, 'workspace');

    for (const path of [configDir, brokerDir, entryDir, probeDir]) {
      await mkdir(path, { recursive: true });
    }
    await mkdir(join(workspace, 'repo'), { recursive: true });

    // A synthetic host credential store at the sandbox's HOME, so "absent" is a
    // measurement rather than a consequence of the file not existing.
    await mkdir(join(directory, 'home', '.local', 'share', 'opencode'), { recursive: true });
    await writeFile(
      join(directory, 'home', '.local', 'share', 'opencode', 'opencode.db'),
      'SQLite format 3\0credential\n',
    );

    await writeFile(join(probeDir, 'probe.mjs'), PROBE_SOURCE, { mode: 0o500 });
    await writeFile(join(configDir, 'opencode.json'), '{"model":"izbroker/test"}\n');

    const nodeRoot = dirname(dirname(resolve(process.execPath)));
    const sandbox = buildRuntimeSandbox({
      nodeBinDir: join(nodeRoot, 'bin'),
      nodeRoot,
      configDir,
      brokerDir,
      entryDir,
      capability: 'iz-canary-isolation-probe-0123456789',
    });

    const command = buildSandboxCommand(
      { rootPath: workspace },
      [join(nodeRoot, 'bin', 'node'), '/probe/probe.mjs'],
      {
        env: sandbox.env,
        mounts: [...sandbox.mounts, { hostPath: probeDir, containerPath: '/probe', mode: 'ro' }],
        extraArgs: sandbox.extraArgs,
      },
    );

    // The **production spawner** gives `bwrap` a minimal environment
    // (`process-group.ts`: `{ PATH, LANG }`), not the worker's. That matters because
    // `--clearenv` applies to the exec'd command, not to bwrap's own child — which is
    // pid 1 in the sandbox's pid namespace. A probe that spawned bwrap with the test
    // runner's environment would read vitest's env at `/proc/1/environ` and call it a
    // sandbox leak. The negative control below proves this test can detect that case.
    const bwrapEnv = { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' };

    const stdout = await runProbe(command.file, [...command.args], bwrapEnv);

    probe = JSON.parse(stdout.trim()) as Probe;

    // Positive control: the same sandbox, spawned with a dirty parent environment.
    const control = buildSandboxCommand(
      { rootPath: workspace },
      [
        join(nodeRoot, 'bin', 'node'),
        '-e',
        `const { readFileSync } = require('node:fs');
         const text = readFileSync('/proc/1/environ', 'utf8');
         const names = text.split('\\0').filter(Boolean).map((kv) => kv.split('=')[0]);
         process.stdout.write(JSON.stringify({ pid1SeesSecret: text.includes('postgres://control-secret'), pid1EnvNames: names }));`,
      ],
      {
        env: sandbox.env,
        mounts: sandbox.mounts,
        extraArgs: sandbox.extraArgs,
      },
    );

    const dirty = await runProbe(control.file, [...control.args], {
      ...bwrapEnv,
      DATABASE_URL: 'postgres://control-secret@db.internal/app',
    });

    dirtyProbe = JSON.parse(dirty.trim()) as typeof dirtyProbe;
  }, 120_000);

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('has no opencode data directory at all', () => {
    expect(probe.paths['/tmp/home/.local/share/opencode']).toBe(false);
    expect(probe.paths['/tmp/home/.local/share/opencode/opencode.db']).toBe(false);
    expect(probe.paths['/tmp/home/.local/state/opencode']).toBe(false);
    expect(probe.paths['/tmp/home/.cache/opencode']).toBe(false);
    expect(probe.paths['/home/ubuntu/.local/share/opencode/opencode.db']).toBe(false);
  });

  it('has no provider config directory', () => {
    expect(probe.paths['/tmp/home/.config/opencode']).toBe(false);
    expect(probe.paths['/tmp/home/.config/opencode/auth.json']).toBe(false);
    expect(probe.paths['/home/ubuntu/.config/opencode/opencode.jsonc']).toBe(false);
    expect(probe.paths['/tmp/home/.ssh/id_rsa']).toBe(false);
  });

  it('has an empty, writable state tree of its own', () => {
    expect(probe.paths['/xdg-data/opencode']).toBe(true);
  });

  it('has no environment key that looks like a credential', () => {
    expect(probe.secretLikeNames).toEqual([]);
  });

  it('carries only one high-entropy value: the per-attempt canary', () => {
    // `IZ_BROKER_CAPABILITY` is random per attempt and is not a credential. Anything
    // else with this shape in the sandbox environment would be an unaccounted secret.
    expect(probe.highEntropyValues).toEqual(['IZ_BROKER_CAPABILITY']);
    expect(probe.envNames).toContain('IZ_BROKER_SOCKET');
    expect(probe.envNames).toContain('IZ_BROKER_PORT');
    expect(probe.envNames).not.toContain('AGENT_PROXY_SOCKET');
  });

  it('sets no proxy variable, so there is no second egress path', () => {
    expect(probe.proxyVariables).toEqual([]);
  });

  it('cannot read another process\'s environment, and cannot see host processes', () => {
    // Only the sandbox's own pids exist (pid namespace), so every readable
    // `/proc/*/environ` belongs to this run and none carries a provider key.
    expect(probe.pidCount).toBeLessThan(10);
    expect(probe.pid1LooksLikeHostInit).toBe(false);
    expect(probe.procEnvironWithSecretMarker).toBe(0);
  });

  it('shows the probe is capable of detecting a leak (positive control)', () => {
    // Spawned with a dirty parent environment, bwrap's pid-1 child carries it, and the
    // probe sees it. That is the failure mode the production spawner avoids by passing
    // only `{ PATH, LANG }`; without this control the assertion above could pass because
    // `/proc/1/environ` was unreadable for an unrelated reason.
    expect(dirtyProbe.pid1SeesSecret).toBe(true);
    expect(dirtyProbe.pid1EnvNames).toContain('DATABASE_URL');
  });

  it('has no direct provider egress and no DNS', () => {
    expect(probe.directTcp).not.toBe('REACHABLE');
    expect(probe.dns.startsWith('blocked:')).toBe(true);
  });

  it('carries the resource ceilings the entry shim applies', () => {
    expect(probe.rlimits).toEqual(RUNTIME_RLIMITS);
  });

  it('describes the socket the relay must reach, and only that', () => {
    expect(BROKER_RELAY_SOCKET).toBe('/run/agent-broker/broker.sock');
    expect(BROKER_RELAY_PORT).toBe(8899);
  });
});
