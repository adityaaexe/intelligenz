import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ExecutionRequest,
  LocalSimulatedRuntime,
  RuntimeConfigurationError,
  type ExecutionResult,
  type LocalSimulatedRuntimeOptions,
} from '../src';
import { describeRuntimeContract } from './runtime-contract';

/**
 * `LocalSimulatedRuntime` against the shared contract, plus the assertions specific to
 * a *simulated* adapter: it must be provably unable to reach the network or spawn a
 * process, and it must be honest about costing nothing.
 */

const CORRELATION_ID = '22222222-2222-5222-8222-222222222222';

describeRuntimeContract(({ artifactRoot }) => new LocalSimulatedRuntime({ root: artifactRoot }));

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'intelligenz-local-simulated-'));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function runtimeFor(overrides: Partial<LocalSimulatedRuntimeOptions> = {}): LocalSimulatedRuntime {
  return new LocalSimulatedRuntime({ root, stepDelayMs: 5, failurePermille: 0, ...overrides });
}

function request(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return ExecutionRequest.parse({
    taskId: 'task-local-1',
    goal: 'Summarise the readiness probe behaviour',
    allowedPaths: [join(root, 'org-1', 'task-local-1')],
    allowedActions: [],
    riskClass: 'MEDIUM',
    timeoutMs: 5_000,
    budgetUsd: 0,
    correlationId: CORRELATION_ID,
    ...overrides,
  });
}

