import { mkdir, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  OpencodeCliRuntime,
  RuntimeCapabilities,
  parseOpencodeStream,
  redact,
} from '../src';
import { createWorkspaceManager, type WorkspaceHandle } from '@intelligenz/workspace-manager';
import { realProviderGate } from './real-provider-gate';
import { describeRuntimeContract, type RuntimeContractOptions } from './runtime-contract';

/**
 * The real adapter, against the shared contract suite and its own escape tests.
 *
 * The default run is **offline**. The escape tests and contract cases 1–6 assert the
 * result *contract* — capability shape, health union, structured refusal, cancel,
 * timeout — and none of them needs a model. The two cases that do need one (artifact
 * checksums, determinism) run only when asked:
 *
 *   IZ_REAL_PROVIDER=1 AGENT_MODEL=gemini-3.5-flash-lite \
 *     pnpm --filter @intelligenz/agent-runtime test
 *
 * Without that opt-in the live cases are skipped and the reason is printed. A default
 * suite that needs provider quota is not a gate: it goes red for environmental reasons
 * and teaches everyone to ignore red.
 */

const FIXTURE = resolve(fileURLToPath(new URL('../../../infra/fixtures/sample-repo', import.meta.url)));

/**
 * The real provider, addressed through the host broker.
 *
 * `MODEL` is the **upstream** id: the sandbox only ever sees `izbroker/<key>`, and the
 * broker appends the path to `upstreamBaseUrl`. Defaults match the host this ran on;
 * override with the `AGENT_*` variables to use a different provider. The credential is
 * read from opencode's SQLite store, host-side, and is never passed to the adapter.
 */
const MODEL = process.env.AGENT_MODEL ?? 'gemini-3.5-flash-lite';
const BROKER = {
  upstreamBaseUrl:
    process.env.AGENT_BROKER_UPSTREAM_URL ??
    'https://generativelanguage.googleapis.com/v1beta/openai',
  credential: {
    kind: 'opencode-db' as const,
    databasePath:
      process.env.AGENT_BROKER_CREDENTIAL_DB ??
      join(homedir(), '.local', 'share', 'opencode', 'opencode.db'),
    integrationId: process.env.AGENT_BROKER_CREDENTIAL ?? 'google',
  },
  maxRequests: 200,
};
const provider = realProviderGate(process.env);

if (provider.reason !== null) {
  // Written to the real stderr rather than `console.warn`: the default reporter buffers
  // console output from files that pass, and a skip nobody can see is a skip that rots
  // into "the suite is green, so the live cases must have run".
  process.stderr.write(`skipped: ${provider.reason}\n`);
}

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/**
 * Fixed rather than `mkdtemp`: the contract suite's `request` defaults are evaluated
 * when the suite is *registered*, before any `beforeAll` has run, so the workspace path
 * has to be knowable at import time.
 */
const ROOT = join(tmpdir(), 'intelligenz-opencode-contract-ws');
const ARTIFACTS = join(tmpdir(), 'intelligenz-opencode-contract-artifacts');

/**
 * Contract options, shaped by the gate.
 *
 * Live: the request names the workspace the suite provisioned and a real budget, so
 * cases 3–4 exercise a real spawn and cases 7–8 verify what a real run produced.
 *
 * Offline: the request carries **no** `workspaceRoot`. Cases 3–6 then exercise request
 * validation and the structured-refusal path, which is what they assert anyway — the
 * result contract, not model output. The alternative, naming a workspace with a real
 * budget, would spawn a sandbox and call a metered provider from the default suite.
 */
function contractOptions(): RuntimeContractOptions {
  if (!provider.enabled) {
    return {
      // An LLM is not a function: the same input may take a different path twice.
      deterministic: false,
      liveProvider: {
        skip: true,
        reason: provider.reason ?? 'requires a live provider',
      },
      request: {},
    };
  }

  return {
    deterministic: false,
    request: {
      // The same path `beforeAll` provisions: known at registration, real by the
      // time the suite runs.
      workspaceRoot: join(ROOT, 'org-contract', 'task-contract', 'ws-contract'),
      timeoutMs: 120_000,
      budgetUsd: 0.5,
    },
  };
}

