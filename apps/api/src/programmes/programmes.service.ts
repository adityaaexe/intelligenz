import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import { validateProgrammeGraph, type SubmitProgrammeInput } from '@intelligenz/contracts';
import type { Prisma, PrismaClient } from '@intelligenz/database';
import type { Logger } from 'pino';

import { AuditService } from '../audit/audit.service';
import { AppError } from '../common/errors';
import { LOGGER } from '../common/logger';
import { isUniqueConstraintError } from '../common/prisma-errors';
import { PRISMA_CLIENT } from '../database/database.module';
import {
  OrchestratorService,
  OrchestratorUnavailableError,
  isWorkflowAlreadyStartedError,
} from '../orchestrator/orchestrator.service';
import type { ProgrammeResponse } from './programmes.response';

/**
 * Programme submission — the one API call that starts autonomous continuation.
 *
 * ## What it writes, and in what order
 *
 *   1. **replay** — a submission carrying an `Idempotency-Key` already used returns the
 *      programme the first request created. It does not start a second workflow: the
 *      parent is durable, and a second scheduler for one programme would dispatch every
 *      node twice (the claim would refuse the duplicates, but the programme would look
 *      broken while it happened).
 *   2. **validate** — the graph is checked with `validateProgrammeGraph` (cycles,
 *      self-dependency, duplicates, missing edges, missing acceptance criteria) and every
 *      referenced task is re-read from the database **inside this organisation and this
 *      project**. A client never gets to tell the server which tasks exist.
 *   3. **persist** — `Programme` + its `ProgrammeTask` nodes + `programme.submitted.v1` in
 *      one transaction. Half a graph is not a programme; it is a schedule that silently
 *      skips work.
 *   4. **start** — the parent workflow, after the rows commit. A start failure marks the
 *      programme `failed` with `ORCHESTRATOR_UNAVAILABLE` and returns 503; leaving it
 *      `pending` would report a programme that nothing is running.
 *
 * ## Why validation happens before persistence, and why the workflow repeats it
 *
 * Refusing a graph after writing it would leave a row an operator has to clean up. The
 * workflow repeats the check because a Temporal workflow can be started directly, without
 * ever passing through this service — the parent must not assume its caller was this file.
 *
 * ## What the API does *not* do
 *
 * It does not reserve execution attempts, consume approvals or dispatch tasks. Those
 * happen when a node becomes eligible, which may be hours after this request returns. The
 * API's job ends at "this graph is valid and a scheduler owns it now".
 */

/** Bad graphs are a 400 with the issues under `tasks.<taskId>`. */
const PROGRAMME_GRAPH_INVALID = 'PROGRAMME_GRAPH_INVALID' as const;

/** How long a programme may keep dispatching before it reports `timed_out`. */
const PROGRAMME_DEADLINE_MS = 6 * 60 * 60 * 1_000;

const PROGRAMME_SELECT = {
  id: true,
  orgId: true,
  projectId: true,
  objective: true,
  status: true,
  failureReason: true,
  createdAt: true,
  startedAt: true,
  finishedAt: true,
  tasks: {
    orderBy: { taskId: 'asc' },
    select: { taskId: true, dependsOn: true, status: true, attemptCount: true },
  },
} as const;

type ProgrammeRow = Prisma.ProgrammeGetPayload<{ select: typeof PROGRAMME_SELECT }>;