describe('LocalSimulatedRuntime', () => {
  it('declares exactly the capabilities contract §8 and ADR-006 require', async () => {
    const runtime = runtimeFor();

    expect(runtime.id).toBe('local-simulated');
    await expect(runtime.capabilities()).resolves.toEqual({
      shell: false,
      network: false,
      filesystem: 'write',
      browser: false,
      mcp: false,
      imageInput: false,
    });
  });

  it('imports no network, process or DNS module — the declaration is structural', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/runtimes/local-simulated.ts', import.meta.url)),
      'utf8',
    );
    const forbidden = [
      "from 'node:http'",
      "from 'node:https'",
      "from 'node:net'",
      "from 'node:tls'",
      "from 'node:dns'",
      "from 'node:child_process'",
      "from 'node:worker_threads'",
      'fetch(',
      'execSync',
      'spawn(',
    ];

    for (const token of forbidden) {
      expect(source.includes(token), `local-simulated.ts must not contain ${token}`).toBe(false);
    }
  });

  it('reports itself as simulated in both health and every result', async () => {
    const runtime = runtimeFor();
    const health = await runtime.health();
    const result = await runtime.execute(request(), new AbortController().signal);

    expect(health.simulated).toBe(true);
    expect(health.status).toBe('ok');
    expect(result.simulated).toBe(true);
    expect(result.runtimeId).toBe('local-simulated');
  });

  it('writes a real artifact at <root>/<orgId>/<taskId>/result.md with a matching checksum', async () => {
    const runtime = runtimeFor();
    const result = await runtime.execute(request(), new AbortController().signal);

    expect(result.status).toBe('succeeded');

    const [artifact] = result.artifacts;
    expect(artifact).toBeDefined();
    expect(artifact?.kind).toBe('report');
    expect(artifact?.uri).toBe(join(root, 'org-1', 'task-local-1', 'result.md'));

    const bytes = await readFile(artifact!.uri, 'utf8');

    expect(bytes).toContain('# Simulated execution report');
    expect(bytes).toContain('task-local-1');
    // No timestamp in the report: the checksum must be stable across runs.
    expect(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(bytes)).toBe(false);
  });

  it('reports zero cost as a fact and plausible token counts', async () => {
    const runtime = runtimeFor();
    const result = await runtime.execute(request(), new AbortController().signal);

    expect(result.usage.usd).toBe(0);
    expect(result.usage.tokensIn).toBeGreaterThan(0);
    expect(result.usage.tokensOut).toBeGreaterThan(0);

    const bytes = await readFile(result.artifacts[0]!.uri, 'utf8');

    expect(bytes).toContain('USD 0.0000');
  });

  it('emits started, progress, artifact-written and finished in sequence order', async () => {
    const runtime = runtimeFor();
    const result = await runtime.execute(request(), new AbortController().signal);
    const types = result.events.map((event) => event.type);

    expect(types[0]).toBe('started');
    expect(types.at(-1)).toBe('finished');
    expect(types).toContain('progress');
    expect(types).toContain('artifact-written');
    expect(result.events.map((event) => event.seq)).toEqual(
      result.events.map((_, index) => index + 1),
    );
  });

  it('fails deterministically in the documented bucket and never invents an artifact', async () => {
    const runtime = runtimeFor({ stepDelayMs: 0, failurePermille: 150 });
    const { request: failingRequest, result: failing } = await findFailingExecution(runtime);

    expect(failing.status).toBe('failed');
    expect(failing.error?.code).toBe('SIMULATED_STEP_FAILED');
    expect(failing.error?.retryable).toBe(false);
    expect(failing.artifacts).toEqual([]);

    const repeat = await runtime.execute(failingRequest, new AbortController().signal);

    expect(repeat.status).toBe('failed');
    expect(repeat.error).toEqual(failing.error);
    expect(repeat.summary).toBe(failing.summary);
  });

  it('honours the documented goal markers without a restart', async () => {
    const runtime = runtimeFor({ stepDelayMs: 0 });

    const forced = await runtime.execute(
      request({ goal: 'Do the thing [simulate:fail]' }),
      new AbortController().signal,
    );
    expect(forced.status).toBe('failed');
    expect(forced.error?.code).toBe('SIMULATED_STEP_FAILED');

    const allowed = await runtime.execute(
      request({ taskId: 'bucket-probe-0', goal: 'Do the thing [simulate:ok]' }),
      new AbortController().signal,
    );
    expect(allowed.status).toBe('succeeded');
  });

  it('refuses to write outside the artifact root even if allowedPaths asks it to', async () => {
    const runtime = runtimeFor();

    await expect(
      runtime.execute(
        request({ allowedPaths: [resolve(root, '..', 'escaped')] }),
        new AbortController().signal,
      ),
    ).rejects.toBeInstanceOf(RuntimeConfigurationError);
  });

  it('cancel(taskId) aborts the in-flight execution for that task', async () => {
    const runtime = runtimeFor({ stepDelayMs: 500 });
    const req = request({ taskId: 'cancel-me', timeoutMs: 10_000 });

    const running = runtime.execute(req, new AbortController().signal);

    await new Promise((done) => setTimeout(done, 25));
    expect(runtime.inFlightCount()).toBe(1);

    await runtime.cancel('cancel-me');

    const result: ExecutionResult = await running;

    expect(result.status).toBe('cancelled');
    expect(result.artifacts).toEqual([]);
    expect(runtime.inFlightCount()).toBe(0);
  });

  it('treats cancelling an unknown task as a no-op', async () => {
    await expect(runtimeFor().cancel('never-started')).resolves.toBeUndefined();
  });

  it('returns timeout with a retryable error rather than throwing', async () => {
    const runtime = runtimeFor({ stepDelayMs: 60 });
    const result = await runtime.execute(request({ timeoutMs: 50 }), new AbortController().signal);

    expect(result.status).toBe('timeout');
    expect(result.error?.code).toBe('RUNTIME_TIMEOUT');
    expect(result.error?.retryable).toBe(true);
    expect(result.error?.message).toContain('50ms');
  });
});

/** Probes inputs until one lands in the ~15% bucket; the hash makes that repeatable. */
async function findFailingExecution(
  runtime: LocalSimulatedRuntime,
): Promise<{ request: ExecutionRequest; result: ExecutionResult }> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const candidate = request({
      taskId: 'bucket-probe-0',
      goal: `Contract suite request probe-${attempt}`,
    });
    const result = await runtime.execute(candidate, new AbortController().signal);

    if (result.status === 'failed') return { request: candidate, result };
  }

  throw new Error('No failing input found in 60 attempts — the bucket constant may be wrong.');
}
