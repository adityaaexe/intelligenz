import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';

import { RuntimeConfigurationError, RuntimeError } from '../errors';
import {
  ExecutionRequest,
  type ArtifactReference,
  type ExecutionEvent,
  type ExecutionResult,
  type RuntimeCapabilities,
  type RuntimeHealth,
  type AgentRuntime,
} from '../types';

/**
 * `LocalSimulatedRuntime` — **SIMULATED**. This is not a coding agent.
 *
 * It performs no network access, spawns no process, reads no repository and asks no
 * model anything. What it does is exercise the parts of the platform that a real
 * runtime would use: dispatch, an abort signal, a timeout budget, a real artifact
 * file, a SHA-256 checksum, token accounting, and a normalised result.
 *
 * A run executed by this adapter proves the **plumbing**. It proves nothing about
 * model quality, coding ability, or cost realism, and must never be described as a
 * working integration (contract §13, ADR-006).
 *
 * ## Determinism
 *
 * Every decision is derived from `sha256(taskId + "\0" + goal)`:
 *
 *   - step count, findings, summary text, token counts;
 *   - the ~15% failure bucket: `parseInt(hash[0..8], 16) % 1000 < 150`;
 *   - the artifact bytes, which contain no timestamp, so the checksum is stable.
 *
 * Two runs of the same task therefore produce the same summary and the same
 * checksum, which is what makes the failure path demonstrable and the idempotency
 * path testable. `events[].at` is the only non-deterministic field.
 *
 * ## Forcing the failure bucket
 *
 * The bucket is a hash, so it cannot be "turned off" without changing the task. Three
 * documented levers, in order of preference:
 *
 *   1. **Hash** (default). Pick any task; ~15% land in the bucket.
 *   2. **Goal marker.** A goal containing `[simulate:fail]` always fails,
 *      `[simulate:ok]` always succeeds. Per task, no restart, no global switch.
 *   3. **Environment.** `LOCAL_SIMULATED_OUTCOME=fail|succeed` overrides every run in
 *      the process. For test harnesses; never for a demo, because it hides the hash.
 *
 * ## Cost
 *
 * `usage.usd` is `0`, which is not a placeholder: the run genuinely spends nothing.
 * ADR-006's rule that a missing field is `undefined` and never `0` exists to stop a
 * *real* adapter from hiding unknown cost behind a zero. Here the zero is a measured
 * fact, and `undefined` would falsely mean "unknown".
 */

export interface LocalSimulatedRuntimeOptions {
  /**
   * Absolute path to the artifact root (`ARTIFACT_ROOT`, contract §15 A5). The
   * runtime writes only inside this directory — it is the containment boundary.
   */
  readonly root: string;
  /** Per-step delay. A real runtime's latency is not zero; this is the stand-in. */
  readonly stepDelayMs?: number;
  /** Overrides the hash-derived step count. Test seam. */
  readonly steps?: number;
  /** Failure bucket width in permille. 150 ≈ 15%. `0` disables it for tests. */
  readonly failurePermille?: number;
  /** Global outcome override. Defaults to `LOCAL_SIMULATED_OUTCOME` or `auto`. */
  readonly outcome?: 'auto' | 'succeed' | 'fail';
}

export const LOCAL_SIMULATED_ID = 'local-simulated';

const DEFAULT_STEP_DELAY_MS = 40;
const DEFAULT_FAILURE_PERMILLE = 150;
const FAILURE_MARKER = '[simulate:fail]';
const SUCCESS_MARKER = '[simulate:ok]';
const ARTIFACT_FILE = 'result.md';

/**
 * The declaration is a reviewed constant, not a probe: there is nothing to probe in
 * a simulated adapter. `filesystem: 'write'` is scoped to the artifact file — it is
 * not a general-purpose write capability on the host.
 */
const CAPABILITIES: RuntimeCapabilities = Object.freeze({
  shell: false,
  network: false,
  filesystem: 'write',
  browser: false,
  mcp: false,
  imageInput: false,
});

const FINDINGS = [
  'The request shape matches the port; no field was consumed speculatively.',
  'Artifact bytes were written before the result was returned, so a checksum always resolves.',
  'The abort signal was observed at every step boundary, not only at entry.',
  'Usage was reported as data, not as an enforcement decision.',
  'No tool was invoked: shell, network, browser and MCP are declared false and unused.',
  'The summary is a function of the task, so replaying it cannot invent a new outcome.',
] as const;

