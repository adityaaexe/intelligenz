import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ArtifactReference,
  ExecutionRequest,
  ExecutionResult,
  RuntimeCapabilities,
  RuntimeHealth,
  type AgentRuntime,
} from '../src';

/**
 * The runtime contract suite — reusable by **any** future adapter.
 *
 * Contract §8 describes a port; ADR-006 notes the honest problem with it: one
 * implementation means a suite "tests the implementation, not the contract". This
 * file is the mitigation. It is exported from the package as
 * `@intelligenz/agent-runtime/testing` so a real adapter is validated against the
 * same eight assertions rather than against its own author's optimism.
 *
 * ## Assumptions the suite cannot avoid
 *
 * 1. **Time.** The timeout test passes `timeoutMs: 1`. An adapter that completes real
 *    work in under a millisecond cannot be distinguished from one that ignores the
 *    budget. Override `timeoutProbeMs` if an adapter is that fast.
 * 2. **Artifacts are files.** `uri` is resolved with `readFile` by default. An adapter
 *    whose artifacts live in a remote store must supply `resolveArtifact`.
 * 3. **Determinism.** `deterministic: false` skips the last test, and a skipped test
 *    is visible in the report rather than silently green. An LLM-backed adapter
 *    cannot pass it, and pretending otherwise is the dishonesty ADR-006 warns about.
 */

export interface RuntimeContractContext {
  /** Absolute directory the adapter may write artifacts into. */
  readonly artifactRoot: string;
}

export type RuntimeContractFactory = (
  context: RuntimeContractContext,
) => AgentRuntime | Promise<AgentRuntime>;

export interface RuntimeContractOptions {
  /** Default `1`. See the time assumption above. */
  readonly timeoutProbeMs?: number;
  /** Default `true`. Set `false` for a non-deterministic (model-backed) adapter. */
  readonly deterministic?: boolean;
  /** Default `readFile`. Supply this if `uri` is not a local path. */
  readonly resolveArtifact?: (uri: string) => Promise<Buffer>;
  /** Extra fields merged into every request the suite issues. */
  readonly request?: Partial<ExecutionRequest>;
}

const CORRELATION_ID = '11111111-1111-5111-8111-111111111111';
const STATUSES = ['succeeded', 'failed', 'timeout', 'cancelled'] as const;

