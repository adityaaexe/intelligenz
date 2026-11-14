import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  buildSandboxCommand,
  createWorkspaceManager,
  type WorkspaceHandle,
} from '@intelligenz/workspace-manager';

import { OpencodeCliRuntime } from '../src';

/**
 * The whole path, end to end, with a stub provider.
 *
 * `opencode` is the real binary and it really runs inside `bwrap`; only the upstream is
 * a local stub. That makes the run free and deterministic while still exercising every
 * hop that matters:
 *
 * ```
 * opencode → 127.0.0.1:8899 (in sandbox) → unix socket → host broker → stub upstream
 * ```
 *
 * The assertions are about the credential: the upstream must see the real one, the
 * sandbox must hold only the canary, and no byte written anywhere by the adapter may
 * contain the real value.
 *
 * The second test is the failure path: with a credential source that yields nothing, the
 * broker refuses with 403 and the adapter reports `BROKER_CREDENTIAL_UNAVAILABLE` — it
 * does not fall back to anything, because there is nothing to fall back to.
 */

const FIXTURE = resolve(fileURLToPath(new URL('../../../infra/fixtures/sample-repo', import.meta.url)));
const REAL_CREDENTIAL = 'iz-real-provider-credential-for-test-0123456789';
const CREDENTIAL_ENV = 'IZ_BROKER_RUN_TEST_CREDENTIAL';
const MISSING_ENV = 'IZ_BROKER_RUN_TEST_ABSENT';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** A minimal OpenAI-compatible streaming response. */
function completionStream(text: string): string {
  const id = 'chatcmpl-stub';
  const created = Math.floor(Date.now() / 1000);
  const chunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

  return [
    chunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: 'stub',
      choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: null }],
    }),
    chunk({
      id,
      object: 'chat.completion.chunk',
      created,
      model: 'stub',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
    }),
    'data: [DONE]\n\n',
  ].join('');
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];

  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) await walk(path);
      else out.push(path);
    }
  };

  try {
    if ((await stat(root)).isDirectory()) await walk(root);
  } catch {
    return [];
  }

  return out;
}

