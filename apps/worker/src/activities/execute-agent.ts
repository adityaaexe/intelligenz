import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cancellationSignal } from '@temporalio/activity';
import {
  ExecutionRequest,
  ExecutionResult,
  LOCAL_SIMULATED_ID,
  RuntimeResultError,
  missingCapabilities,
  toExecutionError,
} from '@intelligenz/agent-runtime';

import { getWorkerConfig } from '../config';
import {
  applyLimits,
  createCgroup,
  killCgroup,
  readUsage,
  removeCgroup,
  type CgroupHandle,
  type CgroupUsage,
  type EffectiveLimits,
} from '../cgroup';
import {
  assertProfileAvailable,
  cpuCeilingFor,
  executionProfileLabel,
  selectResourceProfile,
  type ResourceProfile,
} from '../resource-profiles';
import { getCgroupCapability, type CgroupMode } from '../capabilities';
import { getAgentRuntime, runtimeRequiresWorkspace } from '../runtime';
import type { ExecuteAgentActivityInput, ExecuteAgentActivityResult } from '../shared/contracts';
import { classifyTermination, type TerminationReason } from '../termination';
import { materializeArtifacts } from './artifacts';
import {
  RUN_STATUS,
  finalizeAttempt,
  markAttemptCleanupState,
  resolveWorkflowRun,
  startAttempt,
} from './attempts';
import { executionWorkspaceIdFor } from './ids';
import { workerIdentity } from '../identity';
import { workerLogger } from '../log';
import { db, nonRetryable, retryable } from './support';
import {
  leaseWorkspace,
  markExecuting,
  markPreserving,
  releaseWorkspace,
  startWorkspaceHeartbeat,
  workspaceArtifactsDirectory,
  type WorkspaceLease,
  type WorkspaceOutcome,
} from './workspace';

/**
 * `executeAgentActivity` — contract §16.
 *
 * **The only place the runtime is touched.** The workflow calls this activity by name
 * and knows nothing about adapters, capabilities, abort signals or vendor quirks. A
 * real runtime arrives by changing `AGENT_RUNTIME`, not this activity's contract.
 *
 * ## What this activity owns (Phase 3)
 *
 * 1. **Runtime selection** — `local-simulated` unless the deployment opted in.
 * 2. **Attempt identity** — one `ExecutionAttempt` per invocation, numbered per
 *    workflow run. A retry is a new attempt, never a silent second run under the
 *    first one's id.
 * 3. **Workspace lifecycle** — for adapters that need a filesystem: request,
 *    provision, execute, preserve, complete. The checkout is disposed; the artifacts
 *    are not.
 * 4. **The capability gate** (ADR-006) — checked before any work, so a task that
 *    needs a shell is refused up front rather than half-finished.
 * 5. **Cancellation plumbing** — Temporal's `cancellationSignal()` is chained into
 *    the `AbortSignal` the port requires, and `runtime.cancel(taskId)` converges on
 *    the same path. The adapter kills its process group; this activity records the
 *    workspace as `cancelled`.
 * 6. **Normalisation** — a thrown `retryable` error becomes a Temporal retry; a
 *    non-retryable one becomes a `failed` result the workflow can persist as an
 *    outcome.
 *
 * ## Ordering that matters
 *
 * The attempt row is written **before** provisioning. A workspace that failed to
 * provision must still be attributable to an attempt; the alternative is a failure
 * with no row, which is the same gap Phase 2 had.
 *
 * ## Fault injection (dev only)
 *
 * `WORKER_FAULT_INJECT=execute-once` makes the **first** attempt throw a retryable
 * error. The "first" is claimed with an exclusive marker file under
 * `<ARTIFACT_ROOT>/.fault-injection/`, so it survives an activity retry in another
 * process and can never fire twice. It exists to prove that Temporal retried; it is
 * inert unless the variable is set.
 */

/**
 * Kept under the executor activity's 4m `startToCloseTimeout` so the adapter's own
 * timeout is what reports the reason. The default `AGENT_TIMEOUT_MS` is 50s — plenty
 * for the simulated adapter, and an operator running a real agent raises it.
 */
const MAX_AGENT_TIMEOUT_MS = 230_000;

