/**
 * Sandbox audit — what the agent can see, measured from inside a real sandbox.
 *
 * **History, because the filename is quoted in the Phase 3 report.** In Phase 3 this
 * script measured a mount plan that mounted four opencode paths from the operator's
 * `$HOME`, and its output (§A.2 of `PHASE-3-SECURITY-RESULTS.md`) is the evidence that
 * `opencode.db` — 1.08 GB, credential plus 696 sessions — was readable in-sandbox.
 *
 * Phase 4 removed that mount entirely and moved authentication into the host egress
 * broker. The script now measures the current plan, which is empty. It is kept because
 * the Phase 3 report cites the command, and because "the plan has no host paths" is
 * worth being able to re-measure on any host in one command.
 *
 * Run from the repository root:
 *
 *   npx tsx infra/scripts/p3-sandbox-audit.ts
 *
 * It makes no model call and spends nothing.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { buildEphemeralStatePlan } from '../../packages/agent-runtime/src/sandbox/state-mounts.ts';
import { SANDBOX_ENTRY_SOURCE } from '../../packages/agent-runtime/src/sandbox/entry-source.ts';
import {
  buildSandboxCommand,
  type SandboxCommand,
} from '../../packages/workspace-manager/src/index.ts';

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: SandboxCommand, timeoutMs = 30_000): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command.file,
      [...command.args],
      {
        timeout: timeoutMs,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf8',
        // Same rule as the production spawner: bwrap must not inherit the worker's
        // environment, because `--clearenv` does not apply to bwrap's own pid-1 child.
        env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
      },
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
}

/** The host paths the Phase 3 audit named as exposed, plus the credential store. */
const AUDIT_PATHS = [
  [join(homedir(), '.local/share/opencode/opencode.db'), 'opencode credential database'],
  [join(homedir(), '.config/opencode/opencode.jsonc'), 'global opencode config'],
  [join(homedir(), '.local/share/agentmemory/secret'), 'agentmemory secret'],
  [join(homedir(), '.local/share/pki/nssdb/key4.db'), 'NSS key database'],
  [join(homedir(), '.ssh/id_rsa'), 'SSH private key'],
] as const;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'intelligenz-audit-'));
  const workspaceRoot = join(root, 'ws');
  const runDir = join(root, 'run');
  const entryDir = join(runDir, 'entry');

  await mkdir(join(workspaceRoot, 'repo'), { recursive: true });
  await mkdir(entryDir, { recursive: true, mode: 0o700 });
  await writeFile(join(entryDir, 'sandbox-entry.mjs'), SANDBOX_ENTRY_SOURCE, { mode: 0o500 });

  const plan = buildEphemeralStatePlan();

  const nodeRoot = dirname(dirname(resolve(process.execPath)));

  const sandbox = (argv: readonly string[]): SandboxCommand =>
    buildSandboxCommand({ rootPath: workspaceRoot }, argv, {
      env: {
        PATH: `${join(nodeRoot, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
        HOME: '/tmp/home',
        XDG_DATA_HOME: '/xdg-data',
        XDG_STATE_HOME: '/xdg-state',
        XDG_CACHE_HOME: '/xdg-cache',
        XDG_CONFIG_HOME: '/xdg-config',
        IZ_BROKER_SOCKET: '/run/agent-broker/broker.sock',
        IZ_BROKER_PORT: '8899',
        AGENT_RLIMIT_NOFILE: '1024',
        AGENT_RLIMIT_NPROC: '4096',
        AGENT_RLIMIT_AS: String(6 * 1024 * 1024 * 1024),
      },
      mounts: [
        { hostPath: entryDir, containerPath: '/opt/agent', mode: 'ro' },
        { hostPath: nodeRoot, mode: 'ro' },
        ...plan.mounts,
      ],
      extraArgs: plan.dirs.flatMap((dir) => ['--dir', dir]),
    });

  out('─'.repeat(78));
  out('1. mount plan derived from the host');
  out('─'.repeat(78));

  out(`   host mounts  ${plan.mounts.length === 0 ? '(none — the state tree is created empty in-sandbox)' : String(plan.mounts.length)}`);
  for (const mount of plan.mounts) {
    out(`   ${mount.mode.padEnd(9)} ${mount.hostPath} -> ${mount.containerPath ?? mount.hostPath}`);
  }
  out(`   dirs         ${plan.dirs.join(', ')}`);
  out();

  out('─'.repeat(78));
  out('2. visible state, from inside the sandbox');
  out('─'.repeat(78));

  const listing = await run(sandbox(['/bin/ls', '-la', '/xdg-data', '/xdg-data/opencode']));
  out(listing.stdout.trim());
  out();

  const secretScript = [
    ...AUDIT_PATHS.map(
      ([path, label]) => `echo "${label}: $(head -c 40 ${path} 2>&1 | tr -d '\\n')"`,
    ),
    'echo "own session db: $(ls -A /xdg-data/opencode 2>&1 | tr -d \'\\n\')"',
  ].join('; ');

  const secrets = await run(sandbox(['/bin/sh', '-c', secretScript]));
  out(secrets.stdout.trim());
  if (secrets.stderr.trim().length > 0) out(`   stderr: ${secrets.stderr.trim()}`);
  out();

  out('─'.repeat(78));
  out('3. resource ceilings as the agent sees them (entry wrapper + prlimit)');
  out('─'.repeat(78));

  const limits = await run(
    sandbox([
      'node',
      '/opt/agent/sandbox-entry.mjs',
      '/bin/sh',
      '-c',
      'echo "ulimit: nofile=$(ulimit -n) virtual=$(ulimit -v)"; grep -E "Max open files|Max processes|Max address space" /proc/self/limits',
    ]),
  );

  out(limits.stdout.trim());
  if (limits.stderr.trim().length > 0) out(`   stderr: ${limits.stderr.trim()}`);
  out();

  out('─'.repeat(78));
  out('4. egress: there is none, and no proxy variable exists to abuse');
  out('─'.repeat(78));

  const egress = await run(
    sandbox([
      '/bin/sh',
      '-c',
      [
        'echo "HTTPS_PROXY=${HTTPS_PROXY:-<unset>}"',
        'if (exec 3<>/dev/tcp/1.1.1.1/443) 2>/dev/null; then echo "tcp/443: REACHABLE"; else echo "tcp/443: BLOCKED"; fi',
        'echo "dns: $(getent hosts api.commandcode.ai >/dev/null 2>&1 && echo resolved || echo blocked)"',
      ].join('; '),
    ]),
  );

  out(egress.stdout.trim());
  if (egress.stderr.trim().length > 0) out(`   stderr: ${egress.stderr.trim().slice(0, 200)}`);

  await rm(root, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
