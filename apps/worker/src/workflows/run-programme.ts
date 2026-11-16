import {
  validateProgrammeGraph,
  type ProgrammeGraphNode,
  type ProgrammeReasonCode,
} from '@intelligenz/contracts';
import {
  CancellationScope,
  continueAsNew,
  isCancellation,
  log,
  proxyActivities,
  startChild,
  uuid4,
  workflowInfo,
  WorkflowIdReusePolicy,
  type ChildWorkflowHandle,
} from '@temporalio/workflow';

import type * as activitiesModule from '../activities';
import type { RunTaskWorkflowResult } from '../shared/contracts';
import {
  NODE_STATUS_BY_OUTCOME,
  type LoadProgrammeActivityResult,
  type ProgrammeCheckpointEvidence,
  type ProgrammeCheckpointOutcome,
  type ProgrammeNode,
  type ProgrammeNodeStatus,
  type ProgrammeReservationRelease,
  type ProgrammeRunStatus,
  type RunProgrammeWorkflowInput,
  type RunProgrammeWorkflowResult,
} from '../shared/programme';
import { WORKFLOW_ID_PREFIX } from '../shared/workflow-ids';
import { runTaskWorkflow } from './run-task';

/**
 * `runProgrammeWorkflow` — the parent that turns a graph into a sequence of executions.
 *
 * ```
 * load graph ─► validate ─► loop:
 *                             compute ready set
 *                             reserve an attempt per ready node   (activity)
 *                             startChild(runTaskWorkflow)         (the existing workflow)
 *                             await, record checkpoint            (activity)
 *                           ─► finish                             (activity)
 * ```
 *
 * ## What this file is not
 *
 * It is not a second task orchestrator. It does not validate a task's risk, spend an
 * approval, take the execution claim, capture evidence or write a terminal task status.
 * Every one of those stays inside `runTaskWorkflow`, which is dispatched unchanged. The
 * parent's only authority is "which task starts now", and even that is narrowed by the
 * reservation activity, which refuses an approval-gated node rather than authorising it.
 *
 * ## Why a parent workflow at all
 *
 * Because Temporal already provides the properties a polling scheduler would have to
 * reimplement: durability, replay, child cancellation, and the absence of double-dispatch
 * (workflow execution is single-threaded). `POST /run` could not be looped from the API —
 * the API is not running when task A finishes three hours later.
 *
 * ## Determinism
 *
 * No `Date.now()`, no `Math.random()`, no Prisma, no `fs`. Time comes from
 * `workflowInfo().unsafe.now()`, ids from the activities, and every decision is a pure
 * function of the loaded graph plus the children's results. `import type * as activities`
 * is erased at build time.
 *
 * ## Bounds
 *
 *   - **concurrency** — at most `maxConcurrent` children in flight (default 1; see
 *     `RunProgrammeWorkflowInput.maxConcurrent` for why the default is not higher);
 *   - **deadline** — `deadlineAt` is a soft ceiling: no new node is dispatched after it,
 *     and the programme is finished `timed_out` with whatever it had;
 *   - **history** — Continue-As-New before Temporal's own suggestion, at a checkpoint
 *     boundary where no child is in flight. The trigger is the SDK's suggestion (actual
 *     history growth) or, failing that, a checkpoint count for **this execution**
 *     (`continueAfterCheckpoints`, clamped, default 200). The next execution reloads
 *     everything from Postgres, so no state is lost — and the checkpoint count it reloads
 *     is what keeps the sequence numbering monotonic instead of restarting at 0.
 *
 * ## Failure isolation
 *
 * A permanently failed child fails **its node**, not the programme's other branches. Only
 * that node's dependents are blocked, and each is recorded with the dependency that
 * blocked it. Independent work continues.
 */

/**
 * Programme activities are database calls, not agent runs: 30s is generous, and a lost
 * compare-and-swap returns a value rather than retrying.
 */
const programmeActivities = proxyActivities<typeof activitiesModule.activities>({
  startToCloseTimeout: '30s',
  scheduleToCloseTimeout: '2m',
  retry: {
    maximumAttempts: 3,
    initialInterval: '500ms',
    backoffCoefficient: 2,
  },
});

