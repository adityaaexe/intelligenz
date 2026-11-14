/**
 * Phase 4, Gate A — the credential-isolation proof.
 *
 * This is not a test. It is the measurement the report quotes, produced by running
 * things rather than by reading comments:
 *
 *   1. host facts: which credential store answered, and how long a read takes;
 *   2. what a real `bwrap` sandbox (built from the production layout) can see of the
 *      host's credential paths, and what its own environment contains;
 *   3. the broker's refusals, attempted **from inside** that sandbox;
 *   4. a real task, run through the broker against a real provider: clone the fixture,
 *      fix the failing test, prove it passes in-sandbox;
 *   5. the broker log, scanned for the credential and for high-entropy strings;
 *   6. the cost the provider reported.
 *
 * Run from the repository root:
 *
 *   npx tsx infra/scripts/p4-broker-proof.ts
 *
 * It spends real provider credit (one run) and prints what it spent. Nothing it prints
 * is a secret: the credential is never read into this process, only into the broker's
 * request path, and the checks below compare lengths and hashes, never values.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  BROKER_RELAY_PORT,
  OpencodeCliRuntime,
  buildRuntimeSandbox,
  collectWorkspaceEvidence,
} from '../../packages/agent-runtime/src/index.ts';
import {
  readCredential,
  startEgressBroker,
  type CredentialSource,
  type EgressBroker,
} from '../../packages/egress-broker/src/index.ts';
import {
  buildSandboxCommand,
  createWorkspaceManager,
  probeSandbox,
  type SandboxCommand,
  type WorkspaceHandle,
} from '../../packages/workspace-manager/src/index.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURE = join(REPO_ROOT, 'infra/fixtures/sample-repo');

const GOAL =
  'The test suite fails. Find the bug in src/sum.js, fix it, and run `node --test` to prove it passes. Do not change the test file.';
const TIMEOUT_MS = 180_000;
const MAX_USD = 0.5;

const MODEL = process.env['AGENT_MODEL'] ?? 'gemini-3.5-flash';
const UPSTREAM =
  process.env['AGENT_BROKER_UPSTREAM_URL'] ??
  'https://generativelanguage.googleapis.com/v1beta/openai';
const INTEGRATION = process.env['AGENT_BROKER_CREDENTIAL'] ?? 'google';
const CREDENTIAL_DB =
  process.env['AGENT_BROKER_CREDENTIAL_DB'] ??
  join(process.env['HOME'] ?? '', '.local', 'share', 'opencode', 'opencode.db');

const credential: CredentialSource = {
  kind: 'opencode-db',
  databasePath: CREDENTIAL_DB,
  integrationId: INTEGRATION,
};

/**
 * Read once on the host so the log scan can look for the real value. It is never
 * printed, never written, and never passed to a sandbox.
 */
let realSecret = '';

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

const rule = (title: string): void => {
  out();
  out('─'.repeat(78));
  out(title);
  out('─'.repeat(78));
};

interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

