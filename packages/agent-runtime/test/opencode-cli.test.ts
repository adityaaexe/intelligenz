import { mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { describeRuntimeContract } from './runtime-contract';

/**
 * The real adapter, against the shared contract suite and its own escape tests.
 *
 * This file **spends provider credit**: the contract suite cannot verify artifact
 * checksums for an adapter that never runs, so the runs are real. The model is the
 * cheapest working one and the total is a fraction of a cent per test run; the
 * measured cost is printed by `infra/scripts/p3-real-run.ts`.
 *
 * Set `OPENCODE_CLI_SKIP=1` to skip the real runs (CI without credentials). A skipped
 * suite is visible in the report rather than silently green.
 */

const FIXTURE = resolve(fileURLToPath(new URL('../../../infra/fixtures/sample-repo', import.meta.url)));
const MODEL = 'commandcode/deepseek/deepseek-v4-flash';
const enabled = process.env.OPENCODE_CLI_SKIP !== '1';

vi.setConfig({ testTimeout: 300_000, hookTimeout: 300_000 });

/**
 * Fixed rather than `mkdtemp`: the contract suite's `request` defaults are evaluated
 * when the suite is *registered*, before any `beforeAll` has run, so the workspace path
 * has to be knowable at import time.
 */
const ROOT = join(tmpdir(), 'intelligenz-opencode-contract-ws');
const ARTIFACTS = join(tmpdir(), 'intelligenz-opencode-contract-artifacts');

describe.skipIf(!enabled)('opencode-cli', () => {
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
        maxUsd: 0.5,
      }),
    {
      // An LLM is not a function: the same input may take a different path twice.
      // Declaring that honestly skips assertion 8 and shows it as skipped.
      deterministic: false,
      request: {
        // The same path `beforeAll` provisions: known at registration, real by the
        // time the suite runs.
        workspaceRoot: join(ROOT, 'org-contract', 'task-contract', 'ws-contract'),
        timeoutMs: 120_000,
        budgetUsd: 0.5,
      },
    },
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
