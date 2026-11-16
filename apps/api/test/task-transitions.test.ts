import type { TaskStatus } from '@intelligenz/contracts';
import type { PrismaClient } from '@intelligenz/database';
import type { Logger } from 'pino';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '../src/common/errors';
import type { ArtifactsService } from '../src/artifacts/artifacts.service';
import type { AuditService } from '../src/audit/audit.service';
import type {
  ApprovalGateResult,
  ApprovalGateService,
} from '../src/approvals/approval-gate.service';
import type { AppConfig } from '../src/config/app-config';
import type { OrchestratorService } from '../src/orchestrator/orchestrator.service';
import { HUMAN_TRANSITIONS, isHumanTransition } from '../src/tasks/human-transitions';
import { TasksService } from '../src/tasks/tasks.service';

/**
 * The fabrication path.
 *
 * A MEMBER could send four `PATCH` calls —
 *
 *   ready → queued → running → verifying → succeeded
 *
 * — and produce a terminal `succeeded` task with no workflow run, no agent run and
 * no artifact. The state machine said each edge was legal, which is exactly why
 * the machine cannot be the authorisation model for `PATCH`. These tests assert
 * the API layer refuses every system-managed edge and that the task is left in the
 * state it was in, never terminal.
 */

const TASK_ID = '9d0e5c1a-1f2b-4c3d-8e4f-5a6b7c8d9e0f';
const ORG_ID = '6f1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b';
const PROJECT_ID = '1a2b3c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';
const WORKSPACE_ID = '2b3c4d5e-6f7a-4b8c-9d0e-1f2a3b4c5d6e';

/**
 * The config `TasksService` is constructed with. `updateStatus` reads none of it (the two
 * fields below are stated because `AppConfig` is a closed contract), so these are the
 * documented defaults, not tuned values.
 */
const config: AppConfig = {
  nodeEnv: 'test',
  port: 4100,
  host: '127.0.0.1',
  databaseUrl: 'postgresql://unused/unused',
  jwtSecret: 'Kq7-tR2#vLm9!pXz4w8@nB3yS6',
  jwtTtlSeconds: 900,
  logLevel: 'silent',
  corsOrigins: [],
  temporal: {
    address: 'localhost:7233',
    namespace: 'default',
    taskQueue: 'intelligenz-tasks',
    rpcMaxAttempts: 10,
  },
  readinessTimeoutMs: 2_000,
  artifactRoot: '/tmp/intelligenz-test-artifacts',
  workspaceRoot: '/tmp/intelligenz-test-workspaces',
  approvalTtlHours: 24,
  trustedSourceRepos: [],
  // Phase 8.7. Unconfigured, which is what every test that does not exercise the planner
  // wants: `POST /plans` answers 503 without writing a row.
  planner: {
    baseUrl: null,
    apiKey: null,
    model: null,
    timeoutMs: 30_000,
    approvalTtlHours: 24,
  },
};

interface Row {
  id: string;
  orgId: string;
  projectId: string;
  workspaceId: string;
  title: string;
  goal: string;
  status: TaskStatus;
  riskClass: 'LOW';
  priority: 'normal';
  acceptanceCriteria: string[];
  createdById: string;
  idempotencyKey: string;
  createdAt: Date;
  updatedAt: Date;
}