/**
 * The child's budget. Mirrors `POST /run`'s `workflowRunTimeout` (10m) so a task executed
 * as a child and a task executed from the API are bounded the same way.
 */
const CHILD_RUN_TIMEOUT = '10m';

/** Default and ceiling for in-flight children. See `maxConcurrent` in the input type. */
const DEFAULT_MAX_CONCURRENT = 1;
const MAX_MAX_CONCURRENT = 4;

/**
 * Continue-As-New after this many checkpoints recorded **in the current execution**, even
 * if the SDK has not suggested it yet. One checkpoint is a handful of history events; 200
 * leaves a wide margin below the 10k-event/50MB defaults while keeping one execution for
 * ordinary programmes.
 *
 * Counted per execution, not cumulatively across generations: the checkpoint total is
 * reloaded after a crossing (it has to be, it is the sequence number), so comparing it to
 * this bound would continue as new again immediately, forever, without recording anything.
 */
const DEFAULT_CONTINUE_AFTER_CHECKPOINTS = 200;

/** The ceiling a caller-supplied `continueAfterCheckpoints` is clamped to. */
const MAX_CONTINUE_AFTER_CHECKPOINTS = 10_000;

/** Node states that make a dependent unrunnable. `pending`/`running` do not. */
const FAILED_DEPENDENCY_STATES: ReadonlySet<ProgrammeNodeStatus> = new Set([
  'failed',
  'blocked',
  'cancelled',
  'waiting_for_approval',
]);

type ProgrammeActivityState = {
  readonly loaded: LoadProgrammeActivityResult;
  readonly nodes: readonly ProgrammeNode[];
  readonly status: Map<string, ProgrammeNodeStatus>;
  readonly recorded: ReadonlyMap<string, string>;
  /** The next checkpoint's sequence number. Reloaded after Continue-As-New, never 0 again
   * once a checkpoint exists — `@@unique([programmeId, sequence])` would refuse the write. */
  sequence: number;
  /**
   * Checkpoints recorded by **this** execution. The Continue-As-New backstop reads this,
   * not `sequence`: `sequence` is carried across generations, so measuring it would make a
   * crossed programme cross again on its first loop iteration, for ever.
   */
  recordedThisExecution: number;
};

export async function runProgrammeWorkflow(
  input: RunProgrammeWorkflowInput,
): Promise<RunProgrammeWorkflowResult> {
  try {
    return await drive(input);
  } catch (error) {
    if (!isCancellation(error)) throw error;

    // The scope is already cancelled: an activity started there would be cancelled before
    // it reached the server, leaving the programme `running` forever.
    await CancellationScope.nonCancellable(async () => {
      await programmeActivities
        .finishProgrammeActivity({
          programmeId: input.programmeId,
          orgId: input.orgId,
          status: 'cancelled',
          reason: 'The programme workflow was cancelled; no further task was dispatched.',
          code: 'CANCELLED',
        })
        .catch((finishError: unknown) => {
          log.error('could not record programme cancellation', {
            programmeId: input.programmeId,
            error: finishError instanceof Error ? finishError.message : String(finishError),
          });
        });
    });

    // Rethrown so Temporal records the execution as cancelled rather than as a successful
    // workflow that happened to stop early.
    throw error;
  }
}