export class LocalSimulatedRuntime implements AgentRuntime {
  readonly id = LOCAL_SIMULATED_ID;

  readonly #root: string;
  readonly #stepDelayMs: number;
  readonly #stepsOverride: number | undefined;
  readonly #failurePermille: number;
  readonly #outcome: 'auto' | 'succeed' | 'fail';

  /** In-flight executions, so `cancel(taskId)` can reach one (contract §15 A4). */
  readonly #inFlight = new Map<string, AbortController>();

  constructor(options: LocalSimulatedRuntimeOptions) {
    if (options.root.trim().length === 0) {
      throw new RuntimeConfigurationError('LocalSimulatedRuntime requires an artifact root.');
    }

    this.#root = resolve(options.root);
    this.#stepDelayMs = options.stepDelayMs ?? DEFAULT_STEP_DELAY_MS;
    this.#stepsOverride = options.steps;
    this.#failurePermille = options.failurePermille ?? DEFAULT_FAILURE_PERMILLE;
    this.#outcome = options.outcome ?? readOutcomeFromEnv();
  }

  async capabilities(): Promise<RuntimeCapabilities> {
    return { ...CAPABILITIES };
  }

  async health(): Promise<RuntimeHealth> {
    const startedAt = Date.now();

    try {
      // Creating the root is idempotent and is the first thing `execute` would do, so
      // a health check that skipped it would report readiness the first run disproves.
      await mkdir(this.#root, { recursive: true });
      await access(this.#root, fsConstants.W_OK);

      return {
        status: 'ok',
        simulated: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        status: 'degraded',
        simulated: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - startedAt,
        detail: `artifact root is not writable: ${describeCause(error)}`,
      };
    }
  }

  async execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult> {
    const request = ExecutionRequest.parse(req);
    const digest = sha256(`${request.taskId}\u0000${request.goal}`);
    const steps = this.#stepsOverride ?? 2 + (hexByte(digest, 0) % 3);
    const shouldFail = this.#decideFailure(request.goal, digest);
    const tokensIn = 700 + hexByte(digest, 2) * 3;
    const tokensOut = 180 + hexByte(digest, 3) * 2;

    const events: ExecutionEvent[] = [];
    const startedAt = Date.now();
    let seq = 0;

    const emit = (
      type: ExecutionEvent['type'],
      message: string,
      data?: Record<string, unknown>,
    ): void => {
      seq += 1;
      events.push({
        seq,
        type,
        at: new Date().toISOString(),
        message,
        ...(data === undefined ? {} : { data }),
      });
    };

    const finish = (
      status: ExecutionResult['status'],
      summary: string,
      artifacts: ArtifactReference[],
      error?: ExecutionResult['error'],
    ): ExecutionResult => ({
      status,
      summary,
      artifacts,
      events,
      usage: { tokensIn, tokensOut, usd: 0 },
      ...(error === undefined ? {} : { error }),
      runtimeId: this.id,
      simulated: true,
    });

    emit('started', `Simulated execution started for task ${request.taskId}.`, {
      steps,
      riskClass: request.riskClass,
      simulated: true,
    });

    // The external signal is chained to an internal controller so that both
    // `signal.abort()` (Temporal cancellation) and `cancel(taskId)` converge on one
    // code path. Registering it first means a cancellation that arrives before the
    // first step is not lost.
    const controller = new AbortController();
    const abortFromCaller = (): void => controller.abort(signal.reason);
    if (signal.aborted) abortFromCaller();
    else signal.addEventListener('abort', abortFromCaller, { once: true });

    this.#inFlight.set(request.taskId, controller);

    const cancelled = (): ExecutionResult => {
      emit('finished', 'Execution cancelled by its caller; no artifact was written.');
      return finish('cancelled', `Cancelled before completion: ${request.goal}`, [], {
        code: 'RUNTIME_CANCELLED',
        message: 'The execution was aborted by the caller.',
        retryable: true,
      });
    };

    const timedOut = (): ExecutionResult => {
      emit('finished', `Execution exceeded its ${request.timeoutMs}ms budget.`);
      return finish('timeout', `Timed out after ${request.timeoutMs}ms: ${request.goal}`, [], {
        code: 'RUNTIME_TIMEOUT',
        message: `The execution exceeded its ${request.timeoutMs}ms budget.`,
        // Retryable: a timeout is a statement about this attempt, not about the task.
        retryable: true,
      });
    };

    try {
      for (let step = 1; step <= steps; step += 1) {
        if (controller.signal.aborted) return cancelled();
        if (Date.now() - startedAt >= request.timeoutMs) return timedOut();

        emit('progress', `Step ${step} of ${steps} complete.`, { step, steps });

        const completed = await sleep(this.#stepDelayMs, controller.signal);
        if (!completed) return cancelled();
      }

      if (controller.signal.aborted) return cancelled();
      if (Date.now() - startedAt >= request.timeoutMs) return timedOut();

      if (shouldFail) {
        // A deterministic rejection, so `retryable: false`: Temporal must not spend a
        // second attempt on an outcome that is a function of the input.
        const error = {
          code: 'SIMULATED_STEP_FAILED',
          message: `Simulated failure bucket hit for task ${request.taskId} (deterministic).`,
          retryable: false,
        };

        emit('finished', 'Simulated execution failed in its deterministic failure bucket.', {
          code: error.code,
        });

        return finish('failed', `Simulated failure for "${request.goal}" (bucket hit).`, [], error);
      }

      const body = renderReport({
        taskId: request.taskId,
        goal: request.goal,
        correlationId: request.correlationId,
        riskClass: request.riskClass,
        steps,
        digest,
        tokensIn,
        tokensOut,
      });

      const artifact = await this.#writeArtifact(request, body);

      emit('artifact-written', `Wrote ${ARTIFACT_FILE}.`, {
        uri: artifact.uri,
        checksum: artifact.checksum,
        sizeBytes: artifact.sizeBytes,
      });

      const summary = summarize(request.goal, steps, artifact);
      emit('finished', 'Simulated execution completed.', { status: 'succeeded' });

      return finish('succeeded', summary, [artifact]);
    } catch (error) {
      if (error instanceof RuntimeError) throw error;

      emit('finished', 'Simulated execution crashed.');
      return finish('failed', `Simulated execution crashed: ${describeCause(error)}`, [], {
        code: 'SIMULATED_RUNTIME_CRASH',
        message: describeCause(error),
        retryable: true,
      });
    } finally {
      signal.removeEventListener('abort', abortFromCaller);
      if (this.#inFlight.get(request.taskId) === controller) {
        this.#inFlight.delete(request.taskId);
      }
    }
  }

  /**
   * Contract §15 A4. Aborts the in-flight execution for `taskId`, if any.
   *
   * A missing execution is **not** an error: cancellation is idempotent and racy by
   * nature, and a caller that cancels a task that just finished has not done anything
   * wrong.
   */
  async cancel(taskId: string): Promise<void> {
    this.#inFlight.get(taskId)?.abort(new Error(`cancelled: ${taskId}`));
  }

  /** Test seam: how many executions this instance believes are running. */
  inFlightCount(): number {
    return this.#inFlight.size;
  }

  #decideFailure(goal: string, digest: string): boolean {
    if (this.#outcome === 'fail') return true;
    if (this.#outcome === 'succeed') return false;
    if (goal.includes(FAILURE_MARKER)) return true;
    if (goal.includes(SUCCESS_MARKER)) return false;

    return hexModulo(digest, 0, 1000) < this.#failurePermille;
  }

  async #writeArtifact(request: ExecutionRequest, body: string): Promise<ArtifactReference> {
    const directory = this.#artifactDirectory(request);
    const uri = join(directory, ARTIFACT_FILE);
    const bytes = Buffer.from(body, 'utf8');

    try {
      await mkdir(directory, { recursive: true });
      await writeFile(uri, bytes);
    } catch (error) {
      throw new RuntimeConfigurationError(
        `Could not write the artifact to "${uri}": ${describeCause(error)}`,
        error,
      );
    }

    return {
      kind: 'report',
      uri,
      checksum: sha256(bytes),
      sizeBytes: bytes.byteLength,
      mediaType: 'text/markdown; charset=utf-8',
    };
  }

  /**
   * The caller owns the layout: `allowedPaths[0]` is where the artifact goes, which
   * is how the tenant-scoped `<root>/<orgId>/<taskId>` structure is built without the
   * port needing an `orgId` field it never had (contract §8).
   *
   * Whatever the caller asks for is still confined to the root. `allowedPaths` is
   * advisory in general (no sandbox exists), but the *writer* can and must refuse to
   * escape its own directory — that one is enforceable here.
   */
  #artifactDirectory(request: ExecutionRequest): string {
    const [candidate] = request.allowedPaths;

    if (candidate === undefined || candidate.length === 0) {
      return join(this.#root, safeSegment(request.taskId));
    }

    const target = isAbsolute(candidate) ? resolve(candidate) : resolve(this.#root, candidate);
    const offset = relative(this.#root, target);

    if (offset.startsWith('..') || isAbsolute(offset)) {
      throw new RuntimeConfigurationError(
        `Refusing to write outside the artifact root: "${candidate}" resolves to "${target}".`,
      );
    }

    return target;
  }
}

/** UUID-ish ids are expected; a separator would let a caller climb a directory. */
function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new RuntimeConfigurationError(`Unsafe path segment: "${value}".`);
  }

  return value;
}

function renderReport(input: {
  taskId: string;
  goal: string;
  correlationId: string;
  riskClass: string;
  steps: number;
  digest: string;
  tokensIn: number;
  tokensOut: number;
}): string {
  const findings = pickFindings(input.digest);

  return [
    '# Simulated execution report',
    '',
    '> **Simulated.** Produced by `local-simulated`. No model was called, no network',
    '> request was made, no process was spawned, and no repository was read. This file',
    '> proves the artifact path, not the work.',
    '',
    `- task: \`${input.taskId}\``,
    `- runtime: \`${LOCAL_SIMULATED_ID}\` (simulated)`,
    `- risk class: ${input.riskClass}`,
    `- correlation: \`${input.correlationId}\``,
    `- steps: ${input.steps}`,
    `- seed: \`${input.digest.slice(0, 12)}\``,
    '',
    '## Goal',
    '',
    input.goal,
    '',
    '## Findings',
    '',
    ...findings.map((finding) => `- ${finding}`),
    '',
    '## Usage',
    '',
    `- tokens in: ${input.tokensIn}`,
    `- tokens out: ${input.tokensOut}`,
    '- cost: USD 0.0000 — a simulated run spends nothing, which is a fact, not an estimate',
    '',
  ].join('\n');
}

function summarize(goal: string, steps: number, artifact: ArtifactReference): string {
  return [
    `Simulated ${steps}-step run completed for "${goal}".`,
    `Wrote ${ARTIFACT_FILE} (${artifact.sizeBytes} bytes, sha256 ${artifact.checksum.slice(0, 12)}…).`,
    'No external tools were used; the runtime is local-simulated.',
  ].join(' ');
}

function pickFindings(digest: string): string[] {
  const first = hexByte(digest, 4) % FINDINGS.length;
  const second = hexByte(digest, 5) % FINDINGS.length;
  const chosen = new Set<string>([FINDINGS[first]!, FINDINGS[second]!, FINDINGS[3]!]);

  return [...chosen];
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function hexByte(digest: string, index: number): number {
  return Number.parseInt(digest.slice(index * 2, index * 2 + 2), 16);
}

function hexModulo(digest: string, index: number, modulo: number): number {
  return Number.parseInt(digest.slice(index * 2, index * 2 + 8), 16) % modulo;
}

function readOutcomeFromEnv(): 'auto' | 'succeed' | 'fail' {
  const raw = process.env['LOCAL_SIMULATED_OUTCOME']?.trim().toLowerCase();

  if (raw === 'fail' || raw === 'succeed') return raw;

  return 'auto';
}

function describeCause(error: unknown): string {
  if (error instanceof Error) return error.message;

  return String(error);
}

/**
 * Resolves `true` if the full delay elapsed, `false` if the signal fired first.
 * Rejects nothing: an abort is a result, and a thrown exception here would have to
 * be caught and turned back into one.
 */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  if (ms <= 0) return Promise.resolve(true);

  return new Promise<boolean>((resolveDelay) => {
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveDelay(false);
    };

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveDelay(true);
    }, ms);

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