describe('opencode-cli', () => {
  let handle: WorkspaceHandle;
  let runtime: OpencodeCliRuntime;

  beforeAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await mkdir(ROOT, { recursive: true, mode: 0o700 });
    await rm(ARTIFACTS, { recursive: true, force: true });
    await mkdir(ARTIFACTS, { recursive: true, mode: 0o700 });

    const manager = createWorkspaceManager({ root: ROOT });
    handle = await manager.provision({
      orgId: 'org-contract',
      taskId: 'task-contract',
      workspaceId: 'ws-contract',
      source: { kind: 'clone', repoPath: FIXTURE },
    });

    runtime = new OpencodeCliRuntime({
      workspaceRoot: ROOT,
      artifactsRoot: ARTIFACTS,
      model: MODEL,
      broker: BROKER,
      maxUsd: 0.5,
    });
  });

  afterAll(async () => {
    await rm(ROOT, { recursive: true, force: true });
    await rm(ARTIFACTS, { recursive: true, force: true });
  });

  it('declares the capabilities the sandbox actually provides', async () => {
    const capabilities = await runtime.capabilities();

    expect(RuntimeCapabilities.safeParse(capabilities).success).toBe(true);
    expect(capabilities).toEqual({
      shell: true,
      network: false,
      filesystem: 'write',
      browser: false,
      mcp: false,
      imageInput: false,
    });
    expect(runtime.id).toBe('opencode-cli');
  });

  it('refuses a request with no workspaceRoot instead of running in the host cwd', async () => {
    const result = await runtime.execute(
      {
        taskId: 'no-workspace',
        goal: 'do something',
        allowedPaths: [],
        allowedActions: [],
        riskClass: 'LOW',
        timeoutMs: 30_000,
        budgetUsd: 0,
        correlationId: 'test',
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('WORKSPACE_REQUIRED');
    expect(result.simulated).toBe(false);
  });

  it('refuses a workspaceRoot outside WORKSPACE_ROOT', async () => {
    const result = await runtime.execute(
      {
        taskId: 'escape-root',
        goal: 'read /etc/passwd',
        allowedPaths: [],
        allowedActions: [],
        riskClass: 'LOW',
        timeoutMs: 30_000,
        budgetUsd: 0,
        correlationId: 'test',
        // The host checkout: outside the leased root, and deliberately so.
        workspaceRoot: '/home/ubuntu/intelligenz',
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('failed');
    expect(result.error?.code).toBe('WORKSPACE_OUTSIDE_ROOT');
  });

  it('treats an unusable budget as exhausted rather than spawning anyway', async () => {
    const result = await runtime.execute(
      {
        taskId: 'tiny-budget',
        goal: 'anything',
        allowedPaths: [],
        allowedActions: [],
        riskClass: 'LOW',
        timeoutMs: 1,
        budgetUsd: 0,
        correlationId: 'test',
        workspaceRoot: handle.rootPath,
      },
      new AbortController().signal,
    );

    expect(result.status).toBe('timeout');
    expect(result.error?.code).toBe('TIMEOUT_BEFORE_SPAWN');
    expect(result.error?.retryable).toBe(true);
  });

  describeRuntimeContract(
    (context) =>
      new OpencodeCliRuntime({
        workspaceRoot: ROOT,
        artifactsRoot: context.artifactRoot,
        model: MODEL,
        broker: BROKER,
        maxUsd: 0.5,
      }),
    contractOptions(),
  );
});

describe('opencode-cli parsing and redaction', () => {
  it('extracts tool calls, cost and tokens from the NDJSON stream', () => {
    const stdout = [
      JSON.stringify({ type: 'step_start', sessionID: 'ses_1', part: { type: 'step-start' } }),
      JSON.stringify({
        type: 'tool',
        sessionID: 'ses_1',
        part: { type: 'tool', tool: 'read', state: { input: { filePath: '/workspace/src/sum.js' } } },
      }),
      JSON.stringify({
        type: 'tool',
        sessionID: 'ses_1',
        part: { type: 'tool', tool: 'shell', state: { output: '  1..3\n# pass 3' } },
      }),
      JSON.stringify({ type: 'text', sessionID: 'ses_1', part: { type: 'text', text: 'fixed it' } }),
      JSON.stringify({
        type: 'step_finish',
        sessionID: 'ses_1',
        part: { type: 'step-finish', cost: 0.0012, tokens: { input: 100, output: 20 } },
      }),
    ].join('\n');

    const parsed = parseOpencodeStream(stdout);

    expect(parsed.sessionId).toBe('ses_1');
    expect(parsed.stepCount).toBe(1);
    expect(parsed.invocations).toHaveLength(2);
    expect(parsed.invocations[0]?.tool).toBe('read');
    expect(parsed.invocations[1]?.summary).toBe('1..3 # pass 3');
    expect(parsed.usage).toEqual({ tokensIn: 100, tokensOut: 20, usd: 0.0012 });
    expect(parsed.finalText).toBe('fixed it');
  });

  it('never returns a tool summary longer than the ToolInvocation column', () => {
    const long = JSON.stringify({
      type: 'tool',
      part: { type: 'tool', tool: 'read', state: { output: 'x'.repeat(5000) } },
    });

    const parsed = parseOpencodeStream(long);

    expect(parsed.invocations[0]?.summary.length).toBeLessThanOrEqual(500);
  });

  it('redacts credentials that a model or a shell trace could have echoed', () => {
    const samples = [
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.signature',
      'export OPENAI_API_KEY=sk-live-abcdef123456',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123',
      'aws AKIAIOSFODNN7EXAMPLE',
      'digest 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      'PASSWORD=hunter2',
    ];

    for (const sample of samples) {
      const redacted = redact(sample);
      expect(redacted).toContain('[redacted]');
      expect(redacted).not.toMatch(/sk-live|ghp_|AKIAIOSFODNN7EXAMPLE|hunter2|9f86d081884c7d65/);
    }
  });

  it('ignores lines that are not JSON instead of throwing', () => {
    const parsed = parseOpencodeStream('not json\n{"type":"text","part":{"text":"ok"}}\n');
    expect(parsed.finalText).toBe('ok');
  });
});