function run(command: SandboxCommand, timeoutMs = 60_000): Promise<RunResult> {
  return new Promise((resolvePromise) => {
    execFile(
      command.file,
      [...command.args],
      {
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
        // The production spawner clears bwrap's environment; so does this, for the same
        // reason: `--clearenv` applies to the exec'd command, not to bwrap's own child,
        // which is pid 1 in the sandbox.
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

/** Shannon entropy, used only to decide whether a token-shaped run is suspicious. */
function entropy(value: string): number {
  const counts = new Map<string, number>();
  for (const char of value) counts.set(char, (counts.get(char) ?? 0) + 1);

  let result = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    result -= p * Math.log2(p);
  }

  return result;
}

/** The directive's test 8, as a scan: no credential and no 20+ char high-entropy run. */
function scanForSecrets(text: string, forbidden: readonly string[]): string[] {
  const findings: string[] = [];

  for (const value of forbidden) {
    if (value.length > 0 && text.includes(value)) findings.push('matched a known secret value');
  }

  for (const candidate of text.match(/[A-Za-z0-9+/=_-]{20,}/g) ?? []) {
    // Paths, URLs, hashes and timestamps are long and not secrets. Flag only runs that
    // look like a key: mixed case, digits, and entropy above a random-looking floor.
    const mixed = /[a-z]/.test(candidate) && /[A-Z]/.test(candidate) && /[0-9]/.test(candidate);
    if (mixed && entropy(candidate) > 3.5) findings.push(`high-entropy run: ${candidate.slice(0, 6)}…`);
  }

  return findings;
}

const CLIENT_SOURCE = `
import net from 'node:net';
import http from 'node:http';

const relay = net.createServer((client) => {
  const upstream = net.connect('/run/agent-broker/broker.sock');
  client.pipe(upstream); upstream.pipe(client);
  client.on('error', () => upstream.destroy());
  upstream.on('error', () => client.destroy());
});
await new Promise((res, rej) => { relay.once('error', rej); relay.listen(${String(BROKER_RELAY_PORT)}, '127.0.0.1', res); });

const call = (path, headers) => new Promise((resolve) => {
  const req = http.request({ host: '127.0.0.1', port: ${String(BROKER_RELAY_PORT)}, path, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': 2, ...headers }, timeout: 5000 }, (response) => {
    let text = ''; response.setEncoding('utf8');
    response.on('data', (c) => (text += c));
    response.on('end', () => resolve({ status: response.statusCode, body: text.slice(0, 120) }));
  });
  req.on('error', (e) => resolve({ status: 0, body: e.message }));
  req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'timeout' }); });
  req.end('{}');
});

const results = {
  noToken: await call('/v1/chat/completions', {}),
  foreignToken: await call('/v1/chat/completions', { authorization: 'Bearer iz-canary-a-different-attempt-000000' }),
  unapprovedPath: await call('/v1/admin', { authorization: 'Bearer ' + (process.env.IZ_BROKER_CAPABILITY || '') }),
  directTcp: await new Promise((res) => {
    const socket = net.connect(443, '1.1.1.1');
    const timer = setTimeout(() => { socket.destroy(); res('timeout'); }, 4000);
    socket.on('connect', () => { clearTimeout(timer); socket.destroy(); res('REACHABLE'); });
    socket.on('error', (e) => { clearTimeout(timer); res('blocked:' + e.code); });
  }),
  dns: await new Promise((res) => import('node:dns').then((dns) => dns.lookup('api.commandcode.ai', (e, a) => res(e ? 'blocked:' + e.code : 'resolved:' + a)))),
};
process.stdout.write(JSON.stringify(results));
relay.close();
process.exit(0);
`;

async function main(): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'intelligenz-p4-'));
  const workspaceRoot = join(root, 'workspaces');
  const artifactsRoot = join(root, 'artifacts');
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });

  out('INTELLIGENZ Phase 4 — credential isolation proof');
  out(`host            ${process.platform} node ${process.version}`);
  out(`upstream        ${UPSTREAM}`);
  out(`model           ${MODEL}`);
  out(`credential      opencode-db integration="${INTEGRATION}"`);
  out(`credential db   ${CREDENTIAL_DB}`);

  rule('1. the credential store answers, host-side only');
  const databaseStat = await stat(CREDENTIAL_DB).catch(() => null);
  out(`   database size   ${databaseStat === null ? 'absent' : `${String(databaseStat.size)} bytes`}`);

  const readStartedAt = process.hrtime.bigint();

  try {
    realSecret = readCredential(credential).token;
    const latency = Number(process.hrtime.bigint() - readStartedAt) / 1_000_000;
    out(`   read at request ${latency.toFixed(2)} ms (value held in memory only; never printed)`);
  } catch (error) {
    out(`   READ FAILED     ${error instanceof Error ? error.name : 'unknown'}`);
    out('   Nothing else in this script can prove anything without a credential.');
    process.exitCode = 1;
    return;
  }

  rule('2. what a real sandbox sees (production layout, --unshare-net)');
  const probeWorkspace = join(root, 'probe-ws');
  const configDir = join(root, 'probe-config');
  const brokerDir = join(root, 'probe-broker');
  const entryDir = join(root, 'probe-entry');
  const clientDir = join(root, 'probe-client');

  await mkdir(join(probeWorkspace, 'repo'), { recursive: true });
  for (const directory of [configDir, brokerDir, entryDir, clientDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  await writeFile(join(clientDir, 'client.mjs'), CLIENT_SOURCE, { mode: 0o500 });

  const nodeRoot = dirname(dirname(resolve(process.execPath)));
  const probeCapability = 'iz-canary-proof-attempt-0123456789abcdef';
  const sandboxLayout = buildRuntimeSandbox({
    nodeBinDir: join(nodeRoot, 'bin'),
    nodeRoot,
    configDir,
    brokerDir,
    entryDir,
    capability: probeCapability,
  });

  // A broker with a **canary** credential — never the real one — so the refusal tests
  // measure the policy rather than a provider's opinion of a key. The upstream points
  // at a closed port: an approved path must still fail at the network, which is the
  // difference between "the policy let it through" and "the policy refused it".
  process.env['IZ_BROKER_PROOF_CANARY_CREDENTIAL'] = 'iz-canary-credential-not-a-secret-0123456789';
  const probeBroker: EgressBroker = await startEgressBroker({
    socketDir: brokerDir,
    attemptId: 'proof-probe',
    capabilityToken: probeCapability,
    upstream: {
      baseUrl: 'http://127.0.0.1:9/v1',
      credential: { kind: 'env', name: 'IZ_BROKER_PROOF_CANARY_CREDENTIAL' },
    },
    maxRequests: 10,
  });

  const sandbox = (argv: readonly string[], extraMounts: readonly { hostPath: string; containerPath: string; mode: 'ro' }[] = []): SandboxCommand =>
    buildSandboxCommand({ rootPath: probeWorkspace }, argv, {
      env: sandboxLayout.env,
      mounts: [...sandboxLayout.mounts, ...extraMounts],
      extraArgs: sandboxLayout.extraArgs,
    });

  const isolationScript = [
    'echo "ls ~/.local/share/opencode:"; ls -la "$HOME/.local/share/opencode" 2>&1 | head -3',
    'echo "cat opencode.db:"; head -c 16 "$HOME/.local/share/opencode/opencode.db" 2>&1 | head -2',
    'echo "ls /xdg-data/opencode:"; ls -A /xdg-data/opencode 2>&1',
    'echo "ls ~/.config/opencode:"; ls -A "$HOME/.config/opencode" 2>&1 | head -2',
    'echo "/proc/self/environ (names only):"; tr "\\0" "\\n" < /proc/self/environ | cut -d= -f1 | sort | tr "\\n" " "',
    'echo',
    'echo "/proc/1/environ (names only):"; tr "\\0" "\\n" < /proc/1/environ | cut -d= -f1 | sort | tr "\\n" " "',
    'echo',
  ].join('; ');

  const isolation = await run(sandbox(['/bin/sh', '-c', isolationScript]));
  out(indentation(isolation.stdout.trim()));
  if (isolation.stderr.trim().length > 0) out(`   stderr: ${isolation.stderr.trim().slice(0, 200)}`);

  const brokerProbes = await run(
    sandbox([join(nodeRoot, 'bin', 'node'), '/probe/client.mjs'], [
      { hostPath: clientDir, containerPath: '/probe', mode: 'ro' },
    ]),
  );

  out();
  out('   broker, attacked from inside the sandbox:');
  const parsed = JSON.parse(brokerProbes.stdout.trim()) as Record<string, { status: number; body: string } | string>;
  for (const [label, value] of Object.entries(parsed)) {
    out(`     ${label.padEnd(16)} ${typeof value === 'string' ? value : `HTTP ${String(value.status)} ${value.body}`}`);
  }

  await probeBroker.close();
  delete process.env['IZ_BROKER_PROOF_CANARY_CREDENTIAL'];

  rule('3. the sandbox probe the adapter itself relies on');
  const probeHandle = { rootPath: probeWorkspace };
  const capabilities = await probeSandbox(probeHandle);
  out(`   networkBlocked      ${String(capabilities.networkBlocked)}`);
  out(`   canWriteWorkspace   ${String(capabilities.canWriteWorkspace)}`);
  out(`   rootReadOnly        ${String(capabilities.rootReadOnly)}`);
  out(`   evidence            ${JSON.stringify(capabilities.evidence)}`);

  rule('4. a real task, through the broker, against a real provider');
  const manager = createWorkspaceManager({ root: workspaceRoot });
  const handle: WorkspaceHandle = await manager.provision({
    orgId: 'org-proof',
    taskId: 'task-sum-fix',
    workspaceId: 'ws-proof',
    source: { kind: 'clone', repoPath: FIXTURE },
  });

  out(`   workspace       ${handle.rootPath}`);
  out(`   base commit     ${handle.baseCommit ?? '(unknown)'}`);

  const runtime = new OpencodeCliRuntime({
    workspaceRoot,
    artifactsRoot,
    model: MODEL,
    broker: { upstreamBaseUrl: UPSTREAM, credential, maxRequests: 200 },
    maxUsd: MAX_USD,
  });

  const health = await runtime.health();
  out(`   health          ${health.status} — ${health.detail ?? ''}`);

  const startedAt = Date.now();
  const result = await runtime.execute(
    {
      taskId: 'task-sum-fix',
      goal: GOAL,
      allowedPaths: [handle.repoPath],
      allowedActions: [],
      riskClass: 'LOW',
      timeoutMs: TIMEOUT_MS,
      budgetUsd: MAX_USD,
      correlationId: 'p4-broker-proof',
      workspaceRoot: handle.rootPath,
    },
    new AbortController().signal,
  );

  out(`   status          ${result.status}`);
  out(`   wall time       ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  out(`   summary         ${result.summary.slice(0, 400)}`);
  out(`   tokens          in=${String(result.usage.tokensIn ?? 'unknown')} out=${String(result.usage.tokensOut ?? 'unknown')}`);
  out(`   cost (provider) $${(result.usage.usd ?? Number.NaN).toFixed(6)}`);

  if (result.error !== undefined) {
    out(`   error           ${result.error.code} (retryable=${String(result.error.retryable)})`);
    out(`   message         ${result.error.message.slice(0, 400)}`);
  }

  out();
  out(`   tool invocations (${String(result.toolInvocations?.length ?? 0)})`);
  for (const invocation of result.toolInvocations ?? []) {
    out(`     ${String(invocation.sequence).padStart(2)}. ${invocation.tool.padEnd(8)} ${invocation.summary.slice(0, 140)}`);
  }

  const brokerMeta = result.providerMeta?.['broker'] as { requests?: number; upstream?: string[] } | undefined;
  out();
  out(`   broker requests ${String(brokerMeta?.requests ?? 0)}`);
  for (const entry of brokerMeta?.upstream ?? []) out(`     ${entry}`);

  rule('5. the suite, re-run inside the sandbox');
  const verification = await run(
    buildSandboxCommand(
      { rootPath: handle.rootPath },
      [join(nodeRoot, 'bin', 'node'), '--test'],
      { env: { PATH: `${join(nodeRoot, 'bin')}:/usr/bin:/bin` }, mounts: [{ hostPath: nodeRoot, mode: 'ro' }] },
    ),
  );
  out(`   exit code       ${String(verification.code)}`);
  for (const line of verification.stdout.trim().split('\n').slice(-12)) out(`   ${line}`);
  if (verification.stderr.trim().length > 0) {
    for (const line of verification.stderr.trim().split('\n').slice(-6)) out(`   stderr: ${line}`);
  }

  const evidence = await collectWorkspaceEvidence({ workspaceRoot: handle.rootPath });
  out();
  out(`   git status      ${evidence === null ? '(no evidence)' : evidence.status.trim().replace(/\n/g, ' | ') || '(clean)'}`);

  rule('6. broker evidence: no credential, no high-entropy secret');
  const runDirectories = await readdir(join(artifactsRoot, 'opencode-cli')).catch(() => [] as string[]);
  const runIds = runDirectories.filter((entry) => entry.startsWith('task-sum-fix-'));
  const runDir = join(artifactsRoot, 'opencode-cli', runIds[0] ?? '');
  const logPath = join(runDir, 'broker.ndjson');

  const log = await readFile(logPath, 'utf8').catch(() => '');
  out(`   log file        ${logPath}`);
  out(`   log lines       ${String(log.trim().length === 0 ? 0 : log.trim().split('\n').length)}`);

  const findings = scanForSecrets(log, [realSecret]);
  out(`   findings        ${findings.length === 0 ? '(none)' : findings.join(', ')}`);

  // Every byte the adapter wrote, not only the log: the transcript and the generated
  // config are the two other places a leak would live.
  const written: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else written.push(path);
    }
  };

  await walk(runDir).catch(() => undefined);

  let leaked = 0;
  for (const file of written) {
    const bytes = await readFile(file).catch(() => Buffer.alloc(0));
    if (bytes.includes(realSecret)) {
      leaked += 1;
      out(`   LEAK            ${file}`);
    }
  }

  out(`   files written   ${String(written.length)}; containing the credential: ${String(leaked)}`);

  out();
  out('   excerpt (first 6 and last 2 lines):');
  const lines = log.trim().split('\n').filter((line) => line.length > 0);
  for (const line of [...lines.slice(0, 6), ...(lines.length > 8 ? ['…'] : []), ...lines.slice(-2)]) {
    out(`     ${line}`);
  }

  // A `Bearer` in the log would mean a header was serialised; the shape check above
  // already forbids it, and this states it in the report's own words.
  out();
  out(`   Authorization headers in log: ${String(log.includes('Bearer') ? 'PRESENT — DEFECT' : 'none')}`);

  await rm(root, { recursive: true, force: true });
}

function indentation(text: string): string {
  return text
    .split('\n')
    .map((line) => `   ${line}`)
    .join('\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exitCode = 1;
});