export function describeRuntimeContract(
  factory: RuntimeContractFactory,
  options: RuntimeContractOptions = {},
): void {
  const timeoutProbeMs = options.timeoutProbeMs ?? 1;
  const deterministic = options.deterministic ?? true;
  const resolveArtifact = options.resolveArtifact ?? ((uri: string) => readFile(uri));

  describe('runtime contract', () => {
    let runtime: AgentRuntime;
    let artifactRoot: string;

    const requestFor = (
      suffix: string,
      overrides: Partial<ExecutionRequest> = {},
    ): ExecutionRequest =>
      ExecutionRequest.parse({
        taskId: `contract-task-${suffix}`,
        goal: `Contract suite request ${suffix}`,
        allowedPaths: [join(artifactRoot, 'contract', suffix)],
        allowedActions: [],
        riskClass: 'LOW',
        timeoutMs: 30_000,
        budgetUsd: 0,
        correlationId: CORRELATION_ID,
        ...options.request,
        ...overrides,
      });

    beforeAll(async () => {
      artifactRoot = await mkdtemp(join(tmpdir(), 'intelligenz-runtime-contract-'));
      runtime = await factory({ artifactRoot });
    });

    afterAll(async () => {
      await rm(artifactRoot, { recursive: true, force: true });
    });

    it('1. declares a well-formed capability object', async () => {
      const capabilities = await runtime.capabilities();
      const parsed = RuntimeCapabilities.safeParse(capabilities);

      if (!parsed.success) expect.fail(JSON.stringify(parsed.error.issues));

      expect(typeof runtime.id).toBe('string');
      expect(runtime.id.length).toBeGreaterThan(0);
    });

    it('2. reports health with a status from the allowed union', async () => {
      const health = await runtime.health();
      const parsed = RuntimeHealth.safeParse(health);

      if (!parsed.success) expect.fail(JSON.stringify(parsed.error.issues));

      expect(['ok', 'degraded', 'down']).toContain(health.status);
      // ADR-006: a simulated adapter must say so. A real one must not claim otherwise.
      expect(typeof health.simulated).toBe('boolean');
    });

    it('3. resolves execute() with a status from the allowed union', async () => {
      const result = await runtime.execute(requestFor('status'), new AbortController().signal);
      const parsed = ExecutionResult.safeParse(result);

      if (!parsed.success) expect.fail(JSON.stringify(parsed.error.issues));

      expect(STATUSES).toContain(result.status);
    });

    it('4. always returns a summary and usage', async () => {
      const result = await runtime.execute(requestFor('summary'), new AbortController().signal);

      expect(typeof result.summary).toBe('string');
      expect(result.summary.trim().length).toBeGreaterThan(0);
      expect(result.usage).toBeTypeOf('object');
      expect(result.usage).not.toBeNull();

      // A non-succeeded result must explain itself; a succeeded one must not invent an error.
      if (result.status === 'failed' || result.status === 'timeout') {
        expect(result.error, 'a non-succeeded result must explain itself').toBeDefined();
        expect(typeof result.error?.code).toBe('string');
        expect(typeof result.error?.retryable).toBe('boolean');
      }
    });

    it('5. returns cancelled for an aborted signal instead of throwing', async () => {
      const controller = new AbortController();
      controller.abort(new Error('contract suite abort'));

      const result = await runtime.execute(requestFor('abort'), controller.signal);

      expect(result.status).toBe('cancelled');
      expect(ExecutionResult.safeParse(result).success).toBe(true);
    });

    it('6. returns timeout with a retryable error when the budget is exceeded', async () => {
      const result = await runtime.execute(
        requestFor('timeout', { timeoutMs: timeoutProbeMs }),
        new AbortController().signal,
      );

      expect(result.status).toBe('timeout');
      expect(result.error?.retryable).toBe(true);
    });

    it('7. returns artifact references that resolve to files with matching checksums', async () => {
      const { result } = await findSucceedingExecution(runtime, requestFor);

      expect(result.artifacts.length, 'a succeeded run must produce evidence').toBeGreaterThan(0);

      for (const artifact of result.artifacts) {
        const parsed = ArtifactReference.safeParse(artifact);
        if (!parsed.success) expect.fail(JSON.stringify(parsed.error.issues));

        expect(artifact.kind.length).toBeGreaterThan(0);

        const bytes = await resolveArtifact(artifact.uri);

        expect(bytes.byteLength).toBe(artifact.sizeBytes);
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.checksum);
      }
    });

    it.runIf(deterministic)(
      '8. is deterministic: the same taskId twice yields the same summary and checksums',
      async () => {
        const { request } = await findSucceedingExecution(runtime, requestFor);

        const first = await runtime.execute(request, new AbortController().signal);
        const second = await runtime.execute(request, new AbortController().signal);

        expect(first.status).toBe('succeeded');
        expect(second.status).toBe('succeeded');
        expect(second.summary).toBe(first.summary);
        expect(second.artifacts.map((artifact) => artifact.checksum)).toEqual(
          first.artifacts.map((artifact) => artifact.checksum),
        );
      },
    );
  });
}

/**
 * A failing run is a legitimate outcome — ~15% of inputs for the simulated adapter —
 * so the suite cannot assume its first input succeeds. It probes a handful and fails
 * with a clear message rather than an index error if none of them produce evidence.
 */
async function findSucceedingExecution(
  runtime: AgentRuntime,
  requestFor: (suffix: string, overrides?: Partial<ExecutionRequest>) => ExecutionRequest,
): Promise<{ request: ExecutionRequest; result: ExecutionResult }> {
  let last: ExecutionResult | undefined;

  for (let attempt = 0; attempt < 6; attempt += 1) {
    const request = requestFor(`probe-${attempt}`);
    const result = await runtime.execute(request, new AbortController().signal);

    if (result.status === 'succeeded') return { request, result };

    last = result;
  }

  throw new Error(
    `The adapter produced no succeeded execution in 6 attempts (last status: ${
      last?.status ?? 'none'
    }). The contract suite cannot verify artifacts without one.`,
  );
}