export async function executeAgentActivity(
  input: ExecuteAgentActivityInput,
): Promise<ExecuteAgentActivityResult> {
  const config = getWorkerConfig();
  const runtime = getAgentRuntime(config);
  const simulatedAdapter = runtime.id === LOCAL_SIMULATED_ID;

  const task = await db().task.findFirst({
    // Tenant scoping.
    where: { id: input.taskId, orgId: input.orgId },
    select: { id: true, goal: true, riskClass: true, status: true, projectId: true },
  });

  if (task === null) {
    throw nonRetryable('TASK_NOT_FOUND', `Task ${input.taskId} does not exist in this org.`);
  }

  // ── Resource policy, resolved before anything runs ────────────────────────────
  //
  // Three decisions, in this order, and none of them is the agent's:
  //   1. is cgroup isolation real on this host right now (probed once per process);
  //   2. which profile does the server's policy pick for this task;
  //   3. is that profile allowed to run without cgroups (HEAVY is not).
  //
  // A refusal here is a `nonRetryable` failure: retrying cannot make a HEAVY profile
  // safe on a host with no aggregate limit.
  const capability = await getCgroupCapability({ root: config.resources.cgroupRoot });
  const cgroupMode: CgroupMode = capability.mode;

  const selection = selectResourceProfile({
    riskClass: task.riskClass,
    realRuntime: !simulatedAdapter,
    configured: config.resources.profile,
  });

  const profile: ResourceProfile = selection.profile;

  try {
    assertProfileAvailable(profile, cgroupMode);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    // No attempt row: nothing ran, and an attempt row for a run that was never started
    // would be an attempt that claims to have tried.
    throw nonRetryable('RESOURCE_PROFILE_UNAVAILABLE', message);
  }

  const profileLabel = executionProfileLabel(profile, cgroupMode);

  /**
   * The wall clock this attempt is actually allowed: the profile's, the deployment's
   * `AGENT_TIMEOUT_MS`, and the activity's own deadline, whichever is smallest. The
   * profile is a ceiling, never an extension — a profile that asked for more than the
   * activity's deadline would just lose the reason to a Temporal timeout.
   */
  const wallClockMs = Math.min(profile.wallClockMs, config.runtime.timeoutMs, MAX_AGENT_TIMEOUT_MS);

  /**
   * The per-attempt spend cap: `min(profile, deployment)`. The deployment cap cannot be
   * raised by a profile, and a profile cannot be raised by the agent.
   */
  const maxUsd = Math.min(profile.usdCapUsd, config.execution.maxUsd);

  const workflowRun = await resolveWorkflowRun({
    orgId: input.orgId,
    taskId: input.taskId,
    workflowRunId: input.workflowRunId,
  });

  const attempt = await startAttempt({
    orgId: input.orgId,
    taskId: input.taskId,
    workflowRunId: workflowRun.id,
    runtimeId: runtime.id,
    // Provisional. A result replaces this with the adapter's own report; a thrown
    // error has no result, and then the adapter's nature is the only honest value.
    simulated: simulatedAdapter,
    startedAt: new Date(),
  });

  let lease: WorkspaceLease | undefined;
  let workspaceOutcome: WorkspaceOutcome | undefined;
  let attemptFinalized = false;
  let attemptError: unknown;

  // ── Per-attempt enforcement state ─────────────────────────────────────────────
  // `cgroup` is created after the lease (the cgroup is named after the workspace) and
  // removed in `finally`. `usage` is read once the process tree is gone; every value
  // written to `ExecutionAttempt` comes from those files, never from an intention.
  let cgroup: CgroupHandle | undefined;
  let effectiveLimits: EffectiveLimits | undefined;
  let usage: CgroupUsage | null = null;
  let placementFailed = false;

  async function finalize(
    status: ExecutionResult['status'],
    simulated: boolean,
    error?: ExecutionResult['error'],
    termination: TerminationReason = 'workspace_error',
  ): Promise<void> {
    if (attemptFinalized) return;
    attemptFinalized = true;

    await finalizeAttempt({
      orgId: input.orgId,
      attemptId: attempt.id,
      status: RUN_STATUS[status],
      simulated,
      ...(error === undefined ? {} : { error }),
      resources: {
        executionProfile: profileLabel,
        cpuTimeMs: usage?.cpuTimeMs ?? null,
        memoryPeakBytes: usage?.memoryPeakBytes ?? null,
        pidsPeak: usage?.pidsPeak ?? null,
        terminationReason: termination,
      },
    });
  }

  if (task.status === 'cancelled') {
    // A cancellation that reached the database before this activity was scheduled.
    const result = bannerResult(runtime.id, {
      status: 'cancelled',
      summary: 'Cancelled before execution started.',
      error: {
        code: 'RUNTIME_CANCELLED',
        message: 'The task was cancelled before execution started.',
        retryable: false,
      },
      simulated: simulatedAdapter,
    });

    await finalize('cancelled', simulatedAdapter, result.error, 'cancelled');

    return result;
  }

  const capabilities = await runtime.capabilities();
  const missing = missingCapabilities(capabilities, requiredActionsFor());

  if (missing.length > 0) {
    const error = {
      code: 'RUNTIME_CAPABILITY_MISSING',
      message: `Runtime "${runtime.id}" cannot satisfy this task: missing ${missing.join(', ')}.`,
      retryable: false,
    };

    await finalize('failed', simulatedAdapter, error, 'workspace_error');
    throw nonRetryable(error.code, error.message);
  }

  if (config.faultInjection.failExecuteOnce) {
    const claimed = await claimOnceMarker(config.artifactRoot, `execute-${input.taskId}`);

    if (claimed) {
      const error = {
        code: 'INJECTED_TRANSIENT_FAILURE',
        message: `Injected first-attempt failure for task ${input.taskId} (WORKER_FAULT_INJECT=execute-once).`,
        retryable: true,
      };

      await finalize('failed', simulatedAdapter, error, 'crashed');
      throw retryable(error.code, error.message);
    }
  }

  const controller = new AbortController();
  // `cancellationSignal()` throws outside an activity context (a direct call from a
  // test or an operational script). An absent context means there is nothing to
  // cancel, not that cancellation is unsupported: inside a worker the context always
  // exists, and this is the only place the signal is read.
  const activityCancellation = safeCancellationSignal();

  const abort = (): void => {
    controller.abort(activityCancellation.reason);
    // Converges on the port's own cancel path, so an adapter that tracks executions by
    // task id cleans up exactly as it would for a direct `cancel()` call.
    void runtime.cancel(task.id);
  };

  if (activityCancellation.aborted) abort();
  else activityCancellation.addEventListener('abort', abort, { once: true });

  let stopHeartbeat: (() => void) | undefined;

  try {
    if (runtimeRequiresWorkspace(runtime.id)) {
      const workspaceId = executionWorkspaceIdFor(workflowRun.id, attempt.attemptNumber);

      const leased = await leaseWorkspace({
        orgId: input.orgId,
        taskId: input.taskId,
        workflowRunId: workflowRun.id,
        attemptNumber: attempt.attemptNumber,
        workspaceId,
        config,
        owner: workerIdentity(),
        // 2 × wall clock: one full wall clock of silence is a healthy run, two is not.
        leaseMs: wallClockMs * 2,
      });

      if (!leased.ok) {
        const error = {
          code: 'WORKSPACE_PROVISION_FAILED',
          message: `Workspace provisioning failed at "${leased.failure.stage}": ${leased.failure.message}`,
          retryable: false,
        };

        // No `AgentRun` is written for this: nothing executed, and a row claiming a
        // model produced a result would be the lie ADR-006 forbids. The attempt and
        // the workspace row carry the reason instead.
        await finalize('failed', simulatedAdapter, error, 'workspace_error');
        throw nonRetryable(error.code, error.message);
      }

      lease = leased.lease;

      // ── Enforce, before the process exists ────────────────────────────────────
      //
      // The cgroup is created and its limits written *before* the adapter is called, so
      // the first process of the run is already bounded. It is named after the
      // workspace rather than the attempt because the workspace id is what the reaper
      // holds when it has to kill a tree whose attempt belongs to a dead process; the
      // two ids are derived from the same `(workflowRunId, attemptNumber)` pair, so the
      // mapping is 1:1 by construction (`activities/ids.ts`).
      if (cgroupMode === 'enforced') {
        cgroup = await createCgroup(config.resources.cgroupRoot, workspaceId);

        effectiveLimits = await applyLimits(cgroup, {
          memoryMaxBytes: profile.memoryMaxBytes,
          swapMaxBytes: 0,
          pidsMax: profile.pidsMax,
          cpuQuotaMicros: profile.cpuQuotaMicros,
          cpuPeriodMicros: profile.cpuPeriodMicros,
        });
      }

      stopHeartbeat = startWorkspaceHeartbeat({
        orgId: input.orgId,
        workspaceId,
        owner: workerIdentity(),
        leaseMs: wallClockMs * 2,
      });

      await markExecuting(lease, input.orgId);
    }

    const request = ExecutionRequest.parse({
      taskId: task.id,
      goal: task.goal,
      // The caller owns the layout. A real run is confined to its lease; a simulated
      // one writes into the tenant-scoped artifact directory (Phase 2 behaviour).
      allowedPaths:
        lease === undefined
          ? [join(config.artifactRoot, safeSegment(input.orgId), safeSegment(task.id))]
          : [join(lease.handle.rootPath, 'repo')],
      allowedActions: [],
      riskClass: task.riskClass,
      timeoutMs: wallClockMs,
      // Contract §15 A7: recorded, never enforced by the port. The adapter's own
      // `maxUsd` is a separate, real cap.
      budgetUsd: config.runtime.budgetUsd,
      correlationId: input.correlationId,
      ...(lease === undefined ? {} : { workspaceRoot: lease.handle.rootPath }),
      // Placement is a path, not a policy: absent means the capability probe reported
      // that cgroups are unavailable, and the attempt is recorded as `rlimit-only`.
      ...(cgroup === undefined ? {} : { cgroupProcsPath: cgroup.path }),
      // The profile's spend ceiling, floored by the deployment's. A real adapter reads
      // this as a hard cap; a simulated one ignores it because it spends nothing.
      maxUsd,
    });

    const raw = await runtime.execute(request, controller.signal);
    const parsed = ExecutionResult.safeParse(raw);

    if (!parsed.success) {
      throw new RuntimeResultError(runtime.id, parsed.error.message);
    }

    // ADR-006's flag must not be forgeable at the seam. A simulated adapter claiming a
    // real run is the one combination that would relabel history as work that never
    // happened; the persistence layer rejects it too, and this is the cheaper refusal.
    if (parsed.data.runtimeId === LOCAL_SIMULATED_ID && parsed.data.simulated === false) {
      const error = {
        code: 'SIMULATED_FLAG_INCONSISTENT',
        message: 'A local-simulated result reported simulated=false.',
        retryable: false,
      };

      await finalize('failed', true, error);
      throw nonRetryable(error.code, error.message);
    }

    let result: ExecutionResult = parsed.data;

    // The sandbox refuses to start when it cannot join its cgroup (exit 97 in
    // `runInProcessGroup`). That is not an agent failure, and the attempt must say so.
    if (result.error?.code === 'CGROUP_PLACEMENT_FAILED') {
      placementFailed = true;
    }

    if (lease !== undefined) {
      // `preserving` is entered before any byte is copied: a crash here must leave the
      // workspace in a state that says "evidence may be mid-write", not `executing`.
      await markPreserving(lease, input.orgId);

      const materialized = await materializeArtifacts({
        artifactsDirectory: workspaceArtifactsDirectory(lease.handle),
        artifacts: result.artifacts,
      });

      result = {
        ...result,
        artifacts: materialized.artifacts,
        providerMeta: {
          ...result.providerMeta,
          workspaceId: lease.id,
          ...(materialized.missing.length === 0 ? {} : { artifactMissing: materialized.missing }),
          ...(materialized.transcriptPath === null ? { transcriptMissing: true } : {}),
        },
      };
    }

    // ── Accounting, then the verdict ─────────────────────────────────────────────
    //
    // The numbers come from the cgroup files after the tree is gone: `memory.peak`,
    // `pids.peak`, `cpu.stat usage_usec`. They are what the attempt used, not what the
    // profile allowed — and both are recorded (the profile on `executionProfile`, the
    // limits in the attempt log) so "enforced" is auditable afterwards.
    if (cgroup !== undefined) {
      usage = await readUsage(cgroup);
    }

    const verdict = classifyTermination({
      adapter: result.status,
      usage,
      cpuCeilingUs: cpuCeilingFor(profile),
      placementFailed,
    });

    if (verdict.resourceKill && cgroup !== undefined) {
      // The kernel already killed on OOM; `cgroup.kill` is the backstop that guarantees
      // nothing survived the breach (a child that ignored the memory event, a sister
      // process still holding a socket). Killing an already-empty cgroup is a no-op.
      await killCgroup(cgroup);
      logResourceKill(
        runtime.id,
        input.taskId,
        verdict.reason,
        usage,
        effectiveLimits,
        cgroup.path,
      );
    }

    // The platform's record and the adapter's report must agree. A resource kill the
    // adapter described as "failed" stays failed; one it described as "succeeded" is
    // corrected, with the reason attached, because a run that lost a process to the
    // kernel did not succeed.
    const finalStatus: ExecutionResult['status'] = verdict.overridesAdapter
      ? verdict.reason === 'cancelled'
        ? 'cancelled'
        : verdict.reason === 'timeout'
          ? 'timeout'
          : 'failed'
      : result.status;

    const finalError = verdict.overridesAdapter
      ? resourceKillError(verdict.reason, usage, effectiveLimits)
      : result.error;

    await finalize(finalStatus, result.simulated, finalError, verdict.reason);

    workspaceOutcome =
      finalStatus === 'succeeded'
        ? 'completed'
        : finalStatus === 'cancelled'
          ? 'cancelled'
          : 'failed';

    return verdict.overridesAdapter
      ? {
          ...result,
          status: finalStatus,
          summary: resourceKillSummary(verdict.reason),
          ...(finalError === undefined ? {} : { error: finalError }),
        }
      : result;
  } catch (error) {
    attemptError = error;
    const normalised = toExecutionError(error);

    // A throw can also be a resource kill: the adapter reports a non-zero exit as a
    // thrown error in some paths, and the cgroup files are the tie-breaker. Read them
    // here too, or an OOM would be recorded as `crashed`.
    if (cgroup !== undefined && usage === null) {
      usage = await readUsage(cgroup).catch(() => null);
    }

    const verdict = classifyTermination({
      adapter: placementFailed ? 'threw' : normalised.retryable ? 'threw' : 'failed',
      usage,
      cpuCeilingUs: cpuCeilingFor(profile),
      placementFailed,
    });

    if (verdict.resourceKill && cgroup !== undefined) {
      await killCgroup(cgroup).catch(() => undefined);
      logResourceKill(
        runtime.id,
        input.taskId,
        verdict.reason,
        usage,
        effectiveLimits,
        cgroup.path,
      );
    }

    await finalize('failed', simulatedAdapter, normalised, verdict.reason);
    workspaceOutcome = 'failed';

    if (normalised.retryable) {
      // Let Temporal own the retry decision: maximumAttempts 3, exponential backoff.
      throw retryable(normalised.code, normalised.message);
    }

    // Deterministic rejection: the task failed, and that is data to persist, not an
    // exception to retry.
    return bannerResult(runtime.id, {
      status: 'failed',
      summary: `Execution failed before it could start: ${normalised.message}`,
      error: normalised,
      simulated: simulatedAdapter,
    });
  } finally {
    activityCancellation.removeEventListener('abort', abort);
    stopHeartbeat?.();

    // The cgroup goes away on every path, including the crash paths above. It is
    // removed *after* the usage read (the files must still exist to be read) and
    // `ENOENT` is tolerated because a reaper may have removed it already.
    if (cgroup !== undefined) {
      await removeCgroup(cgroup).then(
        (removed) => {
          if (!removed) {
            // Not fatal: the run's outcome is already persisted. But a cgroup that
            // outlives its attempt keeps charging the parent, so it is never silent.
            workerLogger().warn(
              { cgroup: cgroup?.path, attemptId: attempt.id },
              'cgroup could not be removed after the attempt',
            );
          }
        },
        () => undefined,
      );
    }

    if (lease !== undefined) {
      try {
        await releaseWorkspace({
          lease,
          orgId: input.orgId,
          outcome: workspaceOutcome ?? 'failed',
          ...(attemptError === undefined ? {} : { error: attemptError }),
        });
        await markAttemptCleanupState({
          orgId: input.orgId,
          attemptId: attempt.id,
          cleanupState: 'done',
        }).catch(() => undefined);
      } catch {
        // The run's outcome is already decided and persisted; a cleanup failure must
        // not replace it. The workspace row keeps its terminal state, and the
        // manager's own error (a leaked exception here) is the operator's clue that a
        // directory may need attention.
        await markAttemptCleanupState({
          orgId: input.orgId,
          attemptId: attempt.id,
          cleanupState: 'failed',
        }).catch(() => undefined);
      }
    }
  }
}