@Injectable()
export class ProgrammesService {
  constructor(
    @Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient,
    @Inject(OrchestratorService) private readonly orchestrator: OrchestratorService,
    @Inject(AuditService) private readonly audit: AuditService,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  async submit(params: {
    orgId: string;
    input: SubmitProgrammeInput;
    idempotencyKey?: string | undefined;
    correlationId: string;
    actorId: string;
  }): Promise<{ programme: ProgrammeResponse; created: boolean }> {
    const { orgId, input, correlationId, actorId } = params;

    // Required in the column, generated when the client did not ask to be idempotent —
    // the same rule `POST /tasks` applies, and the reason a caller that omits the header
    // gets a fresh programme rather than somebody else's.
    const idempotencyKey =
      params.idempotencyKey?.trim() === undefined || params.idempotencyKey.trim().length === 0
        ? randomUUID()
        : params.idempotencyKey.trim();

    const replayed = await this.prisma.programme.findFirst({
      // Tenant scoping: another organisation's key is not this organisation's key.
      where: { orgId, idempotencyKey },
      select: PROGRAMME_SELECT,
    });

    if (replayed !== null) return { programme: toResponse(replayed), created: false };

    const project = await this.prisma.project.findFirst({
      where: { id: input.projectId, orgId },
      select: { id: true },
    });

    if (project === null) throw AppError.notFound('Project');

    const requestedIds = [...new Set(input.tasks.map((node) => node.taskId))];

    const tasks = await this.prisma.task.findMany({
      // Three predicates, not one: id, tenant, and the programme's project. A task in
      // another project of the same organisation is not this programme's work.
      where: { id: { in: requestedIds }, orgId, projectId: input.projectId },
      select: { id: true, acceptanceCriteria: true },
    });

    const byId = new Map(tasks.map((task) => [task.id, task]));

    const missing = requestedIds.filter((taskId) => !byId.has(taskId));

    if (missing.length > 0) {
      throw new AppError(
        400,
        PROGRAMME_GRAPH_INVALID,
        'The programme references tasks that do not exist in this project.',
        { graph: missing.map((taskId) => `Task ${taskId} does not exist in this project.`) },
      );
    }

    const graph = validateProgrammeGraph(
      input.tasks.map((node) => ({
        taskId: node.taskId,
        dependsOn: node.dependsOn,
        acceptanceCriteria: byId.get(node.taskId)?.acceptanceCriteria ?? [],
      })),
    );

    if (!graph.ok) {
      const details: Record<string, string[]> = {};

      for (const issue of graph.issues) {
        const key = issue.taskId === null ? 'graph' : `tasks.${issue.taskId}`;
        details[key] = [...(details[key] ?? []), issue.message];
      }

      throw new AppError(
        400,
        PROGRAMME_GRAPH_INVALID,
        'The programme graph is not schedulable.',
        details,
      );
    }

    let programme: ProgrammeRow;

    try {
      const created = await this.prisma.$transaction(async (transaction) => {
        const row = await transaction.programme.create({
          data: {
            orgId,
            projectId: input.projectId,
            objective: input.objective,
            idempotencyKey,
          },
          select: { id: true },
        });

        await transaction.programmeTask.createMany({
          data: input.tasks.map((node) => ({
            orgId,
            programmeId: row.id,
            taskId: node.taskId,
            // Deduplicated: the same edge twice changes no schedule, and storing it twice
            // would make the graph read as if it had two dependencies.
            dependsOn: [...new Set(node.dependsOn)],
          })),
        });

        await this.audit.recordWithin(transaction, {
          orgId,
          projectId: input.projectId,
          actor: { type: 'user', id: actorId },
          action: 'programme.submitted',
          eventType: 'programme.submitted.v1',
          aggregateType: 'Programme',
          aggregateId: row.id,
          correlationId,
          idempotencyKey: `programme.submitted:${row.id}`,
          payload: {
            objective: input.objective,
            tasks: input.tasks.map((node) => node.taskId),
            edges: input.tasks.map((node) => ({
              taskId: node.taskId,
              dependsOn: [...new Set(node.dependsOn)],
            })),
          },
        });

        return row;
      });

      // Read back, not echoed: the response is the committed graph. Returning the row the
      // `create` call produced would report an empty `tasks` list, because the nodes are
      // written after it inside the same transaction.
      programme = await this.prisma.programme.findUniqueOrThrow({
        where: { id: created.id },
        select: PROGRAMME_SELECT,
      });
    } catch (error) {
      // Two submissions with the same key racing past the replay lookup. The unique index
      // is the authority and the loser created nothing (the transaction rolled back), so
      // the honest answer is the winner's programme.
      if (isUniqueConstraintError(error)) {
        const winner = await this.prisma.programme.findFirst({
          where: { orgId, idempotencyKey },
          select: PROGRAMME_SELECT,
        });

        if (winner !== null) return { programme: toResponse(winner), created: false };
      }

      throw error;
    }

    try {
      await this.orchestrator.startProgrammeWorkflow({
        programmeId: programme.id,
        orgId,
        // A property of the submission, not of whichever worker replays it.
        deadlineAt: new Date(Date.now() + PROGRAMME_DEADLINE_MS).toISOString(),
      });
    } catch (error) {
      const unavailable =
        error instanceof OrchestratorUnavailableError || isWorkflowAlreadyStartedError(error);

      // Marked failed rather than left pending: nothing is running it, and a `pending`
      // programme would be a row that claims otherwise. The graph survives, so an operator
      // can read what was submitted.
      await this.prisma.programme.updateMany({
        where: { id: programme.id, orgId, status: 'pending' },
        data: {
          status: 'failed',
          failureReason: unavailable ? 'ORCHESTRATOR_UNAVAILABLE' : 'START_FAILED',
          finishedAt: new Date(),
        },
      });

      if (!unavailable) throw error;

      this.logger.warn(
        { orgId, programmeId: programme.id, err: describeStartFailure(error) },
        'programme persisted but the parent workflow could not be started',
      );

      throw new AppError(
        503,
        'ORCHESTRATOR_UNAVAILABLE',
        'The programme was recorded but the orchestrator is unavailable, so nothing is running it.',
        { programmeId: [programme.id] },
      );
    }

    this.logger.info(
      { orgId, programmeId: programme.id, tasks: programme.tasks.length },
      'programme submitted',
    );

    return { programme: toResponse(programme), created: true };
  }

  /**
   * Org-scoped read of one programme.
   *
   * Added for the plan layer: `POST /plans/:id/submit` must be able to answer a replay with
   * the programme the first submission created, and duplicating `PROGRAMME_SELECT` /
   * `toResponse` in another service would let the two response shapes drift. Cross-tenant
   * reads are 404 for the same reason as everywhere else.
   */
  async detail(orgId: string, programmeId: string): Promise<ProgrammeResponse> {
    const programme = await this.prisma.programme.findFirst({
      where: { id: programmeId, orgId },
      select: PROGRAMME_SELECT,
    });

    if (programme === null) throw AppError.notFound('Programme');

    return toResponse(programme);
  }
}

function toResponse(row: ProgrammeRow): ProgrammeResponse {
  return {
    programmeId: row.id,
    projectId: row.projectId,
    objective: row.objective,
    status: row.status,
    failureReason: row.failureReason,
    createdAt: row.createdAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
    tasks: row.tasks.map((task) => ({
      taskId: task.taskId,
      dependsOn: task.dependsOn,
      status: task.status,
      attemptCount: task.attemptCount,
    })),
  };
}

/** A start failure's reason, without a driver message leaking a host or a credential. */
function describeStartFailure(error: unknown): string {
  if (error instanceof OrchestratorUnavailableError) return error.message;
  if (isWorkflowAlreadyStartedError(error)) return 'workflow_already_started';

  return error instanceof Error ? error.name : 'unknown';
}