function makeHarness(): {
  service: TasksService;
  row: Row;
  writes: () => number;
  setStatus: (status: TaskStatus) => void;
  attempt: (status: TaskStatus, reason?: string) => Promise<unknown>;
} {
  const row: Row = {
    id: TASK_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    workspaceId: WORKSPACE_ID,
    title: 'Fabricate a success',
    goal: 'Prove the API refuses a user-driven terminal state',
    status: 'draft',
    riskClass: 'LOW',
    priority: 'normal',
    acceptanceCriteria: ['one'],
    createdById: '4bc8b01a-5e41-5dab-8559-43edc720a061',
    idempotencyKey: 'auto-test',
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
  };

  let writeCount = 0;

  const findFirst = async (args: {
    where: { id: string; orgId: string; status?: TaskStatus };
  }): Promise<Row | null> => {
    if (args.where.id !== row.id || args.where.orgId !== row.orgId) return null;

    // Both reads in `updateStatus` want this row: the first projects four columns,
    // the second returns the full `TASK_SELECT`. Prisma's projection is a typing
    // concern; a fake that returns the row is faithful for the logic under test.
    return row;
  };

  const updateMany = async (args: {
    where: { id: string; orgId: string; status: TaskStatus | { in: TaskStatus[] } };
    data: { status: TaskStatus };
  }): Promise<{ count: number }> => {
    const expected = args.where.status;

    if (expected !== row.status) return { count: 0 };

    writeCount += 1;
    row.status = args.data.status;

    return { count: 1 };
  };

  const transaction = { task: { findFirst, updateMany } };

  const prisma = {
    task: { findFirst, updateMany },
    $transaction: async (fn: (tx: typeof transaction) => Promise<unknown>) => fn(transaction),
  } as unknown as PrismaClient;

  const logger = {
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  } as unknown as Logger;
  const audit = { recordWithin: vi.fn(async () => undefined) } as unknown as AuditService;
  const orchestrator = {} as unknown as OrchestratorService;
  /**
   * Every task here is `LOW` risk, so `requiresApproval` is false and `updateStatus` never
   * consults the gate. The stub throws rather than resolving: if a future change starts
   * asking approvals for a `LOW` transition, this fixture fails loudly instead of
   * approving by accident.
   */
  const approvals = {
    requireLiveApproval: vi.fn(async (): Promise<ApprovalGateResult> => {
      throw new Error('the approval gate must not be reachable from a LOW-risk transition');
    }),
  } as unknown as ApprovalGateService;
  // The service only renders a logical artifact uri for `detail`, which these tests do
  // not exercise; the locator is still required by the constructor.
  const artifacts = { logicalUri: (uri: string) => uri } as unknown as ArtifactsService;

  const service = new TasksService(
    prisma,
    logger,
    audit,
    orchestrator,
    artifacts,
    approvals,
    config,
  );

  return {
    service,
    row,
    writes: () => writeCount,
    setStatus: (status) => {
      row.status = status;
    },
    attempt: (status, reason) =>
      service.updateStatus({
        orgId: ORG_ID,
        taskId: TASK_ID,
        input: { status, ...(reason === undefined ? {} : { reason }) },
        correlationId: 'corr-1',
        actorId: row.createdById,
      }),
  };
}

async function refusalOf(promise: Promise<unknown>): Promise<AppError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AppError) return error;
    throw error;
  }

  throw new Error('the transition was accepted but should have been refused');
}

describe('human transitions', () => {
  it('allows exactly draft→ready and blocked→ready', () => {
    expect(HUMAN_TRANSITIONS).toEqual({ draft: ['ready'], blocked: ['ready'] });
  });

  it.each([
    ['ready', 'queued'],
    ['queued', 'running'],
    ['running', 'verifying'],
    ['verifying', 'succeeded'],
    ['verifying', 'failed'],
    ['running', 'failed'],
  ] as const)('treats %s→%s as system-managed', (from, to) => {
    expect(isHumanTransition(from, to)).toBe(false);
  });
});

describe('TasksService.updateStatus — the fabrication path is refused', () => {
  let harness = makeHarness();

  beforeEach(() => {
    harness = makeHarness();
  });

  it('refuses the four-call path at the second call and leaves the task non-terminal', async () => {
    // Call 1 — the one edge a human owns.
    const promoted = await harness.attempt('ready');
    expect((promoted as { status: TaskStatus }).status).toBe('ready');

    // Call 2 — `ready → queued` is legal in the machine and owned by POST /run.
    const refusal = await refusalOf(harness.attempt('queued'));

    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe('TRANSITION_IS_SYSTEM_MANAGED');

    // Call 3 and 4 cannot even be reached from here.
    expect((await refusalOf(harness.attempt('running'))).status).toBe(422);
    expect((await refusalOf(harness.attempt('succeeded'))).status).toBe(422);

    // The task is exactly where call 1 left it: `ready`, not terminal, and the
    // refused attempts wrote nothing.
    expect(harness.row.status).toBe('ready');
    expect(harness.writes()).toBe(1);
  });

  it.each([
    ['queued', 'running'],
    ['running', 'verifying'],
    ['verifying', 'succeeded'],
    ['verifying', 'failed'],
    ['running', 'failed'],
  ] as const)('refuses %s→%s with 409 TRANSITION_IS_SYSTEM_MANAGED', async (from, to) => {
    harness.setStatus(from);

    const refusal = await refusalOf(harness.attempt(to));

    expect(refusal.status).toBe(409);
    expect(refusal.code).toBe('TRANSITION_IS_SYSTEM_MANAGED');
    expect(harness.row.status).toBe(from);
    expect(harness.writes()).toBe(0);
  });

  it('still allows blocked→ready with a reason', async () => {
    harness.setStatus('blocked');

    const task = await harness.attempt('ready', 'runner was repaired');

    expect((task as { status: TaskStatus }).status).toBe('ready');
  });

  it('still requires a reason for blocked→ready', async () => {
    harness.setStatus('blocked');

    const refusal = await refusalOf(harness.attempt('ready'));

    expect(refusal.status).toBe(400);
    expect(refusal.code).toBe('VALIDATION_ERROR');
    expect(harness.row.status).toBe('blocked');
  });

  it('refuses an edge the machine does not have with 422, not 409', async () => {
    const refusal = await refusalOf(harness.attempt('succeeded'));

    expect(refusal.status).toBe(422);
    expect(refusal.code).toBe('INVALID_TRANSITION');
  });
});