async function drive(input: RunProgrammeWorkflowInput): Promise<RunProgrammeWorkflowResult> {
  const { programmeId, orgId } = input;

  const loaded = await programmeActivities.loadProgrammeActivity({ programmeId, orgId });
  const state: ProgrammeActivityState = {
    loaded,
    nodes: loaded.nodes,
    status: new Map(loaded.nodes.map((node) => [node.taskId, node.status])),
    recorded: new Map(
      loaded.checkpoints.map((checkpoint) => [checkpoint.taskId, checkpoint.outcome]),
    ),
    sequence: loaded.checkpointCount,
    recordedThisExecution: 0,
  };

  // A programme that already reached a terminal status has no work to schedule. Defensive:
  // the API answers a duplicate submission from the row and starts no second workflow.
  if (isTerminalProgrammeStatus(loaded.programme.status)) {
    return summarise(state);
  }

  const graph = validateProgrammeGraph(
    state.nodes.map((node): ProgrammeGraphNode => ({
      taskId: node.taskId,
      dependsOn: node.dependsOn,
      acceptanceCriteria: node.acceptanceCriteria,
    })),
  );

  if (!graph.ok) {
    // Refused before a single dispatch. The API validates the same graph, but a workflow
    // can be started directly and the parent must not trust that it was.
    const reason = graph.issues.map((issue) => issue.message).join(' ');

    await finish(state, input, 'failed', {
      code: 'GRAPH_INVALID',
      prose: `GRAPH_INVALID: ${reason}`,
    });
    return summarise(state);
  }

  await reconcileInterruptedNodes(state, input);

  const deadline = Date.parse(input.deadlineAt);
  const maxConcurrent = clampConcurrency(input.maxConcurrent);
  const continueAfterCheckpoints = clampContinueAfter(input.continueAfterCheckpoints);

  for (;;) {
    // ── Blocked cascade: dependents of a failure can never run ──────────────
    // Repeated until stable, because blocking a node can block the next one. The order is
    // the node order, so the checkpoints a client reads are deterministic.
    while (await blockDependents(state, input)) {
      // Each pass records at least one node; the loop ends when a pass changes nothing.
    }

    const open = state.nodes.filter((node) => state.status.get(node.taskId) === 'pending');

    if (open.length === 0) break;

    if (workflowInfo().unsafe.now() >= deadline) {
      await finish(state, input, 'timed_out', {
        code: 'DEADLINE_EXCEEDED',
        prose: 'DEADLINE_EXCEEDED: no node was dispatched after the deadline.',
      });
      return summarise(state);
    }

    if (shouldContinueAsNew(state, continueAfterCheckpoints)) {
      // No child is in flight here — the loop only reaches this point between rounds.
      // The next execution reloads the graph, the node states and the checkpoint count.
      log.info('continuing programme as new', {
        programmeId,
        checkpoints: state.sequence,
        checkpointsThisExecution: state.recordedThisExecution,
        historySize: workflowInfo().historySize,
      });

      await continueAsNew<typeof runProgrammeWorkflow>(input);
    }

    const ready = state.nodes.filter(
      (node) =>
        state.status.get(node.taskId) === 'pending' &&
        node.dependsOn.every((dependency) => state.status.get(dependency) === 'succeeded'),
    );

    if (ready.length === 0) {
      // Nothing is runnable and nothing failed: every remaining node is waiting on a node
      // that is also waiting. A validated graph cannot reach this state, so it is a bug,
      // not a plan — reported as blocked instead of spinning.
      await finish(state, input, 'blocked', {
        code: 'NO_READY_NODE',
        prose:
          'NO_READY_NODE: the remaining nodes are waiting on each other; the graph was not schedulable.',
      });
      return summarise(state);
    }

    await dispatch(state, input, ready.slice(0, maxConcurrent));
  }

  const status = programmeStatus(state);
  await finish(state, input, status, reasonFor(status, state));

  return summarise(state);
}

/**
 * Dispatches one batch and awaits it in dispatch order.
 *
 * Starting all reservations first and awaiting afterwards is what makes the batch
 * concurrent; awaiting in a `for` loop (rather than `Promise.all`) keeps the order
 * deterministic and means one child's failure does not cancel its siblings. Temporal
 * cancels children with their parent, not with each other.
 */
