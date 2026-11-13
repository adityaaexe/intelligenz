/**
 * Phase 3, Unit E2 — sandbox remediation evidence.
 *
 * This is not a test; it is the measurement the security report quotes. Every line is
 * produced by running something, not by reading a comment:
 *
 *   1. the mount plan the adapter derives from the **real** `$HOME`;
 *   2. what is visible under `/xdg-data` from inside the sandbox, including attempts to
 *      read the credentials the audit found there before;
 *   3. the resource ceilings the entry wrapper applies (`ulimit` as the agent sees it);
 *   4. the egress policy: `CONNECT` on 443 vs non-443 ports, through a real `curl` that
 *      speaks proxy protocol to the sandbox's loopback listener.
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

import { buildOpencodeStateMounts } from '../../packages/agent-runtime/src/sandbox/state-mounts.ts';
import { startEgressProxy } from '../../packages/agent-runtime/src/sandbox/egress-proxy.ts';
import { SANDBOX_ENTRY_SOURCE } from '../../packages/agent-runtime/src/sandbox/entry-source.ts';
import { buildSandboxCommand, type SandboxCommand } from '../../packages/workspace-manager/src/index.ts';

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
      { timeout: timeoutMs, maxBuffer: 2 * 1024 * 1024, encoding: 'utf8' },
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

/** The host paths the audit named as exposed, and the reason each was reachable. */
const AUDIT_PATHS = [
  [join(homedir(), '.local/share/agentmemory/secret'), 'agentmemory secret'],
  [join(homedir(), '.local/share/pki/nssdb/key4.db'), 'NSS key database'],
  [join(homedir(), '.local/state/lesshst'), 'operator shell history'],
  [join(homedir(), '.ssh/id_rsa'), 'SSH private key'],
  [join(homedir(), '.config/opencode/cli.json'), 'global opencode config'],
] as const;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'intelligenz-audit-'));
  const workspaceRoot = join(root, 'ws');
  const runDir = join(root, 'run');
  const entryDir = join(runDir, 'entry');
  const egressDir = join(runDir, 'egress');

  await mkdir(join(workspaceRoot, 'repo'), { recursive: true });
  await mkdir(entryDir, { recursive: true, mode: 0o700 });
  await mkdir(egressDir, { recursive: true, mode: 0o700 });
  await writeFile(join(entryDir, 'sandbox-entry.mjs'), SANDBOX_ENTRY_SOURCE, { mode: 0o500 });

  const plan = await buildOpencodeStateMounts({
    dataHome: join(homedir(), '.local', 'share'),
    stateHome: join(homedir(), '.local', 'state'),
    cacheHome: join(homedir(), '.cache'),
    configHome: join(homedir(), '.config'),
  });

  const nodeRoot = dirname(dirname(resolve(process.execPath)));
  const proxy = await startEgressProxy({ socketDir: egressDir, allowHosts: ['api.commandcode.ai'] });

  const sandbox = (argv: readonly string[]): SandboxCommand =>
    buildSandboxCommand({ rootPath: workspaceRoot }, argv, {
      env: {
        PATH: `${join(nodeRoot, 'bin')}:/usr/local/bin:/usr/bin:/bin`,
        HOME: '/tmp/home',
        XDG_DATA_HOME: '/xdg-data',
        XDG_STATE_HOME: '/xdg-state',
        XDG_CACHE_HOME: '/xdg-cache',
        XDG_CONFIG_HOME: '/xdg-config',
        AGENT_PROXY_SOCKET: '/run/agent-egress/egress.sock',
        AGENT_PROXY_PORT: '8899',
        AGENT_RLIMIT_NOFILE: '1024',
        AGENT_RLIMIT_NPROC: '4096',
        AGENT_RLIMIT_AS: String(6 * 1024 * 1024 * 1024),
        AGENT_RLIMIT_FSIZE: String(256 * 1024 * 1024),
      },
      mounts: [
        { hostPath: entryDir, containerPath: '/opt/agent', mode: 'ro' },
        { hostPath: nodeRoot, mode: 'ro' },
        { hostPath: egressDir, containerPath: '/run/agent-egress', mode: 'ro' },
        ...plan.mounts,
      ],
      extraArgs: [
        ...plan.masks.flatMap((mask) => ['--tmpfs', mask]),
        ...plan.dirs.flatMap((dir) => ['--dir', dir]),
      ],
    });

  out('─'.repeat(78));
  out('1. mount plan derived from the real $HOME');
  out('─'.repeat(78));

  for (const mount of plan.mounts) {
    out(`   ${mount.mode.padEnd(9)} ${mount.hostPath} -> ${mount.containerPath ?? mount.hostPath}`);
  }

  out(`   masked       ${plan.masks.length === 0 ? '(none present)' : plan.masks.join(', ')}`);
  out();

  out('─'.repeat(78));
  out('2. what is visible under /xdg-data, from inside the sandbox');
  out('─'.repeat(78));

  const listing = await run(sandbox(['/bin/ls', '-la', '/xdg-data', '/xdg-data/opencode']));
  out(listing.stdout.trim());

  out();

  const secretScript = [
    ...AUDIT_PATHS.map(
      ([path, label]) =>
        `echo "${label}: $(head -c 70 ${path} 2>&1 | tr -d '\\n')"`,
    ),
    'echo "mcp-auth.json: $(head -c 70 /xdg-data/opencode/mcp-auth.json 2>&1 | tr -d \'\\n\')"',
    'echo "opencode.db readable: $(head -c 16 /xdg-data/opencode/opencode.db | od -An -tx1 | tr -d \'\\n\')"',
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
  out('4. egress: CONNECT on 443 vs a non-443 port, through curl');
  out('─'.repeat(78));

  const curl = (target: string): SandboxCommand =>
    sandbox([
      'node',
      '/opt/agent/sandbox-entry.mjs',
      '/usr/bin/curl',
      '-sS',
      '-m',
      '8',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      '-x',
      'http://127.0.0.1:8899',
      target,
    ]);

  for (const [label, target] of [
    ['443 ', 'https://api.commandcode.ai:443/'],
    ['22  ', 'https://api.commandcode.ai:22/'],
    ['8443', 'https://api.commandcode.ai:8443/'],
    ['evil', 'https://evil.example.test:443/'],
  ] as const) {
    const result = await run(curl(target), 30_000);

    out(
      `   ${label} exit=${String(result.code)} body=${JSON.stringify(result.stdout.slice(0, 40))} err=${JSON.stringify(result.stderr.trim().slice(0, 90))}`,
    );
  }

  out();
  out('   proxy log:');
  for (const entry of proxy.requests) {
    out(`     ${entry.method} ${entry.host}:${String(entry.port)} -> ${entry.allowed ? 'allow' : 'deny'}`);
  }

  await proxy.close();
  await rm(root, { recursive: true, force: true });
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