/**
 * The error the platform attaches to a resource kill. Codes are stable strings because
 * an operator filters on them; `RESOURCE_LIMIT_OOM` and `AGENT_TIMEOUT` must not be
 * indistinguishable in a log search.
 */
function resourceKillError(
  reason: TerminationReason,
  usage: CgroupUsage | null,
  limits: EffectiveLimits | undefined,
): ExecutionResult['error'] {
  const code =
    reason === 'oom'
      ? 'RESOURCE_LIMIT_OOM'
      : reason === 'pids'
        ? 'RESOURCE_LIMIT_PIDS'
        : reason === 'cpu'
          ? 'RESOURCE_LIMIT_CPU'
          : reason === 'timeout'
            ? 'RESOURCE_LIMIT_WALL_CLOCK'
            : 'RESOURCE_LIMIT_UNKNOWN';

  const detail = [
    usage === null || usage.memoryPeakBytes === null
      ? null
      : `memory.peak=${String(usage.memoryPeakBytes)}B`,
    usage === null ? null : `pids.peak=${String(usage.pidsPeak ?? 'unknown')}`,
    usage === null ? null : `cpu=${String(usage.cpuTimeMs)}ms`,
    limits === undefined ? 'limits=unavailable' : `memory.max=${limits.memoryMax}`,
    limits === undefined ? null : `pids.max=${limits.pidsMax}`,
    limits === undefined ? null : `cpu.max=${limits.cpuMax}`,
  ]
    .filter((part): part is string => part !== null)
    .join(' ');

  return {
    code,
    message: `Terminated by the resource supervisor (${reason}). ${detail}`,
    retryable: false,
  };
}