async function dispatch(
  state: ProgrammeActivityState,
  input: RunProgrammeWorkflowInput,
  batch: readonly ProgrammeNode[],
): Promise<void> {
  const dispatched: {
    readonly node: ProgrammeNode;
    readonly handle: ChildWorkflowHandle<typeof runTaskWorkflow>;
    readonly attemptId: string;
    readonly workflowRunId: string;
  }[] = [];

  for (const node of batch) {
    // One correlation id for everything this dispatch writes: the reservation's audit row
    // and the child's own events. `uuid4()` is seeded per run, so a replay produces the
    // same id — which is what makes the audit row idempotent instead of duplicated.
    const correlationId = uuid4();

    const reservation = await programmeActivities.reserveProgrammeTaskActivity({
      programmeId: input.programmeId,
      orgId: input.orgId,
      taskId: node.taskId,
      // Deterministic: the node's last recorded attempt plus one. A retried activity sees
      // the same number and therefore the same reservation.
      attemptNumber: node.attemptCount + 1,
      correlationId,
    });

    switch (reservation.outcome) {
      case 'reserved': {
        const childWorkflowId = `${WORKFLOW_ID_PREFIX}${node.taskId}`;

        try {
          const handle = await startChild(runTaskWorkflow, {
            // The task's own id space, exactly as `POST /run` starts a top-level run and
            // exactly as `POST /cancel` cancels one. The SDK would otherwise mint a random
            // uuid4 and the child would be unreachable: cancellation would answer
            // `not_found` while the child kept working, and the pre-dispatch completion
            // arm — which requires this derived id — could never record a refusal for a
            // child cancelled before it claimed.
            workflowId: childWorkflowId,
            // Same policy as the API's `WORKFLOW_ID_REUSE_POLICY`: a live duplicate is
            // still refused (one execution per task id), while a run that already closed
            // as failed/cancelled may be replaced by a retry.
            workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE_FAILED_ONLY,
            args: [
              {
                taskId: node.taskId,
                orgId: input.orgId,
                correlationId,
                attemptId: reservation.attemptId,
              },
            ],
            // Same ceiling the API gives a top-level run.
            workflowRunTimeout: CHILD_RUN_TIMEOUT,
            // One attempt, deliberately. A workflow-level retry would re-enter with the same
            // spent attempt and be refused by the claim; the task's own activity retries are
            // where a transient failure is absorbed.
            retry: { maximumAttempts: 1 },
          });

          dispatched.push({
            node,
            handle,
            attemptId: reservation.attemptId,
            workflowRunId: reservation.workflowRunId,
          });
        } catch (error) {
          // Cancellation is not a dispatch fault. The parent is stopping; the child, if it
          // did start, owns its own rows and its own `recordCancellation`. Compensating
          // here would put the task back in `ready` for a scheduler that is going away.
          if (isCancellation(error)) throw error;

          // The reservation committed and nothing is running it: without this, the task
          // stays `queued` with an unclaimed attempt and a `queued` run that no sweep
          // reclaims (`claim-release` only selects claimed attempts; `POST /run` requires
          // `ready`). The same compensation `POST /run` performs for the same failure.
          const reason = `START_FAILED: the child execution for task ${node.taskId} could not be started: ${describeFailure(error)}`;

          await checkpoint(
            state,
            input,
            node,
            'dispatch_failed',
            {
              attemptId: reservation.attemptId,
              workflowRunId: reservation.workflowRunId,
              childWorkflowId,
              reason,
            },
            {
              workflowRunId: reservation.workflowRunId,
              attemptId: reservation.attemptId,
              reason,
            },
          );
        }

        break;
      }

      case 'already_succeeded': {
        await checkpoint(state, input, node, 'already_succeeded', {
          reason: 'The task was already succeeded before the programme reached it.',
        });
        break;
      }

      case 'approval_required': {
        // Not a failure: a human still has to approve. The node is settled for this run
        // and only its dependents wait — independent branches keep going.
        await checkpoint(state, input, node, 'waiting_for_approval', {
          reason:
            'The task requires an approval. A programme does not spend approval grants: ' +
            'reserve the run through POST /run once the grant exists.',
        });
        break;
      }

      case 'not_found': {
        await checkpoint(state, input, node, 'failed', {
          reason: 'The task no longer exists in this organisation and project.',
        });
        break;
      }

      case 'precondition_failed': {
        // The task really did fail: the node is failed and its dependents block.
        await checkpoint(state, input, node, 'precondition_failed', {
          reason: reservation.detail,
          summary: reservation.taskStatus,
        });
        break;
      }

      case 'held_elsewhere': {
        // Another execution holds the task and may well be running it to success. This is
        // a scheduling observation, not a task failure: the node is blocked, not failed,
        // and the programme's own verdict stays `blocked` rather than `failed`.
        await checkpoint(state, input, node, 'held_elsewhere', {
          reason: reservation.detail,
          summary: reservation.taskStatus,
        });
        break;
      }

      case 'programme_terminal': {
        // The row this scheduler acts for is finished — cancelled, in practice. Nothing
        // may be reserved, and no node of it is runnable.
        await checkpoint(state, input, node, 'programme_terminal', {
          reason: reservation.detail,
          summary: reservation.programmeStatus,
        });
        break;
      }

      case 'not_runnable': {
        // Neither terminal nor held by anybody: `draft`, `blocked`, `verifying`. Nothing
        // failed, so the node waits rather than failing the programme.
        await checkpoint(state, input, node, 'blocked', {
          reason: reservation.detail,
          summary: reservation.taskStatus,
        });
        break;
      }

      default: {
        // Fail closed. A reservation answer this build does not recognise — an activity
        // newer than the workflow during a rolling deploy — must never be read as "start
        // the child anyway", and must never fall through to a checkpoint that could read
        // as success. `dispatch_failed` fails the node and blocks its dependents.
        const unknown = reservation as { readonly outcome?: unknown };

        await checkpoint(state, input, node, 'dispatch_failed', {
          reason:
            'PROGRAMME_RESERVATION_OUTCOME_UNKNOWN: the reservation activity answered ' +
            `"${String(unknown.outcome)}", which this scheduler does not understand.`,
        });
        break;
      }
    }
  }

  for (const entry of dispatched) {
    let outcome: ProgrammeCheckpointOutcome;
    let evidence: ProgrammeCheckpointEvidence;

    try {
      const result = (await entry.handle.result()) as RunTaskWorkflowResult;

      outcome =
        result.status === 'succeeded'
          ? 'succeeded'
          : result.status === 'cancelled'
            ? 'cancelled'
            : 'failed';

      evidence = {
        attemptId: entry.attemptId,
        workflowRunId: entry.workflowRunId,
        childWorkflowId: entry.handle.workflowId,
        childRunId: entry.handle.firstExecutionRunId,
        summary: result.summary,
      };
    } catch (error) {
      // The child's own workflow failed rather than returning a verdict: cancellation, a
      // determinism error, or an activity that exhausted its retries inside the child's
      // own handling. Recorded as a failure with the message that survived the boundary.
      outcome = isCancellation(error) ? 'cancelled' : 'failed';
      evidence = {
        attemptId: entry.attemptId,
        workflowRunId: entry.workflowRunId,
        childWorkflowId: entry.handle.workflowId,
        childRunId: entry.handle.firstExecutionRunId,
        reason: describeFailure(error),
      };
    }

    await checkpoint(state, input, entry.node, outcome, evidence);
  }
}

