/**
 * Phase 3, Scope 5 — the real execution proof.
 *
 * It is deliberately not a test: a test asserts, this **reports**. Every line it
 * prints is a measurement taken during this run, and if the agent fails to fix the
 * bug the script says so rather than repairing the file to make the output pretty.
 *
 * Run from the repository root:
 *
 *   npx tsx infra/scripts/p3-real-run.ts
 *
 * Cost: one run of the configured model, capped by `MAX_USD`. The measured spend is
 * printed; it is provider-reported, not estimated.
 *
 * Phase 4 note: authentication now happens in the host egress broker, not in the
 * sandbox. The adapter therefore needs `AGENT_BROKER_UPSTREAM_URL` and a credential
 * source (`AGENT_BROKER_CREDENTIAL` or `AGENT_BROKER_CREDENTIAL_ENV`); the defaults below
 * match the host this script was last measured on. The sandbox holds no credential.
 */

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  OpencodeCliRuntime,
  collectWorkspaceEvidence,
} from '../../packages/agent-runtime/src/index.ts';
import {
  buildSandboxCommand,
  createWorkspaceManager,
  execSandboxed,
  probeSandbox,
  type WorkspaceHandle,
} from '../../packages/workspace-manager/src/index.ts';

const execFileAsync = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../..');
const FIXTURE = join(REPO_ROOT, 'infra/fixtures/sample-repo');

const MODEL = process.env['AGENT_MODEL'] ?? 'gemini-3.5-flash';
const UPSTREAM =
  process.env['AGENT_BROKER_UPSTREAM_URL'] ??
  'https://generativelanguage.googleapis.com/v1beta/openai';
const INTEGRATION = process.env['AGENT_BROKER_CREDENTIAL'] ?? 'google';
const CREDENTIAL_DB =
  process.env['AGENT_BROKER_CREDENTIAL_DB'] ??
  join(process.env['HOME'] ?? '', '.local', 'share', 'opencode', 'opencode.db');
const GOAL =
  'The test suite fails. Find the bug in src/sum.js, fix it, and run `node --test` to prove it passes. Do not change the test file.';
const TIMEOUT_MS = 180_000;
/** Hard cap. The adapter kills the run when the provider-reported total passes it. */
const MAX_USD = 0.5;

const out = (line = ''): void => {
  process.stdout.write(`${line}\n`);
};

async function git(args: readonly string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync('git', [...args], { cwd, timeout: 30_000 });
  return stdout.trim();
}

/**
 * The fixture is committed as plain files plus its own `.git`. From a fresh clone the
 * `.git` may be absent, so this recreates it with one deterministic commit — the
 * script never edits the fixture's content, only its version-control metadata.
 */
async function ensureFixtureRepository(): Promise<void> {
  if (existsSync(join(FIXTURE, '.git'))) {
    out(`fixture repo: present at ${await git(['rev-parse', '--short', 'HEAD'], FIXTURE)}`);
    return;
  }

  await git(['init', '-q', '-b', 'main'], FIXTURE);
  await git(['add', '-A'], FIXTURE);
  await execFileAsync(
    'git',
    ['-c', 'user.email=fixture@intelligenz.local', '-c', 'user.name=INTELLIGENZ fixture', 'commit', '-q', '-m', 'sample-repo: broken sum, three failing tests'],
    {
      cwd: FIXTURE,
      timeout: 30_000,
      env: {
        ...process.env,
        GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z',
        GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z',
      },
    },
  );
  out(`fixture repo: created at ${await git(['rev-parse', '--short', 'HEAD'], FIXTURE)}`);
}