function resourceKillSummary(reason: TerminationReason): string {
  switch (reason) {
    case 'oom':
      return 'Terminated: the attempt exceeded its memory.max and the kernel killed it.';
    case 'pids':
      return 'Terminated: the attempt reached its pids.max and could not fork.';
    case 'cpu':
      return "Terminated: CPU usage exceeded what the attempt's cpu.max permits.";
    case 'timeout':
      return 'Terminated: the attempt exceeded its wall clock.';
    default:
      return `Terminated by the resource supervisor (${reason}).`;
  }
}

/**
 * One line per resource kill, on stderr in the worker's structured format. It is not a
 * `console.log`: this is an operational event, and the log is the only place the
 * effective limits are visible (there is no column for them).
 */
function logResourceKill(
  runtimeId: string,
  taskId: string,
  reason: TerminationReason,
  usage: CgroupUsage | null,
  limits: EffectiveLimits | undefined,
  cgroupPath: string,
): void {
  workerLogger().warn(
    {
      runtimeId,
      taskId,
      terminationReason: reason,
      cgroup: cgroupPath,
      effectiveLimits:
        limits === undefined
          ? null
          : { memoryMax: limits.memoryMax, pidsMax: limits.pidsMax, cpuMax: limits.cpuMax },
      usage,
    },
    'attempt terminated by the resource supervisor',
  );
}