/**
 * Blocks every pending node whose dependency ended badly, and records why.
 *
 * Returns `true` when at least one node changed, so the caller can repeat until stable.
 * The dependency list in the evidence is the point: "blocked by A" is answerable from the
 * checkpoint without reconstructing the graph.
 */
async function blockDependents(
  state: ProgrammeActivityState,
  input: RunProgrammeWorkflowInput,
): Promise<boolean> {
  let changed = false;

  for (const node of state.nodes) {
    if (state.status.get(node.taskId) !== 'pending') continue;

    const blocking = node.dependsOn.filter((dependency) => {
      const dependencyStatus = state.status.get(dependency);

      // A dependency that is not in the graph at all is treated as failed here as well as
      // rejected by validation: fail closed if the two ever disagree.
      return dependencyStatus === undefined || FAILED_DEPENDENCY_STATES.has(dependencyStatus);
    });

    if (blocking.length === 0) continue;

    await checkpoint(state, input, node, 'blocked', {
      reason: `A dependency did not succeed: ${blocking.join(', ')}.`,
    });

    changed = true;
  }

  return changed;
}

/**
 * Reconciles nodes left `running` by an earlier attempt of this programme.
 *
 * A `running` node means "reserved and dispatched". If the task has since reached a
 * terminal status, the outcome is read from the task itself. If it has not, this workflow
 * has no handle to that execution — it cannot await a child it did not start in this
 * history — so the node is failed with a reason that says exactly that, rather than
 * re-dispatched against a reservation that is already held.
 */
