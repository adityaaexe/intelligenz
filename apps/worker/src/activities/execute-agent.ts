import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { cancellationSignal } from '@temporalio/activity';
import {
  ExecutionRequest,
  ExecutionResult,
  LOCAL_SIMULATED_ID,
  RuntimeResultError,
  missingCapabilities,
  toExecutionError,
  type ExecutionEvent,
  type ToolInvocationRecord,
} from '@intelligenz/agent-runtime';
import {
  ISOLATION_TIER_UNAVAILABLE,
  type ExecutionIsolation,
  type IsolationRefusalError,
} from '@intelligenz/contracts';
import {
  enforceTextCap,
  readVolumeUsage,
  type TruncationMarker,
  type WorkspaceHandle,
} from '@intelligenz/workspace-manager';
import { getWorkerConfig } from '../config';
import { assertTaskAuthorised } from '../approvals/authorisation';
import { detectIsolationCapability, isolationRefusalMessage, planIsolation } from '../isolation';
import {
  applyIoMax,
  applyLimits,
  createCgroup,
  killCgroup,
  readUsage,
  removeCgroup,
  startCpuBudgetWatch,
  type CgroupHandle,
  type CgroupUsage,
  type CpuBudgetSample,
  type CpuBudgetWatch,
  type EffectiveLimits,
  type IoMaxEffective,
} from '../cgroup';
import {
  assertProfileAvailable,
  checkCpuBudget,
  cpuBudgetMs,
  cpuCeilingFor,
  executionProfileLabel,
  selectResourceProfile,
  type ResourceProfile,
} from '../resource-profiles';
import {
  describeDiskCapability,
  detectDiskCapability,
  getCgroupCapability,
  type CgroupMode,
  type DiskCapability,
} from '../capabilities';
import { getAgentRuntime, runtimeRequiresWorkspace } from '../runtime';
import type { ExecuteAgentActivityInput, ExecuteAgentActivityResult } from '../shared/contracts';
import { classifyTermination, type TerminationReason } from '../termination';
import { materializeArtifacts } from './artifacts';
import {
  captureFinalEvidenceOutcome,
  captureInitialEvidence,
  type EvidenceCaptureFailure,
  type EvidenceSummary,
} from './evidence';
import {
  RUN_STATUS,
  finalizeAttempt,
  markAttemptCleanupState,
  resolveWorkflowRun,
  startAttempt,
} from './attempts';
import { deterministicId, executionWorkspaceIdFor } from './ids';
import { requireExecutionClaim, executionIdentity, executionWorkflowId } from './claim';
import { workerIdentity } from '../identity';
import { workerLogger } from '../log';
import { db, nonRetryable, retryable } from './support';
import {
  leaseWorkspace,
  markExecuting,
  markPreserving,
  recordFinalSnapshot,
  recordInitialSnapshot,
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

/**
 * How often the CPU budget samples `cpu.stat usage_usec`.
 *
 * Short relative to the smallest budget (30 s), so the overshoot is bounded by
 * scheduling jitter rather than by the interval; long enough that the sampler is one
 * file read per tick instead of a busy loop of its own. 100 ms gives at most 300 extra
 * samples per attempt at the smallest profile.
 */
const CPU_BUDGET_SAMPLE_INTERVAL_MS = 100;

/**
 * How many CPU-budget kills one workflow run may accumulate before it is refused.
 *
 * Zero on purpose. A budget kill is a deliberate platform decision, not a transient
 * fault, so the retry policy that exists for transient faults must not apply to it. A
 * deployment that wants one more try changes this constant — and then says so in a
 * review, which is the point of it being a constant rather than an environment variable
 * an operator can quietly turn up at 3am.
 */
const CPU_BUDGET_RESTART_LIMIT = 0;

/** Per-field ceilings used by `enforceResultCap`, as fractions of the profile's cap. */
const EVENT_MESSAGE_CAP = 8 * 1024;
const EVENT_DATA_CAP = 16 * 1024;
const PROVIDER_META_CAP_FRACTION = 4;
const MAX_TOOL_INVOCATIONS = 2_000;

export async function executeAgentActivity(
  input: ExecuteAgentActivityInput,
): Promise<ExecuteAgentActivityResult> {
  // ── The execution claim — the first act, before anything exists to undo ───────
  //
  // Not "first" as a figure of speech. This runs before the runtime adapter is
  // constructed, before the task is read, before `startAttempt`, before the cgroup probe,
  // before the workspace lease, before the broker and before `runtime.execute`. A refusal
  // here has **zero** side effects: no attempt row, no workspace, no cgroup, no `AgentRun`,
  // no broker request.
  //
  // It sits here rather than only in `validateTaskActivity` because activities are
  // dispatched by *name*: any workflow on this worker's task queue can invoke
  // `executeAgentActivity` directly, skipping validation entirely. Until this check
  // existed, that path executed an unapproved HIGH-risk task with no claim written — the
  // gate one activity upstream was real, and irrelevant to the caller that skipped it.
  //
  // The identity comes from the activity context and nowhere else. A call with no
  // execution identity — a standalone activity, or any invocation not dispatched by a
  // workflow — is refused `EXECUTION_IDENTITY_UNAVAILABLE` here, before the first read.
  const claim = await requireExecutionClaim({
    orgId: input.orgId,
    taskId: input.taskId,
    attemptId: input.attemptId,
    executionRunId: executionIdentity(),
    workflowRunId: input.workflowRunId,
  });

  const config = getWorkerConfig();
  const runtime = getAgentRuntime(config);
  const simulatedAdapter = runtime.id === LOCAL_SIMULATED_ID;

  const task = await db().task.findFirst({
    // Tenant scoping.
    where: { id: input.taskId, orgId: input.orgId },
    select: {
      id: true,
      orgId: true,
      goal: true,
      title: true,
      acceptanceCriteria: true,
      riskClass: true,
      derivedRiskClass: true,
      riskFactors: true,
      status: true,
      projectId: true,
    },
  });

  if (task === null) {
    throw nonRetryable('TASK_NOT_FOUND', `Task ${input.taskId} does not exist in this org.`);
  }

  // ── The approval-and-risk gate, re-checked where the work starts ──────────────
  //
  // The same function `validateTaskActivity` calls, imported rather than re-implemented,
  // at `launch` altitude: the claim above already proved this execution holds the
  // reservation, so what remains is whether the grant still authorises *this attempt* —
  // a revocation, an expiry, a content change, or a grant bound to a different attempt
  // all refuse here even though validation saw a valid grant moments earlier.
  await assertTaskAuthorised({ task, attemptId: claim.attemptId, altitude: 'launch' });

  // ── Resource policy, resolved before anything runs ────────────────────────────
  //
  // Five decisions, all of them before any work, and none of them the agent's:
  //   1. which profile does the server's policy pick for this task (and its tier);
  //   2. can this host launch the isolation tier that profile declares (D-007);
  //   3. is cgroup isolation real on this host right now (probed once per process);
  //   4. is there a bounded workspace volume, i.e. a real disk quota (Gate D);
  //   5. is that profile allowed to run with the controls that are actually available
  //      (HEAVY is not, when either aggregate control is missing).
  //
  // A refusal here is a `nonRetryable` failure: retrying cannot make a HEAVY profile
  // safe on a host with no aggregate limit, and it cannot make a virtual machine exist.
  const profile: ResourceProfile = selectResourceProfile({
    riskClass: task.riskClass,
    realRuntime: !simulatedAdapter,
    configured: config.resources.profile,
  }).profile;

  // ── The isolation gate — first, and impossible to bypass ──────────────────────
  //
  // ADR D-007 decided that a profile requiring a virtual machine fails closed **before
  // the agent is launched**, and until now nothing enforced it: no code read `/dev/kvm`,
  // so a VM-requiring profile would have run under a shared kernel with nothing in the
  // record saying so.
  //
  // "Before" is literal. This runs before the cgroup probe, before `assertProfileAvailable`,
  // before the workspace lease, before the cgroup is created, before `runtime.execute` and
  // before the broker exists. The one write a refusal makes is the attempt row that records
  // the refusal; there is no workspace, no agent process and no broker request to undo.
  //
  // Three things make it unbypassable:
  //   - the requirement is `profile.isolation`, and the profile is chosen from the task's
  //     risk class and operator configuration, never from a request or activity field;
  //   - availability comes from `detectIsolationCapability()`, which reads files and never
  //     `process.env` — a forged `WORKER_VM_AVAILABLE=1` changes nothing;
  //   - this is the only path to `runtime.execute` in the worker, so there is no second
  //     launch site that could skip it.
  //
  // The capability is re-measured on every attempt rather than cached: it is two file
  // reads, and a worker that saw `/dev/kvm` appear (or disappear) should say so.
  const isolationCapability = await detectIsolationCapability();
  const isolation = planIsolation(profile, isolationCapability);

  if (isolation.refused) {
    const message = isolationRefusalMessage(profile, isolation);

    const refusal = {
      code: ISOLATION_TIER_UNAVAILABLE,
      message,
      retryable: false,
      isolation,
    } satisfies IsolationRefusalError;

    // The attempt is settled `failed` and nothing else happens. It is written here, rather
    // than left to the workflow's failure path, because the workflow cannot know which
    // attempt was refused — and it goes through `startAttempt` so the attempt `POST /run`
    // reserved is the row that carries the verdict, instead of a phantom second one.
    const refusedRun = await resolveWorkflowRun({
      orgId: input.orgId,
      taskId: input.taskId,
      workflowRunId: input.workflowRunId,
    });

    const refusedAttempt = await startAttempt({
      orgId: input.orgId,
      taskId: input.taskId,
      workflowRunId: refusedRun.id,
      runtimeId: runtime.id,
      // No model call happened and none will: `simulated` is literal, not a placeholder.
      simulated: true,
      startedAt: new Date(),
      // The claim this activity verified on entry. `startAttempt` adopts only a row
      // carrying it, so even this retirement path cannot take another execution's row.
      executionRunId: claim.executionRunId,
      executionWorkflowId: executionWorkflowId(),
    });

    await finalizeAttempt({
      orgId: input.orgId,
      attemptId: refusedAttempt.id,
      status: RUN_STATUS.failed,
      simulated: true,
      error: refusal,
      resources: {
        // What was asked for. Nothing bounded this attempt, so no usage is claimed.
        executionProfile: profile.name.toLowerCase(),
        cpuTimeMs: null,
        memoryPeakBytes: null,
        pidsPeak: null,
        terminationReason: 'isolation_unavailable',
      },
    });

    workerLogger().warn(
      {
        taskId: input.taskId,
        attemptId: refusedAttempt.id,
        profile: profile.name,
        isolation,
      },
      message,
    );

    throw nonRetryable(ISOLATION_TIER_UNAVAILABLE, message);
  }

  const capability = await getCgroupCapability({ root: config.resources.cgroupRoot });
  const cgroupMode: CgroupMode = capability.mode;

  const disk: DiskCapability = await detectDiskCapability();
  const diskMode = disk.mode;

  // The disk boundary is a boot-level fact an operator must be able to read from a log,
  // not infer from behaviour. Logged once per attempt only when it is *not* enforced:
  // the enforced case is visible on every attempt's `volume` field instead.
  if (disk.mode === 'unavailable') {
    workerLogger().warn(
      { code: disk.code, reason: disk.reason, remediation: disk.remediation },
      describeDiskCapability(disk),
    );
  }

  try {
    // `profile` was resolved once, above, and gated by `planIsolation`. Re-selecting here
    // would suggest a second, independent choice; there is one.
    assertProfileAvailable(profile, cgroupMode, { mode: diskMode });
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

  // ── A CPU-budget kill is not retryable ────────────────────────────────────────
  //
  // The marker is durable (a file under the artifact root) and keyed to the workflow run,
  // so "the budget stopped this run" survives a worker restart, a new attempt number and
  // Temporal's own retry policy. Without it, `maximumAttempts: 3` would give a runaway
  // run three budgets — which makes the budget a suggestion.
  //
  // Checked before the attempt row: an attempt that is refused must not claim to have
  // tried, exactly like a refused profile.
  const priorBudgetStops = await countCpuBudgetStops(config.artifactRoot, workflowRun.id);

  if (priorBudgetStops > CPU_BUDGET_RESTART_LIMIT) {
    throw nonRetryable(
      'CPU_BUDGET_EXCEEDED',
      `Workflow run ${workflowRun.id} already exhausted its CPU budget on an earlier ` +
        `attempt (${String(priorBudgetStops)} recorded stop(s), restart limit ` +
        `${String(CPU_BUDGET_RESTART_LIMIT)}). Refusing to restart it: the budget exists to ` +
        "stop a runaway run, and retrying it would just buy more CPU. Raise the task's " +
        'profile or split the task.',
    );
  }

  const attempt = await startAttempt({
    orgId: input.orgId,
    taskId: input.taskId,
    workflowRunId: workflowRun.id,
    runtimeId: runtime.id,
    // Provisional. A result replaces this with the adapter's own report; a thrown
    // error has no result, and then the adapter's nature is the only honest value.
    simulated: simulatedAdapter,
    startedAt: new Date(),
    // The same execution that passed the entry check. Adoption is conditional on the
    // attempt carrying this claim (F2).
    executionRunId: claim.executionRunId,
    // N7: the workflow id beside the run id, so the claim record on a newly allocated
    // attempt can be probed exactly rather than guessed.
    executionWorkflowId: executionWorkflowId(),
  });

  let lease: WorkspaceLease | undefined;
  let workspaceOutcome: WorkspaceOutcome | undefined;
  let attemptFinalized = false;
  let attemptError: unknown;

  // ── Host evidence (Gate G) ────────────────────────────────────────────────────
  //
  // `initialEvidence` is the baseline taken the instant the lease is granted, and
  // `finalEvidence` is the manifest built from it after the run. Both are declared here
  // because every exit path below — success, resource kill, thrown error — has to be able
  // to attach what it measured. `null` means "no manifest", which is a different and
  // honest statement from "an empty manifest": the agent never gets to make the absence
  // look like a clean bill of health.
  let initialEvidence: Awaited<ReturnType<typeof captureInitialEvidence>> = null;
  let finalEvidence: EvidenceSummary | null = null;
  /**
   * Why the final manifest is missing, when a baseline existed.
   *
   * Separated from `finalEvidence === null` because that value is also the legitimate
   * answer for a runtime that leases no workspace. `null` evidence for an attempt with a
   * baseline is not "nothing to report" — it is "the report could not be produced", and it
   * fails the attempt below.
   */
  let finalEvidenceFailure: EvidenceCaptureFailure | null = null;

  // ── Per-attempt enforcement state ─────────────────────────────────────────────
  // `cgroup` is created after the lease (the cgroup is named after the workspace) and
  // removed in `finally`. `usage` is read once the process tree is gone; every value
  // written to `ExecutionAttempt` comes from those files, never from an intention.
  let cgroup: CgroupHandle | undefined;
  let effectiveLimits: EffectiveLimits | undefined;
  let usage: CgroupUsage | null = null;
  let placementFailed = false;

  // CPU lifetime budget (Gate C). The watch is started with the cgroup and stopped on
  // every exit path; `budgetSample` is the last measurement, which is what the attempt
  // and the error message quote.
  let budgetWatch: CpuBudgetWatch | undefined;
  let cpuBudgetExceeded = false;
  let budgetSample: CpuBudgetSample | null = null;

  // Disk (Gate D). `diskFloorBytes` is what `statfs` says was left on the volume after
  // the run; zero free is the measured form of "the attempt hit ENOSPC".
  let diskFreeBytes: number | null = null;
  let diskExhausted = false;

  // I/O (Gate D, partial). The effective `io.max` line the kernel kept, or the exact
  // reason it refused — never a configured value described as an enforced one.
  let ioEffective: IoMaxEffective | null = null;
  let ioRefusal: string | null = null;

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

  /**
   * Attach the host manifest to the result the workflow persists.
   *
   * The manifest travels as a worker-authored field beside `ExecutionResult`, never inside
   * it: `ExecutionResult` is `.strict()`, so an adapter that tries to smuggle an `evidence`
   * key fails validation rather than being trusted, and `persistResult` refuses a
   * `change-manifest` artifact that arrived through `artifacts[]`. The provenance this
   * carries — attempt, workspace, digests — is therefore not adapter-reachable.
   */
  function attachEvidence(value: ExecutionResult): ExecuteAgentActivityResult {
    return finalEvidence === null ? value : { ...value, evidence: finalEvidence };
  }

  /**
   * The evidence gap for this attempt, or `null` when there is none.
   *
   * The `initialEvidence === null` arm is not a convenience. A runtime that leases no
   * workspace never takes a baseline, so it owes no manifest; treating that absence as a
   * failure would fail every simulated run for a report it was never asked to produce.
   */
  function evidenceGap(): EvidenceCaptureFailure | null {
    if (initialEvidence === null) return null;

    return finalEvidenceFailure;
  }

  /**
   * Record an evidence failure durably, bound to the attempt.
   *
   * An audit event rather than a column: `AuditEvent` has no update path in this codebase,
   * so the record cannot be rewritten by a later pass, and it is the same table an operator
   * already reads for `workspace.reaped.v1` and `execution.claim_released.v1`. The id is
   * deterministic from the attempt and the phase, so a retried activity cannot produce a
   * second, disagreeing record.
   *
   * Failing to write it is logged, not thrown: the attempt is already being failed, and
   * trading a recorded status for an exception would lose more than it gains.
   */
  async function recordEvidenceFailure(
    gap: EvidenceCaptureFailure,
    activityInput: ExecuteAgentActivityInput,
    attemptRow: { readonly id: string; readonly attemptNumber: number },
    workspaceId: string | null,
  ): Promise<void> {
    try {
      await db().auditEvent.create({
        data: {
          id: deterministicId(`attempt-evidence-failed:${attemptRow.id}:final`),
          orgId: activityInput.orgId,
          actorType: 'system',
          actorId: `worker:${workerIdentity()}`,
          action: 'attempt.evidence_failed',
          aggregateType: 'ExecutionAttempt',
          aggregateId: attemptRow.id,
          eventType: 'attempt.evidence_failed.v1',
          correlationId: activityInput.correlationId,
          idempotencyKey: `attempt.evidence_failed.v1:${attemptRow.id}:final`,
          payload: {
            taskId: activityInput.taskId,
            attemptId: attemptRow.id,
            attemptNumber: attemptRow.attemptNumber,
            workflowRunId: workflowRun.id,
            workspaceId,
            phase: 'final',
            code: gap.code,
            reason: gap.reason,
            // The digest of the tree the attempt *was* measured against. Without it,
            // "no manifest" is a fact with no anchor; with it, the baseline it failed to
            // compare against is named.
            initialManifestDigest: initialEvidence?.digest ?? null,
            recordedAt: new Date().toISOString(),
            worker: workerIdentity(),
          },
          occurredAt: new Date(),
        },
        select: { id: true },
      });
    } catch (error) {
      if ((error as { code?: string }).code === 'P2002') return;

      workerLogger().error(
        { attemptId: attemptRow.id, err: error instanceof Error ? error.message : String(error) },
        'attempt.evidence_failed.v1 could not be written; the failure is only in the log',
      );
    }
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
      isolation,
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

      // ── The baseline, before the agent exists ─────────────────────────────────
      //
      // Not "early" — **first**. This is the first statement after the lease is granted
      // and it precedes the cgroup (named after the workspace, so it has to follow the
      // lease), the heartbeat, `markExecuting`, the broker and `runtime.execute`. Anything
      // that runs before it is something the agent could have touched, and a baseline
      // taken after the agent's first write is not a baseline: it would report that write
      // as pre-existing.
      //
      // A reused workspace is expected and correct here. This is a *per-attempt* baseline,
      // so a previous attempt's committed mess appears as pre-existing state — which is
      // exactly what the next approver needs to know before reading a manifest that says
      // "only these paths changed".
      initialEvidence = await captureInitialEvidence(lease.handle);

      if (initialEvidence === null) {
        workerLogger().warn(
          { taskId: input.taskId, workspaceId: lease.id },
          'No initial workspace snapshot: this attempt can produce no change manifest',
        );
      } else {
        await recordInitialSnapshot({
          orgId: input.orgId,
          workspaceId: lease.id,
          digest: initialEvidence.digest,
          capturedAt: initialEvidence.capturedAt,
        });
      }
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

        // ── Gate C: the cumulative CPU budget ────────────────────────────────────
        //
        // `cpu.max` above is a rate. This is the total: `cpu.stat usage_usec` sampled
        // every 100 ms against the profile's budget, and when it is gone the whole
        // cgroup is killed — not signalled politely, killed, because a run that has
        // burned its budget has already demonstrated it will not stop on its own.
        //
        // The kill happens here rather than after `execute()` returns: waiting for the
        // adapter to notice would give the run another interval of CPU for free, and
        // the point of a lifetime budget is that the lifetime is bounded.
        budgetWatch = startCpuBudgetWatch({
          handle: cgroup,
          budgetUs: profile.cpuBudgetUs,
          intervalMs: CPU_BUDGET_SAMPLE_INTERVAL_MS,
          onExceeded: (sample) => {
            cpuBudgetExceeded = true;
            budgetSample = sample;

            void killCgroup(cgroup as CgroupHandle).catch(() => undefined);

            workerLogger().warn(
              {
                taskId: input.taskId,
                attemptId: attempt.id,
                cgroup: cgroup?.path,
                usageUs: sample.usageUs,
                budgetUs: sample.budgetUs,
                fraction: Number(sample.fraction.toFixed(3)),
                elapsedMs: sample.elapsedMs,
              },
              'CPU budget exhausted — cgroup killed',
            );
          },
        });

        // ── Gate D (I/O): `io.max` on the volume's backing device ───────────────
        //
        // Applied only when the checkout is on a bounded volume (so there is a device to
        // throttle) and only when the kernel kept the value. `io.max` is written before
        // the first process exists so the run never gets an unthrottled window.
        const volume = lease.handle.volume;

        if (volume !== undefined && profile.ioReadBps > 0 && profile.ioWriteBps > 0) {
          try {
            ioEffective = await applyIoMax(cgroup, {
              device: volume.device,
              rbps: profile.ioReadBps,
              wbps: profile.ioWriteBps,
            });
          } catch (error) {
            // Reported, never fatal: a kernel without `io` delegation still gets
            // memory/pids/cpu/disk enforced, and the attempt log carries the refusal.
            ioRefusal = error instanceof Error ? error.message : String(error);
          }
        }
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
      //
      // `handle.repoPath`, not `join(rootPath, 'repo')`: when a bounded volume is leased
      // the checkout lives on the volume, and the sandbox's only writable mount has to be
      // the volume — that is what makes `ENOSPC` apply to what the agent writes.
      allowedPaths:
        lease === undefined
          ? [join(config.artifactRoot, safeSegment(input.orgId), safeSegment(task.id))]
          : [lease.handle.repoPath],
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

    // ── The final snapshot, the moment the process tree is gone ────────────────
    //
    // Taken here, before the result is even validated, and on every path that reaches
    // this line — succeeded, failed, timed out, cancelled. It has to be before
    // `materializeArtifacts` (which writes into `artifacts/`, a sibling of the checkout,
    // so it would not change the answer, but "as the agent left it" is a cleaner instant).
    //
    // `captureFinalEvidence` cannot throw: an evidence failure must not replace a real
    // run's result with an infrastructure error. A `null` result means no manifest, and
    // an absent manifest is visible as absent; an empty one would be a claim.
    if (lease !== undefined) {
      const captured = await captureFinalEvidenceOutcome({
        handle: lease.handle,
        initial: initialEvidence,
      });

      finalEvidence = captured.summary;
      finalEvidenceFailure = captured.failure;

      if (finalEvidence === null) {
        workerLogger().warn(
          { taskId: input.taskId, workspaceId: lease.id },
          'No change manifest for this attempt',
        );
      } else {
        await recordFinalSnapshot({
          orgId: input.orgId,
          workspaceId: lease.id,
          digest: finalEvidence.finalManifestDigest,
        });

        workerLogger().info(
          {
            taskId: input.taskId,
            workspaceId: lease.id,
            changeCount: finalEvidence.changeCount,
            counts: finalEvidence.counts,
            authoritative: finalEvidence.authoritative,
            ...(finalEvidence.stopReason === null ? {} : { stopReason: finalEvidence.stopReason }),
          },
          'Host change manifest captured',
        );
      }
    }

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

      // The ceiling (Gate E) applies to the copy, not to the adapter's claim: a
      // transcript "of 2 GiB" is streamed through `outputCapBytes` and what lands is
      // `min(fits, cap)` plus a marker carrying the original size.
      const materialized = await materializeArtifacts({
        artifactsDirectory: workspaceArtifactsDirectory(lease.handle),
        artifacts: result.artifacts,
        outputCapBytes: profile.outputCapBytes,
      });

      result = {
        ...result,
        artifacts: materialized.artifacts,
        providerMeta: {
          ...result.providerMeta,
          workspaceId: lease.id,
          ...(materialized.missing.length === 0 ? {} : { artifactMissing: materialized.missing }),
          ...(materialized.transcriptPath === null ? { transcriptMissing: true } : {}),
          ...(materialized.truncated.length === 0
            ? {}
            : {
                artifactTruncated: materialized.truncated.map((entry) => ({
                  kind: entry.kind,
                  originalBytes: entry.originalBytes,
                  capturedBytes: entry.capturedBytes,
                  markerPath: entry.markerPath,
                })),
              }),
          ...(materialized.budgetExhausted ? { artifactBudgetExhausted: true } : {}),
        },
      };
    }

    // ── The output ceiling (Gate E) ──────────────────────────────────────────────
    //
    // Applied to what the worker is about to persist, which is the last point where the
    // size is knowable: summary, normalised events, tool invocations and provider
    // metadata. The artifacts went through `materializeArtifacts` above, which streams
    // them through the same profile number.
    const capped = enforceResultCap(result, profile.outputCapBytes);

    result = capped.result;

    // ── The tier this attempt actually ran under (D-007) ─────────────────────────
    //
    // Attached **after** the output ceiling, deliberately: the ceiling can replace
    // `providerMeta` wholesale when it is too large, and a result that lost its tier would
    // be reported as "not recorded" — a different and misleading statement. `providerMeta`
    // is where it lands because the attempt has no JSON column of its own and this phase
    // adds no migration; `GET /executions` reads it back as `isolation`.
    //
    // It is the plan, not the capability: a vm-capable host that served a
    // `restricted-shared-kernel` profile reports `restricted-shared-kernel`, because that
    // is what ran.
    result = {
      ...result,
      providerMeta: { ...(result.providerMeta ?? {}), isolation },
    };

    // ── Accounting, then the verdict ─────────────────────────────────────────────
    //
    // The numbers come from the cgroup files after the tree is gone: `memory.peak`,
    // `pids.peak`, `cpu.stat usage_usec`. They are what the attempt used, not what the
    // profile allowed — and both are recorded (the profile on `executionProfile`, the
    // limits in the attempt log) so "enforced" is auditable afterwards.
    if (cgroup !== undefined) {
      usage = await readUsage(cgroup);
    }

    // A budget kill can land between the last sample and the adapter returning; the
    // counter is the authority either way.
    if (!cpuBudgetExceeded && usage !== null) {
      const finalCheck = checkCpuBudget(usage.cpuUsageUs, profile.cpuBudgetUs);

      if (finalCheck === 'exhausted') {
        cpuBudgetExceeded = true;
        budgetSample = {
          usageUs: usage.cpuUsageUs,
          budgetUs: profile.cpuBudgetUs,
          elapsedMs: wallClockMs,
          fraction: usage.cpuUsageUs / profile.cpuBudgetUs,
        };
      }
    }

    // ── Disk (Gate D), measured after the run ────────────────────────────────────
    //
    // `statfs` on the volume is the measurement: zero free bytes is the machine-readable
    // form of "the attempt hit ENOSPC", and it is read whether or not the adapter
    // mentioned it. A run may also fail with `ENOSPC` and free a little space again by
    // the time we look, so the adapter's own error is checked too.
    const diskState = await measureDisk(lease);

    if (diskState !== null) {
      diskFreeBytes = diskState.freeBytes;
      diskExhausted = diskState.exhausted || mentionsNoSpace(result);
    }

    const verdict = classifyTermination({
      adapter: result.status,
      usage,
      cpuCeilingUs: cpuCeilingFor(profile),
      placementFailed,
      cpuBudgetExceeded,
      ...(budgetSample === null ? {} : { cpuBudget: budgetSample }),
      diskExhausted,
    });

    if (verdict.resourceKill && cgroup !== undefined) {
      // The kernel already killed on OOM; `cgroup.kill` is the backstop that guarantees
      // nothing survived the breach (a child that ignored the memory event, a sister
      // process still holding a socket). Killing an already-empty cgroup is a no-op.
      await killCgroup(cgroup);

      // The budget kill already happened in the sampler; reading usage again here is
      // what makes the persisted number the *final* one rather than the last sample.
      if (verdict.reason === 'cpu_budget') {
        usage = (await readUsage(cgroup).catch(() => null)) ?? usage;
      }

      logResourceKill(
        runtime.id,
        input.taskId,
        verdict.reason,
        usage,
        effectiveLimits,
        cgroup.path,
        {
          ...(budgetSample === null
            ? {}
            : { cpuBudgetUs: budgetSample.budgetUs, cpuBudgetMs: cpuBudgetMs(profile) }),
          ...(diskFreeBytes === null ? {} : { diskFreeBytes }),
          ioMax: ioEffective?.line ?? null,
          ioRefusal,
        },
      );
    }

    // A budget kill is remembered outside the attempt row: the row is per attempt, and
    // the point is that the *next* attempt does not run. Written before `finalize` so a
    // crash between the two cannot lose it.
    if (verdict.reason === 'cpu_budget') {
      await recordCpuBudgetStop(config.artifactRoot, workflowRun.id, attempt.id);
    }

    // The platform's record and the adapter's report must agree. A resource kill the
    // adapter described as "failed" stays failed; one it described as "succeeded" is
    // corrected, with the reason attached, because a run that lost a process to the
    // kernel did not succeed.
    let finalStatus: ExecutionResult['status'] = verdict.overridesAdapter
      ? verdict.reason === 'cancelled'
        ? 'cancelled'
        : verdict.reason === 'timeout'
          ? 'timeout'
          : 'failed'
      : result.status;

    let finalError = verdict.overridesAdapter
      ? resourceKillError(verdict.reason, usage, effectiveLimits, {
          profile,
          budgetSample,
          diskFreeBytes,
        })
      : result.error;

    // ── No evidence, no success ────────────────────────────────────────────────
    //
    // The invariant: **if an initial snapshot exists for this attempt, a missing final
    // manifest is a failure of the attempt.** The baseline is a promise that the run will
    // be describable; a run that then removes the ability to describe it — `chmod 000` on
    // one directory is enough — has not succeeded, whatever its adapter returned.
    //
    // Before this, the failure was silent in the worst way: `captureFinalEvidence` returned
    // `null`, nothing was attached, the attempt was finalised `succeeded`, and "no
    // manifest" was indistinguishable from "the agent changed nothing".
    //
    // The status vocabulary is unchanged — this is `failed`, with the reason in `error`.
    // `terminationReason` stays `completed` because the *process* did complete; conflating
    // "how the tree stopped" with "whether the claim holds" is what the two columns are for.
    //
    // A run with no baseline (a runtime that leases no workspace) never had a manifest to
    // lose, so `evidenceGap()` is `null` and this branch is unreachable for it.
    const gap = evidenceGap();

    if (gap !== null) {
      await recordEvidenceFailure(gap, input, attempt, lease === undefined ? null : lease.id);

      if (finalStatus === 'succeeded') {
        finalStatus = 'failed';
        finalError = {
          code: 'EVIDENCE_MISSING',
          message:
            'The final workspace snapshot could not be taken, so this attempt has no change ' +
            `manifest and cannot be reviewed: ${gap.reason}`,
          retryable: false,
        };
      }
    }

    await finalize(finalStatus, result.simulated, finalError, verdict.reason);

    workspaceOutcome =
      finalStatus === 'succeeded'
        ? 'completed'
        : finalStatus === 'cancelled'
          ? 'cancelled'
          : 'failed';

    return attachEvidence(
      verdict.overridesAdapter
        ? {
            ...result,
            status: finalStatus,
            summary: resourceKillSummary(verdict.reason),
            ...(finalError === undefined ? {} : { error: finalError }),
          }
        : // The evidence gate can correct `succeeded` to `failed` without a resource kill.
          // Returning `result` unchanged here would have written `failed` to the attempt and
          // told the workflow `succeeded` — the same silence, one layer up: the task would
          // reach `succeeded` while its attempt did not.
          finalStatus === result.status
          ? result
          : {
              ...result,
              status: finalStatus,
              ...(finalError === undefined ? {} : { error: finalError }),
            },
    );
  } catch (error) {
    attemptError = error;
    const normalised = toExecutionError(error);

    // ── The final snapshot on the thrown path ─────────────────────────────────
    //
    // A throw is a failure outcome, not an exemption from evidence. This runs before the
    // resource verdict and before `finalize`, so the tree is measured as the crash left
    // it. `finalEvidence` is left alone when the success path already captured it: two
    // snapshots of one instant would only make "which one is the manifest" a question.
    if (lease !== undefined && finalEvidence === null) {
      const captured = await captureFinalEvidenceOutcome({
        handle: lease.handle,
        initial: initialEvidence,
      });

      finalEvidence = captured.summary;
      finalEvidenceFailure = captured.failure;

      if (finalEvidence !== null) {
        await recordFinalSnapshot({
          orgId: input.orgId,
          workspaceId: lease.id,
          digest: finalEvidence.finalManifestDigest,
        });
      }
    }

    // A throw can also be a resource kill: the adapter reports a non-zero exit as a
    // thrown error in some paths, and the cgroup files are the tie-breaker. Read them
    // here too, or an OOM would be recorded as `crashed`.
    if (cgroup !== undefined && usage === null) {
      usage = await readUsage(cgroup).catch(() => null);
    }

    // A killed tree throws, so the budget flag set by the sampler has to win over the
    // thrown error. The final counter read is the second opinion.
    if (!cpuBudgetExceeded && usage !== null) {
      if (checkCpuBudget(usage.cpuUsageUs, profile.cpuBudgetUs) === 'exhausted') {
        cpuBudgetExceeded = true;
        budgetSample = {
          usageUs: usage.cpuUsageUs,
          budgetUs: profile.cpuBudgetUs,
          elapsedMs: wallClockMs,
          fraction: usage.cpuUsageUs / profile.cpuBudgetUs,
        };
      }
    }

    const diskState = await measureDisk(lease);
    if (diskState !== null) diskFreeBytes = diskState.freeBytes;

    const verdict = classifyTermination({
      adapter: placementFailed ? 'threw' : normalised.retryable ? 'threw' : 'failed',
      usage,
      cpuCeilingUs: cpuCeilingFor(profile),
      placementFailed,
      cpuBudgetExceeded,
      ...(budgetSample === null ? {} : { cpuBudget: budgetSample }),
      diskExhausted:
        (diskState?.exhausted ?? false) ||
        mentionsNoSpace({ error: normalised } as Pick<ExecutionResult, 'error'>),
    });

    if (verdict.reason === 'cpu_budget') {
      await recordCpuBudgetStop(config.artifactRoot, workflowRun.id, attempt.id);
    }

    if (verdict.resourceKill && cgroup !== undefined) {
      await killCgroup(cgroup).catch(() => undefined);
      logResourceKill(
        runtime.id,
        input.taskId,
        verdict.reason,
        usage,
        effectiveLimits,
        cgroup.path,
        {
          ...(budgetSample === null
            ? {}
            : { cpuBudgetUs: budgetSample.budgetUs, cpuBudgetMs: cpuBudgetMs(profile) }),
          ...(diskFreeBytes === null ? {} : { diskFreeBytes }),
          ioMax: ioEffective?.line ?? null,
          ioRefusal,
        },
      );
    }

    await finalize('failed', simulatedAdapter, normalised, verdict.reason);
    workspaceOutcome = 'failed';

    // The thrown path already reaches `failed`, so this cannot change the outcome — but the
    // *record* is still owed: "this attempt's evidence is missing" must be findable without
    // reading a log line, on every path that can produce it.
    {
      const gap = evidenceGap();

      if (gap !== null) {
        await recordEvidenceFailure(gap, input, attempt, lease === undefined ? null : lease.id);
      }
    }

    // A budget kill is terminal on purpose. `retryable` is the adapter's opinion of its
    // own failure, and it cannot see the resource decision; rethrowing here would hand
    // the run straight back to Temporal for another budget.
    if (verdict.reason === 'cpu_budget') {
      return attachEvidence(
        bannerResult(runtime.id, {
          status: 'failed',
          summary: resourceKillSummary('cpu_budget'),
          error: resourceKillError(verdict.reason, usage, effectiveLimits, {
            profile,
            budgetSample,
            diskFreeBytes,
          }),
          simulated: simulatedAdapter,
          isolation,
        }),
      );
    }

    if (normalised.retryable) {
      // Let Temporal own the retry decision: maximumAttempts 3, exponential backoff.
      throw retryable(normalised.code, normalised.message);
    }

    // Deterministic rejection: the task failed, and that is data to persist, not an
    // exception to retry.
    return attachEvidence(
      bannerResult(runtime.id, {
        status: 'failed',
        summary: `Execution failed before it could start: ${normalised.message}`,
        error: normalised,
        simulated: simulatedAdapter,
        isolation,
      }),
    );
  } finally {
    activityCancellation.removeEventListener('abort', abort);
    stopHeartbeat?.();

    // The sampler is stopped before the cgroup is read and removed: a sample taken
    // after removal would read a missing file and report `null` over a real number.
    budgetWatch?.stop();

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
  context: {
    readonly profile: ResourceProfile;
    readonly budgetSample: CpuBudgetSample | null;
    readonly diskFreeBytes: number | null;
  },
): ExecutionResult['error'] {
  const code =
    reason === 'oom'
      ? 'RESOURCE_LIMIT_OOM'
      : reason === 'pids'
        ? 'RESOURCE_LIMIT_PIDS'
        : reason === 'cpu'
          ? 'RESOURCE_LIMIT_CPU'
          : reason === 'cpu_budget'
            ? 'RESOURCE_LIMIT_CPU_BUDGET'
            : reason === 'disk'
              ? 'RESOURCE_LIMIT_DISK'
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
    // The budget is quoted in both units on purpose: the file is microseconds and the
    // attempt column is milliseconds, and an operator comparing the two should not have
    // to do the arithmetic.
    context.budgetSample === null
      ? null
      : `cpu.usage=${String(context.budgetSample.usageUs)}us ` +
        `cpu.budget=${String(context.budgetSample.budgetUs)}us ` +
        `(${String(cpuBudgetMs(context.profile))}ms)`,
    context.diskFreeBytes === null ? null : `disk.free=${String(context.diskFreeBytes)}B`,
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
    case 'cpu_budget':
      return 'Terminated: the attempt spent its cumulative CPU budget and the cgroup was killed.';
    case 'disk':
      return 'Terminated: the attempt filled its workspace volume (ENOSPC).';
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
  extra: {
    readonly cpuBudgetUs?: number;
    readonly cpuBudgetMs?: number;
    readonly diskFreeBytes?: number;
    readonly ioMax: string | null;
    readonly ioRefusal: string | null;
  },
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
      cpuBudget:
        extra.cpuBudgetUs === undefined
          ? null
          : { budgetUs: extra.cpuBudgetUs, budgetMs: extra.cpuBudgetMs ?? null },
      diskFreeBytes: extra.diskFreeBytes ?? null,
      ioMax: extra.ioMax,
      ioRefusal: extra.ioRefusal,
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

/**
 * A result the platform produced, not the adapter: no artifacts, no usage.
 *
 * `isolation` is carried on every one of these because they are persisted as an
 * `AgentRun` like any other result: a pre-start failure that omitted its tier would be
 * reported as "not recorded" even though the platform knew which tier the attempt was
 * admitted under.
 */
function bannerResult(
  runtimeId: string,
  input: {
    readonly status: ExecutionResult['status'];
    readonly summary: string;
    readonly error: ExecutionResult['error'];
    readonly simulated: boolean;
    readonly isolation: ExecutionIsolation;
  },
): ExecutionResult {
  return {
    status: input.status,
    summary: input.summary,
    artifacts: [],
    events: [],
    usage: {},
    error: input.error,
    providerMeta: { isolation: input.isolation },
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

// ── Gate E: the result ceiling ──────────────────────────────────────────────────

interface ResultCapOutcome {
  readonly result: ExecutionResult;
  readonly truncations: readonly TruncationMarker[];
}

/**
 * Enforce `outputCapBytes` on the parts of a result the worker persists.
 *
 * The artifact bytes are handled by `materializeArtifacts` (streamed through the same
 * number). This function covers the **in-memory** remainder, which is where unbounded
 * data hides: a `summary` that is one line of a 400 MB build log, an event whose `data`
 * carries a whole tool response, and `providerMeta`, which is `Json` in the database and
 * therefore has no length of its own.
 *
 * Each field gets its own small ceiling (8–16 KiB) *and* the whole payload is measured
 * against the profile's cap: a million 1 KiB events are as unbounded as one 1 GB event.
 * Anything dropped leaves a marker with the original size, so "the transcript is short"
 * and "we kept the first 5 MiB of it" stay distinguishable.
 */
function enforceResultCap(result: ExecutionResult, capBytes: number): ResultCapOutcome {
  const truncations: TruncationMarker[] = [];

  const summary = enforceTextCap(result.summary, Math.max(1_024, capBytes), 'result.summary');
  if (summary.marker !== null) truncations.push(summary.marker);

  let eventBytes = 0;
  const events: ExecutionEvent[] = [];

  for (const event of result.events) {
    const message = enforceTextCap(event.message, EVENT_MESSAGE_CAP, `event:${event.type}`);
    if (message.marker !== null) truncations.push(message.marker);

    let data = event.data;

    if (data !== undefined) {
      const serialised = JSON.stringify(data);

      if (serialised.length > EVENT_DATA_CAP) {
        const capped = enforceTextCap(serialised, EVENT_DATA_CAP, `event:${event.type}:data`);

        if (capped.marker !== null) truncations.push(capped.marker);

        // The truncated body is a string, not the original shape: inventing a JSON
        // object out of a sliced serialisation would produce something that parses and
        // is wrong, which is worse than something that obviously is a marker.
        data = { truncated: capped.text };
      }
    }

    const size = message.capturedBytes + (data === undefined ? 0 : 1);

    // The whole event list is bounded by half the profile's cap: an event stream is
    // diagnostic, and the transcript artifact is the evidence that matters.
    if (eventBytes + size > capBytes / 2) {
      truncations.push({
        scope: 'result.events',
        capBytes,
        capturedBytes: eventBytes,
        originalBytes: result.events.length,
        droppedBytes: result.events.length - events.length,
        sha256: '',
      });
      break;
    }

    eventBytes += size;
    events.push({ ...event, message: message.text, ...(data === undefined ? {} : { data }) });
  }

  const toolInvocations: ToolInvocationRecord[] | undefined =
    result.toolInvocations === undefined
      ? undefined
      : result.toolInvocations.slice(0, MAX_TOOL_INVOCATIONS);

  if (
    result.toolInvocations !== undefined &&
    result.toolInvocations.length > MAX_TOOL_INVOCATIONS
  ) {
    truncations.push({
      scope: 'result.toolInvocations',
      capBytes: MAX_TOOL_INVOCATIONS,
      capturedBytes: MAX_TOOL_INVOCATIONS,
      originalBytes: result.toolInvocations.length,
      droppedBytes: result.toolInvocations.length - MAX_TOOL_INVOCATIONS,
      sha256: '',
    });
  }

  let providerMeta = result.providerMeta;

  if (providerMeta !== undefined) {
    const serialised = JSON.stringify(providerMeta);
    const metaCap = Math.max(1_024, Math.floor(capBytes / PROVIDER_META_CAP_FRACTION));

    if (serialised.length > metaCap) {
      const capped = enforceTextCap(serialised, metaCap, 'result.providerMeta');

      if (capped.marker !== null) truncations.push(capped.marker);

      providerMeta = { truncated: capped.text };
    }
  }

  const truncationMeta =
    truncations.length === 0
      ? {}
      : {
          outputTruncation: {
            capBytes,
            markers: truncations,
          },
        };

  return {
    result: {
      ...result,
      summary: summary.text,
      events,
      ...(toolInvocations === undefined ? {} : { toolInvocations }),
      ...(providerMeta === undefined
        ? {}
        : { providerMeta: { ...providerMeta, ...truncationMeta } }),
    },
    truncations,
  };
}

// ── Gate D: disk measurement ────────────────────────────────────────────────────

/**
 * Read the volume's remaining space after the run.
 *
 * `null` means "no bounded volume", which is a different fact from "plenty of space" —
 * the attempt log prints them differently, and only one of them is evidence of a quota.
 * `exhausted` is `freeBytes === 0` measured with `statfs`, or any free-space figure below
 * one block, which is what `ENOSPC` looks like from the outside.
 *
 * Exported, with a structural parameter, so the disk verdict can be measured in a test
 * without inventing a `WorkspaceManager` and a database row: the inputs it actually
 * reads are the mount path and nothing else.
 */
export async function measureDisk(
  lease: { readonly handle: Pick<WorkspaceHandle, 'volume'> } | undefined,
): Promise<{ readonly freeBytes: number; readonly exhausted: boolean } | null> {
  const mountPath = lease?.handle.volume?.mountPath;
  if (mountPath === undefined) return null;

  try {
    const usage = await readVolumeUsage(mountPath);

    return { freeBytes: usage.freeBytes, exhausted: usage.freeBytes < 4096 };
  } catch {
    return null;
  }
}

/** `ENOSPC` as the adapter reported it, for the case where space was freed again. */
export function mentionsNoSpace(result: Pick<ExecutionResult, 'error'>): boolean {
  if (result.error === undefined) return false;

  const haystack = `${result.error.code} ${result.error.message}`.toLowerCase();

  return (
    haystack.includes('enospc') ||
    haystack.includes('no space left') ||
    haystack.includes('disk quota exceeded')
  );
}

// ── Gate C: the durable budget marker ───────────────────────────────────────────

function cpuBudgetMarkerDirectory(artifactRoot: string): string {
  return join(artifactRoot, '.cpu-budget');
}

/**
 * How many budget kills this workflow run has already had.
 *
 * A directory of files, one per stop, named `<workflowRunId>-<attemptId>`. Counting is
 * `readdir` + prefix match, which is O(attempts) and cannot be forged by an agent: the
 * directory is under the artifact root, outside every workspace and outside the sandbox's
 * writable mount.
 */
async function countCpuBudgetStops(artifactRoot: string, workflowRunId: string): Promise<number> {
  try {
    const entries = await readdir(cpuBudgetMarkerDirectory(artifactRoot));

    return entries.filter((entry) => entry.startsWith(`${safeFileSegment(workflowRunId)}-`)).length;
  } catch {
    return 0;
  }
}

async function recordCpuBudgetStop(
  artifactRoot: string,
  workflowRunId: string,
  attemptId: string,
): Promise<void> {
  const directory = cpuBudgetMarkerDirectory(artifactRoot);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  await writeFile(
    join(directory, `${safeFileSegment(workflowRunId)}-${safeFileSegment(attemptId)}`),
    JSON.stringify({ workflowRunId, attemptId, at: new Date().toISOString() }),
    { mode: 0o600 },
  );
}

/** A database id used as a file name. Ids are uuids, but a path is built from a variable. */
function safeFileSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 96);
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