describe('a real run authenticates through the broker', () => {
  let scratch: string;
  let workspaceRoot: string;
  let handle: WorkspaceHandle;
  let upstream: Server;
  let upstreamAuthorizations: string[];
  let upstreamPaths: string[];

  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'intelligenz-broker-run-scratch-'));
    workspaceRoot = await mkdtemp(join(tmpdir(), 'intelligenz-broker-run-ws-'));
    upstreamAuthorizations = [];
    upstreamPaths = [];

    upstream = createServer((req, res) => {
      upstreamAuthorizations.push(String(req.headers['authorization'] ?? ''));
      upstreamPaths.push(`${req.method ?? ''} ${req.url ?? ''}`);
      req.resume();

      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        res.end(completionStream('pong'));
      });
    });

    await new Promise<void>((resolvePromise) => {
      upstream.listen(0, '127.0.0.1', () => resolvePromise());
    });

    const manager = createWorkspaceManager({ root: workspaceRoot });
    handle = await manager.provision({
      orgId: 'org-broker',
      taskId: 'task-broker',
      workspaceId: 'ws-broker',
      source: { kind: 'clone', repoPath: FIXTURE },
    });

    process.env[CREDENTIAL_ENV] = REAL_CREDENTIAL;
  }, 120_000);

  afterAll(async () => {
    delete process.env[CREDENTIAL_ENV];
    delete process.env[MISSING_ENV];
    await new Promise<void>((resolvePromise) => upstream.close(() => resolvePromise()));
    await rm(scratch, { recursive: true, force: true });
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it('completes with a canary inside the sandbox and the real key only on the host', async () => {
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('no upstream address');

    const runtime = new OpencodeCliRuntime({
      workspaceRoot,
      artifactsRoot: scratch,
      model: 'stub-model',
      broker: {
        upstreamBaseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        credential: { kind: 'env', name: CREDENTIAL_ENV },
        maxRequests: 25,
      },
      maxUsd: 0.5,
    });

    const result = await runtime.execute(
      {
        taskId: 'task-broker',
        goal: 'Reply with exactly the word: pong',
        allowedPaths: [handle.repoPath],
        allowedActions: [],
        riskClass: 'LOW',
        timeoutMs: 90_000,
        budgetUsd: 0.5,
        correlationId: 'broker-run',
        workspaceRoot: handle.rootPath,
      },
      new AbortController().signal,
    );

    expect(result.error?.code).toBeUndefined();
    expect(result.status).toBe('succeeded');
    expect(result.simulated).toBe(false);
    expect(result.summary).toContain('pong');

    // The upstream saw the injected credential and the OpenAI path — and nothing else.
    expect(upstreamAuthorizations).toContain(`Bearer ${REAL_CREDENTIAL}`);
    expect(upstreamAuthorizations.some((value) => value.includes('iz-canary-'))).toBe(false);
    expect(upstreamPaths).toContain('POST /v1/chat/completions');

    // The run's own record: the generated config holds a canary and a loopback baseURL.
    const files = await listFiles(join(scratch, 'opencode-cli'));
    expect(files.length).toBeGreaterThan(0);

    const configPath = files.find((file) => file.endsWith('config/opencode.json'));
    expect(configPath).toBeDefined();

    const config = JSON.parse(await readFile(configPath as string, 'utf8')) as {
      providers: Record<string, { settings: { baseURL: string } }>;
    };
    const provider = config.providers['izbroker'];

    expect(provider?.settings.baseURL).toBe('http://127.0.0.1:8899/v1');

    // No file the adapter wrote may contain the real credential.
    for (const file of files) {
      const bytes = await readFile(file);
      expect(bytes.includes(REAL_CREDENTIAL), `${file} must not contain the credential`).toBe(false);
    }

    // The broker log is evidence and is present, with no secret in it.
    const logFile = files.find((file) => file.endsWith('broker.ndjson'));
    expect(logFile).toBeDefined();

    const log = await readFile(logFile as string, 'utf8');
    expect(log).toContain('/v1/chat/completions');
    expect(log).not.toContain(REAL_CREDENTIAL);
  });

  it('reports BROKER_CREDENTIAL_UNAVAILABLE instead of running without a key', async () => {
    const address = upstream.address();
    if (address === null || typeof address === 'string') throw new Error('no upstream address');

    const before = upstreamAuthorizations.length;

    const runtime = new OpencodeCliRuntime({
      workspaceRoot,
      artifactsRoot: scratch,
      model: 'stub-model',
      broker: {
        upstreamBaseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
        credential: { kind: 'env', name: MISSING_ENV },
        maxRequests: 25,
      },
      maxUsd: 0.5,
    });

    const result = await runtime.execute(
      {
        taskId: 'task-broker-no-key',
        goal: 'Reply with exactly the word: pong',
        allowedPaths: [handle.repoPath],
        allowedActions: [],
        riskClass: 'LOW',
        timeoutMs: 60_000,
        budgetUsd: 0.5,
        correlationId: 'broker-run-no-key',
        workspaceRoot: handle.rootPath,
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('BROKER_CREDENTIAL_UNAVAILABLE');
    expect(result.error?.retryable).toBe(false);

    // Nothing egressed: the upstream was never called by this run.
    expect(upstreamAuthorizations.length).toBe(before);
  });
});

/**
 * The real task, against a real provider — **off by default**.
 *
 * It is a test rather than a script because "the agent fixed a failing test through a
 * broker that injects the credential" is the claim this unit exists to make, and a
 * claim that is only ever demonstrated by hand decays. It costs provider credit and
 * needs a working key, so it runs only when asked:
 *
 *   P4_REAL_MODEL=1 AGENT_MODEL=gemini-3.5-flash-lite \
 *   AGENT_BROKER_UPSTREAM_URL=https://generativelanguage.googleapis.com/v1beta/openai \
 *   AGENT_BROKER_CREDENTIAL=google \
 *   npx vitest run packages/agent-runtime/test/broker-run.test.ts
 */
describe.skipIf(process.env['P4_REAL_MODEL'] !== '1')('a real task through the broker', () => {
  it('fixes the fixture bug and proves the suite passes inside the sandbox', async () => {
    const scratch = await mkdtemp(join(tmpdir(), 'intelligenz-real-scratch-'));
    const workspaces = await mkdtemp(join(tmpdir(), 'intelligenz-real-ws-'));
    const databasePath =
      process.env['AGENT_BROKER_CREDENTIAL_DB'] ??
      join(process.env['HOME'] ?? '', '.local', 'share', 'opencode', 'opencode.db');

    try {
      const manager = createWorkspaceManager({ root: workspaces });
      const handle = await manager.provision({
        orgId: 'org-real',
        taskId: 'task-real',
        workspaceId: 'ws-real',
        source: { kind: 'clone', repoPath: FIXTURE },
      });

      const runtime = new OpencodeCliRuntime({
        workspaceRoot: workspaces,
        artifactsRoot: scratch,
        model: process.env['AGENT_MODEL'] ?? 'gemini-3.5-flash-lite',
        broker: {
          upstreamBaseUrl:
            process.env['AGENT_BROKER_UPSTREAM_URL'] ??
            'https://generativelanguage.googleapis.com/v1beta/openai',
          credential: {
            kind: 'opencode-db',
            databasePath,
            integrationId: process.env['AGENT_BROKER_CREDENTIAL'] ?? 'google',
          },
          maxRequests: 60,
        },
        maxUsd: 0.5,
      });

      const result = await runtime.execute(
        {
          taskId: 'task-real',
          goal:
            'The test suite fails. Find the bug in src/sum.js, fix it, and run `node --test` ' +
            'to prove it passes. Do not change the test file.',
          allowedPaths: [handle.repoPath],
          allowedActions: [],
          riskClass: 'LOW',
          timeoutMs: 180_000,
          budgetUsd: 0.5,
          correlationId: 'real-task',
          workspaceRoot: handle.rootPath,
        },
        new AbortController().signal,
      );

      expect(result.status).toBe('succeeded');
      expect(result.toolInvocations?.length ?? 0).toBeGreaterThan(2);

      // The suite, re-run inside a fresh sandbox against the agent's own tree.
      const nodeRoot = dirname(dirname(resolve(process.execPath)));
      const command = buildSandboxCommand({ rootPath: handle.rootPath }, ['node', '--test'], {
        env: { PATH: `${join(nodeRoot, 'bin')}:/usr/bin:/bin` },
        mounts: [{ hostPath: nodeRoot, mode: 'ro' }],
      });

      const stdout = await new Promise<string>((resolvePromise, reject) => {
        execFile(
          command.file,
          [...command.args],
          { timeout: 60_000, encoding: 'utf8' },
          (error, out) => (error === null ? resolvePromise(out) : reject(error)),
        );
      });

      expect(stdout).toContain('# pass 3');
      expect(stdout).toContain('# fail 0');
    } finally {
      await rm(scratch, { recursive: true, force: true });
      await rm(workspaces, { recursive: true, force: true });
    }
  });
});