async function reconcileInterruptedNodes(
  state: ProgrammeActivityState,
  input: RunProgrammeWorkflowInput,
): Promise<void> {
  for (const node of state.nodes) {
    if (node.status !== 'running') continue;

    const recorded = state.recorded.get(node.taskId);

    if (recorded !== undefined) {
      // Already reported by a previous scheduler run; adopt what was written.
      state.status.set(
        node.taskId,
        NODE_STATUS_BY_OUTCOME[recorded as ProgrammeCheckpointOutcome] ?? 'failed',
      );
      continue;
    }

    if (node.taskStatus === 'succeeded') {
      await checkpoint(state, input, node, 'succeeded', {
        reason: 'Reconciled: the task succeeded while the programme was not observing it.',
      });
      continue;
    }

    if (node.taskStatus === 'failed' || node.taskStatus === 'cancelled') {
      await checkpoint(state, input, node, node.taskStatus, {
        reason: `Reconciled: the task is ${node.taskStatus}.`,
      });
      continue;
    }

    await checkpoint(state, input, node, 'dispatch_failed', {
      reason:
        `The node was dispatched by an earlier scheduler run and the task is "${node.taskStatus}". ` +
        'This execution has no handle to await it and will not dispatch a second attempt ' +
        'against a reservation that is already held.',
      summary: node.taskStatus,
    });
  }
}

/** Records one checkpoint and moves the in-memory state with it. */
async function checkpoint(
  state: ProgrammeActivityState,
  input: RunProgrammeWorkflowInput,
  node: ProgrammeNode,
  outcome: ProgrammeCheckpointOutcome,
  evidence: ProgrammeCheckpointEvidence | null,
  release?: ProgrammeReservationRelease,
): Promise<void> {
  state.sequence += 1;
  state.recordedThisExecution += 1;

  await programmeActivities.recordProgrammeCheckpointActivity({
    programmeId: input.programmeId,
    orgId: input.orgId,
    sequence: state.sequence,
    taskId: node.taskId,
    outcome,
    evidence,
    // Only a dispatch that never produced a child carries one: the activity then releases
    // the reservation the start left behind, in the same transaction as this record.
    ...(release === undefined ? {} : { release }),
  });

  // Only after the write: an in-memory state that disagrees with the database would make
  // the next dispatch decision wrong in exactly the case (a retry) where it matters.
  state.status.set(node.taskId, NODE_STATUS_BY_OUTCOME[outcome]);
}

/** A terminal verdict in both forms the row needs: prose for a person, a code for a query. */
interface ProgrammeFinishReason {
  readonly code: ProgrammeReasonCode | null;
  readonly prose: string;
}

async function finish(
  state: ProgrammeActivityState,
  input: RunProgrammeWorkflowInput,
  status: ProgrammeRunStatus | 'cancelled',
  reason: ProgrammeFinishReason,
): Promise<void> {
  await programmeActivities.finishProgrammeActivity({
    programmeId: input.programmeId,
    orgId: input.orgId,
    status,
    reason: reason.prose,
    code: reason.code,
  });

  log.info('programme finished', {
    programmeId: input.programmeId,
    status,
    code: reason.code,
    checkpoints: state.sequence,
  });
}

/**
 * The programme's verdict, derived from its nodes rather than from the loop.
 *
 * `failed` when any node failed or was cancelled; `blocked` when work remains that cannot
 * run (a waiting approval, a blocked branch); `succeeded` only when every node succeeded.
 * A programme that reported success while a node was blocked would be the same lie the
 * Phase 7 document validator exists to prevent.
 */
function programmeStatus(state: ProgrammeActivityState): ProgrammeRunStatus {
  const statuses = state.nodes.map((node) => state.status.get(node.taskId) ?? 'pending');

  if (statuses.some((status) => status === 'failed' || status === 'cancelled')) return 'failed';
  if (statuses.some((status) => status !== 'succeeded')) return 'blocked';

  return 'succeeded';
}

/**
 * The verdict as prose and as a code.
 *
 * The order is the precedence the codes carry: a failure outranks a waiting approval, which
 * outranks a blocked branch, because that is the order in which an operator has to act on
 * them. `UNSPECIFIED` is the last line and is expected to be unreachable from here — the
 * loop cannot end with a pending node — but a terminal row that says "unclassified" is
 * honest, while one that guesses `DEPENDENCY_BLOCKED` would not be.
 */