function safeCancellationSignal(): AbortSignal {
  try {
    return cancellationSignal();
  } catch {
    return new AbortController().signal;
  }
}

/** A result the platform produced, not the adapter: no artifacts, no usage. */ function bannerResult(
  runtimeId: string,
  input: {
    readonly status: ExecutionResult['status'];
    readonly summary: string;
    readonly error: ExecutionResult['error'];
    readonly simulated: boolean;
  },
): ExecutionResult {
  return {
    status: input.status,
    summary: input.summary,
    artifacts: [],
    events: [],
    usage: {},
    error: input.error,
    runtimeId,
    simulated: input.simulated,
  };
}

/**
 * Capability requirements per task.
 *
 * The schema has no `requiredCapabilities` column, so this returns nothing today and
 * the gate is a hook rather than a filter. That is a schema gap, not a design choice:
 * inventing requirements from the goal's prose would be guessing. Recorded as a
 * follow-up. The check itself is live — the moment a caller supplies actions, a runtime
 * that cannot satisfy them is refused before any work starts.
 */
function requiredActionsFor(_task?: unknown): string[] {
  return [];
}

function safeSegment(value: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw nonRetryable(
      'INVALID_PATH_SEGMENT',
      `Refusing to build an artifact path from "${value}".`,
    );
  }

  return value;
}

/**
 * Claims a one-shot marker. `flag: 'wx'` is the primitive: it fails with `EEXIST` for
 * every caller after the first, across processes, without a lock.
 */
async function claimOnceMarker(root: string, name: string): Promise<boolean> {
  const directory = join(root, '.fault-injection');
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(join(directory, name), new Date().toISOString(), { flag: 'wx' });

    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') return false;

    throw error;
  }
}