async function runInSandbox(handle: WorkspaceHandle, argv: readonly string[]): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const nodeRoot = dirname(dirname(resolve(process.execPath)));
  const command = buildSandboxCommand(handle, argv, {
    mounts: [{ hostPath: nodeRoot, mode: 'ro' }],
    env: { PATH: `${join(nodeRoot, 'bin')}:/usr/local/bin:/usr/bin:/bin` },
  });

  // SEC-403: a raw `execFile` here inherited the operator's whole environment,
  // because Node's default is inheritance. `execSandboxed` is the one sanctioned
  // spawn: it passes `command.env`, which `buildSandboxCommand` derived from the
  // PATH/LANG/HOME/TMPDIR allowlist. bwrap itself therefore starts with four
  // variables, not the worker's credential-bearing environment.
  try {
    const { stdout, stderr } = await execSandboxed(command, {
      timeoutMs: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    // A failing `node --test` is the expected outcome of this step, not an error:
    // report its exit code and output instead of throwing.
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    return {
      code: typeof failed.code === 'number' ? failed.code : 1,
      stdout: failed.stdout ?? '',
      stderr: failed.stderr ?? '',
    };
  }
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const root = await mkdtemp(join(tmpdir(), 'intelligenz-p3-'));
  const workspaceRoot = join(root, 'workspaces');
  const artifactsRoot = join(root, 'artifacts');
  await mkdir(workspaceRoot, { recursive: true, mode: 0o700 });
  await mkdir(artifactsRoot, { recursive: true, mode: 0o700 });

  out('─'.repeat(78));
  out('INTELLIGENZ Phase 3 — real execution proof');
  out('─'.repeat(78));
  out(`node            ${process.version}`);
  out(`model           ${MODEL}`);
  out(`timeout         ${TIMEOUT_MS}ms   spend cap  $${MAX_USD}`);
  out(`workspace root  ${workspaceRoot}`);
  out(`artifact root   ${artifactsRoot}`);
  out();

  out('1. fixture repository');
  await ensureFixtureRepository();
  const fixtureCommit = await git(['rev-parse', 'HEAD'], FIXTURE);
  const fixtureStatusBefore = await git(['status', '--porcelain'], FIXTURE);
  out(`   HEAD            ${fixtureCommit}`);
  out(`   status          ${fixtureStatusBefore.length === 0 ? "(clean)" : fixtureStatusBefore}`);
  out();

  out('2. provision — clone the fixture (the fixture itself is never touched)');
  const manager = createWorkspaceManager({ root: workspaceRoot });
  const handle = await manager.provision({
    orgId: 'org-fixture',
    taskId: 'task-sum-fix',
    workspaceId: 'ws-real-run',
    source: { kind: 'clone', repoPath: FIXTURE },
  });

  if (handle.state !== 'ready') {
    out(`   PROVISION FAILED: ${handle.error?.code ?? 'unknown'} — ${handle.error?.message ?? ''}`);
    process.exitCode = 1;
    return;
  }

  out(`   rootPath        ${handle.rootPath}`);
  out(`   baseCommit      ${handle.baseCommit}`);
  out(`   branch          ${handle.branch ?? '(detached)'}`);
  out();

  out('3. sandbox capability probe — measured by running commands inside it');
  const probe = await probeSandbox(handle);
  out(`   networkBlocked      ${probe.networkBlocked}`);
  out(`   canWriteWorkspace   ${probe.canWriteWorkspace}`);
  out(`   rootReadOnly        ${probe.rootReadOnly}`);
  for (const [key, value] of Object.entries(probe.evidence)) {
    out(`   ${key.padEnd(18)} ${value}`);
  }
  out();

  out('4. execute — the real task, in the sandbox, against the clone');
  const runtime = new OpencodeCliRuntime({
    workspaceRoot,
    artifactsRoot,
    model: MODEL,
    broker: {
      upstreamBaseUrl: UPSTREAM,
      credential: { kind: 'opencode-db', databasePath: CREDENTIAL_DB, integrationId: INTEGRATION },
    },
    maxUsd: MAX_USD,
  });

  const health = await runtime.health();
  out(`   health          ${health.status} — ${health.detail ?? ''}`);

  const controller = new AbortController();
  const runStartedAt = Date.now();
  const result = await runtime.execute(
    {
      taskId: 'task-sum-fix',
      goal: GOAL,
      allowedPaths: [handle.repoPath],
      allowedActions: [],
      riskClass: 'LOW',
      timeoutMs: TIMEOUT_MS,
      budgetUsd: MAX_USD,
      correlationId: 'p3-real-run',
      workspaceRoot: handle.rootPath,
    },
    controller.signal,
  );
  const wallMs = Date.now() - runStartedAt;

  out();
  out(`   status          ${result.status}`);
  out(`   simulated       ${result.simulated}   runtime ${result.runtimeId} ${result.runtimeVersion ?? ''}`);
  out(`   wall time       ${(wallMs / 1000).toFixed(1)}s`);
  out(`   tokens          in=${result.usage.tokensIn ?? 'unknown'} out=${result.usage.tokensOut ?? 'unknown'}`);
  out(`   cost (provider) $${(result.usage.usd ?? Number.NaN).toFixed(6)}`);
  out(`   summary         ${result.summary.slice(0, 400)}`);

  if (result.error !== undefined) {
    out(`   error           ${result.error.code} (retryable=${String(result.error.retryable)})`);
    out(`   message         ${result.error.message.slice(0, 600)}`);
  }

  out();
  out(`   tool invocations (${result.toolInvocations?.length ?? 0})`);
  for (const invocation of result.toolInvocations ?? []) {
    out(`     ${String(invocation.sequence).padStart(2)}. ${invocation.tool.padEnd(8)} ${invocation.summary.slice(0, 160)}`);
  }

  if (result.providerMeta !== undefined) {
    const meta = result.providerMeta;
    out();
    out(`   providerMeta    model=${String(meta.model)} session=${String(meta.sessionId)} steps=${String(meta.steps)}`);
    const broker = meta.broker as { requests?: number; upstream?: string[] } | undefined;
    out(`   broker          ${String(broker?.requests ?? 0)} request(s)`);
    for (const entry of broker?.upstream ?? []) out(`                   ${entry}`);
  }

  out();
  out('5. diff produced inside the sandbox — never by a host git against the agent’s tree');
  // The workspace is agent-writable; `.git/config` and `.git/hooks/*` are attacker
  // input. `collectWorkspaceEvidence` runs git inside `bwrap`, so this script cannot
  // become the sandbox escape the adapter used to be.
  const evidence = await collectWorkspaceEvidence({ workspaceRoot: handle.rootPath });
  const diff = evidence?.diff ?? '';
  const status = evidence?.status ?? '';
  out(`   git status      ${status.trim().length === 0 ? "(clean)" : status.trim().replace(/\n/g, ' | ')}`);
  if (diff.length === 0) {
    out('   (no diff — the agent changed nothing)');
  } else {
    for (const line of diff.split('\n')) out(`   ${line}`);
  }

  out();
  out('6. re-run the suite inside the sandbox — `node --test` in /workspace');
  const verification = await runInSandbox(handle, ['node', '--test']);
  out(`   exit code       ${verification.code}`);
  for (const line of verification.stdout.trim().split('\n').slice(-12)) {
    out(`   ${line}`);
  }
  if (verification.stderr.trim().length > 0) {
    out(`   stderr          ${verification.stderr.trim().split('\n').slice(-4).join(' | ')}`);
  }

  const testFileUnchanged = await collectWorkspaceEvidence({ workspaceRoot: handle.rootPath });
  const changedTestFile = (testFileUnchanged?.diff ?? '')
    .split('\n')
    .filter((line) => line.startsWith('diff --git') && line.includes('test/sum.test.js'));
  out(`   test file       ${changedTestFile.length === 0 ? 'unchanged' : `CHANGED: ${changedTestFile.join(' | ')}`}`);

  out();
  out('7. the original fixture must be untouched');
  const fixtureStatusAfter = await git(['status', '--porcelain'], FIXTURE);
  const fixtureHeadAfter = await git(['rev-parse', 'HEAD'], FIXTURE);
  out(`   HEAD            ${fixtureHeadAfter} ${fixtureHeadAfter === fixtureCommit ? '(unchanged)' : '(MOVED)'}`);
  out(`   status          ${fixtureStatusAfter.length === 0 ? "(clean)" : fixtureStatusAfter.replace(/\n/g, ' | ')}`);

  out();
  out('─'.repeat(78));
  const testsPassed = verification.code === 0;
  const fixtureClean = fixtureStatusAfter.length === 0 && fixtureHeadAfter === fixtureCommit;
  const fixed = diff.includes('src/sum.js') && testsPassed;

  out(`agent fixed the bug        ${fixed ? 'YES' : 'NO'}`);
  out(`suite passes in sandbox    ${testsPassed ? 'YES' : 'NO'}`);
  out(`fixture unchanged          ${fixtureClean ? 'YES' : 'NO'}`);
  out(`reported spend             $${(result.usage.usd ?? 0).toFixed(6)} (cap $${MAX_USD.toFixed(2)})`);
  out(`total wall time            ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  out(`workspace kept at          ${handle.rootPath}`);
  out('─'.repeat(78));

  if (!fixed || !fixtureClean) process.exitCode = 1;
}

// Not top-level `await`: the file is `.ts`, and tsx compiles a `.ts` entry as CJS by
// default, where top-level await is a syntax error. A promise chain is the portable
// spelling.
void main().catch((error: unknown) => {
  process.stderr.write(
    `p3-real-run failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