function reasonFor(
  status: ProgrammeRunStatus,
  state: ProgrammeActivityState,
): ProgrammeFinishReason {
  if (status === 'succeeded') {
    return { code: null, prose: 'Every task in the programme succeeded.' };
  }

  const broken = state.nodes.filter((node) => {
    const nodeStatus = state.status.get(node.taskId);
    return nodeStatus === 'failed' || nodeStatus === 'cancelled';
  });
  const waiting = state.nodes.filter(
    (node) => state.status.get(node.taskId) === 'waiting_for_approval',
  );

  if (broken.length > 0) {
    const brokenIds = broken.map((node) => node.taskId);
    // A cancelled node is not a failed one, and the sentence says which happened rather than
    // calling both "failure". The code is the same either way: `TASK_FAILED` is the code for
    // "a node's work did not succeed", and its cause is on the checkpoint.
    const noun = broken.some((node) => state.status.get(node.taskId) === 'failed')
      ? 'failure'
      : 'cancellation';

    return {
      code: 'TASK_FAILED',
      prose: `Task ${noun} in ${brokenIds.join(', ')}; dependents were blocked, independent branches ran.`,
    };
  }

  if (waiting.length > 0) {
    return {
      code: 'APPROVAL_PENDING',
      prose: `Waiting for approval on ${waiting.map((node) => node.taskId).join(', ')}.`,
    };
  }

  const blocked = state.nodes.filter((node) => state.status.get(node.taskId) === 'blocked');

  if (blocked.length > 0) {
    return {
      code: 'DEPENDENCY_BLOCKED',
      prose: `Work remains that could not be scheduled: ${blocked
        .map((node) => node.taskId)
        .join(', ')}.`,
    };
  }

  return { code: 'UNSPECIFIED', prose: 'Work remains that could not be scheduled.' };
}

function summarise(state: ProgrammeActivityState): RunProgrammeWorkflowResult {
  const statuses = state.nodes.map((node) => state.status.get(node.taskId) ?? 'pending');
  const count = (status: ProgrammeNodeStatus): number =>
    statuses.filter((candidate) => candidate === status).length;

  return {
    status: programmeStatus(state),
    succeeded: count('succeeded'),
    failed: count('failed') + count('cancelled'),
    blocked: count('blocked') + count('waiting_for_approval') + count('pending'),
    checkpoints: state.sequence,
  };
}

function shouldContinueAsNew(
  state: ProgrammeActivityState,
  continueAfterCheckpoints: number,
): boolean {
  // The suggestion first: it is the server telling us the history this execution is
  // actually accumulating. The count is the deterministic backstop for a history that grows
  // without the suggestion arriving, and it is per execution — see the constant's comment.
  return (
    workflowInfo().continueAsNewSuggested || state.recordedThisExecution >= continueAfterCheckpoints
  );
}

function clampConcurrency(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_MAX_CONCURRENT;

  return Math.min(Math.max(Math.trunc(requested), 1), MAX_MAX_CONCURRENT);
}

/**
 * The Continue-As-New backstop, bounded.
 *
 * A directly started execution may pass anything; `0`, a negative number or `Infinity` would
 * otherwise disable the bound silently, which is the one thing a backstop may not do.
 */
function clampContinueAfter(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) {
    return DEFAULT_CONTINUE_AFTER_CHECKPOINTS;
  }

  return Math.min(Math.max(Math.trunc(requested), 1), MAX_CONTINUE_AFTER_CHECKPOINTS);
}

function isTerminalProgrammeStatus(
  status: LoadProgrammeActivityResult['programme']['status'],
): boolean {
  return (
    status === 'succeeded' ||
    status === 'failed' ||
    status === 'blocked' ||
    status === 'cancelled' ||
    status === 'timed_out'
  );
}

/**
 * The error's message, without Temporal's wrapper.
 *
 * A child that failed surfaces as `ChildWorkflowFailure` → … → the real error. The chain
 * is walked because the useful sentence is at the bottom, and a checkpoint that says
 * "ChildWorkflowFailure" tells an operator nothing.
 */
function describeFailure(error: unknown, depth = 0): string {
  if (depth > 6 || typeof error !== 'object' || error === null) return String(error);

  const candidate = error as { message?: unknown; cause?: unknown };

  if (typeof candidate.message === 'string' && candidate.message.length > 0) {
    return candidate.message;
  }

  return describeFailure(candidate.cause, depth + 1);
}
