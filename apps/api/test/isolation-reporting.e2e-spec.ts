import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ISOLATION_TIER_UNAVAILABLE,
  SHARED_KERNEL_MISSING_CONTROLS,
} from '@intelligenz/contracts';

import { authHeaders, login, startSuite, type Suite } from './helpers/app';
import type { DataBody } from './helpers/api-types';

/**
 * Isolation reporting (ADR D-007).
 *
 * D-007 requires every execution to record the tier it ran under and the controls that tier
 * does **not** provide: a UI or API that displays "isolated" without a tier is wrong. This
 * suite is the read side of that rule, over rows shaped exactly as the worker writes them:
 *
 *   - a run that executed carries the report in `AgentRun.providerMeta.isolation`;
 *   - a refused attempt carries it in its own `error`, because it has no `AgentRun` — that
 *     absence is the refusal;
 *   - an attempt from before the tier existed reports `isolation: null`, never a default,
 *     so no client can render an unrecorded run as sandboxed.
 */

interface IsolationBody {
  required: string;
  effective: string | null;
  refused: boolean;
  vmAvailable: boolean;
  controlsUnavailable: string[];
  reason: string;
}

interface AttemptBody {
  id: string;
  attemptNumber: number;
  simulated: boolean;
  status: string;
  error: unknown;
  isolation: IsolationBody | null;
}

interface TaskDetailBody {
  id: string;
  latestAttempt: { id: string; status: string; isolation: IsolationBody | null } | null;
}

const RESTRICTED_REPORT: IsolationBody = {
  required: 'restricted-shared-kernel',
  effective: 'restricted-shared-kernel',
  refused: false,
  vmAvailable: false,
  controlsUnavailable: [...SHARED_KERNEL_MISSING_CONTROLS],
  reason:
    'profile STANDARD declares restricted-shared-kernel; vm unavailable: /dev/kvm is not ' +
    'present (ENOENT); /proc/cpuinfo reports no vmx/svm flag',
};

const REFUSAL_MESSAGE =
  'Isolation tier unavailable: profile VM requires "vm", and this host cannot provide it — ' +
  'vm unavailable: /dev/kvm is not present (ENOENT); /proc/cpuinfo reports no vmx/svm flag. ' +
  'Refused before provisioning: no workspace, no agent process and no broker request were ' +
  'created, and the attempt is recorded as failed. A run that asked for a virtual machine is ' +
  'never served a shared kernel.';

let suite: Suite;
let ownerToken: string;
let executedAttemptId: string;
let refusedAttemptId: string;

beforeAll(async () => {
  suite = await startSuite();

  const orgId = suite.fixtures.orgA.id;

  ownerToken = await login(suite.app, suite.fixtures.users.ownerA.email);

  const startedAt = new Date('2026-11-13T10:00:00.000Z');
  const finishedAt = new Date('2026-11-13T10:00:42.000Z');

  // ── An ordinary run: the worker recorded the tier it actually used ──────────────
  const taskId = suite.fixtures.tasks.draftA;

  const workflowRun = await suite.prisma.workflowRun.create({
    data: {
      orgId,
      taskId,
      workflowId: `task-${taskId}`,
      status: 'succeeded',
      startedAt,
      finishedAt,
    },
  });

  // Attempt #1 stands in for a row written before the tier existed: no agent run, no
  // report. It must read back as "not recorded", not as a default tier.
  await suite.prisma.executionAttempt.create({
    data: {
      orgId,
      taskId,
      workflowRunId: workflowRun.id,
      attemptNumber: 1,
      runtimeId: 'opencode-cli',
      simulated: true,
      status: 'succeeded',
      startedAt,
      finishedAt,
      createdAt: new Date('2026-11-13T09:59:00.000Z'),
    },
  });

  const executed = await suite.prisma.executionAttempt.create({
    data: {
      orgId,
      taskId,
      workflowRunId: workflowRun.id,
      attemptNumber: 2,
      runtimeId: 'opencode-cli',
      simulated: false,
      status: 'succeeded',
      startedAt,
      finishedAt,
      executionProfile: 'standard',
      terminationReason: 'completed',
      createdAt: new Date('2026-11-13T10:00:00.000Z'),
    },
  });

  executedAttemptId = executed.id;

  const agentRun = await suite.prisma.agentRun.create({
    data: {
      orgId,
      workflowRunId: workflowRun.id,
      runtimeId: 'opencode-cli',
      model: 'commandcode/deepseek/deepseek-v4-flash',
      status: 'succeeded',
      startedAt,
      finishedAt,
      attemptNumber: 2,
      simulated: false,
      runtimeVersion: '2.2.7',
      providerMeta: {
        model: 'commandcode/deepseek/deepseek-v4-flash',
        // Spread because Prisma's `InputJsonValue` rejects a named interface: it requires an
        // index signature, which a typed report deliberately does not have.
        isolation: { ...RESTRICTED_REPORT },
      },
    },
  });

  await suite.prisma.executionAttempt.update({
    where: { id: executed.id },
    data: { agentRunId: agentRun.id },
  });

  // ── A refusal: no agent run at all, and the reason on the attempt ───────────────
  const refusedTaskId = suite.fixtures.tasks.queuedA;

  const refusedRun = await suite.prisma.workflowRun.create({
    data: {
      orgId,
      taskId: refusedTaskId,
      workflowId: `task-${refusedTaskId}`,
      status: 'failed',
      startedAt,
      finishedAt,
      error: { code: ISOLATION_TIER_UNAVAILABLE, message: REFUSAL_MESSAGE },
    },
  });

  const refused = await suite.prisma.executionAttempt.create({
    data: {
      orgId,
      taskId: refusedTaskId,
      workflowRunId: refusedRun.id,
      attemptNumber: 1,
      runtimeId: 'local-simulated',
      // Nothing ran, so no model call happened: `simulated` is literal (ADR-006).
      simulated: true,
      status: 'failed',
      startedAt,
      finishedAt,
      executionProfile: 'vm',
      terminationReason: 'isolation_unavailable',
      error: {
        code: ISOLATION_TIER_UNAVAILABLE,
        message: REFUSAL_MESSAGE,
        retryable: false,
        isolation: {
          required: 'vm',
          effective: null,
          refused: true,
          vmAvailable: false,
          controlsUnavailable: [...SHARED_KERNEL_MISSING_CONTROLS],
          reason:
            'vm unavailable: /dev/kvm is not present (ENOENT); /proc/cpuinfo reports no ' +
            'vmx/svm flag',
        },
      },
      createdAt: new Date('2026-11-13T10:01:00.000Z'),
    },
  });

  refusedAttemptId = refused.id;
});

afterAll(async () => {
  await suite.close();
});

function executionsPath(taskId: string): string {
  return `/v1/orgs/${suite.fixtures.orgA.id}/tasks/${taskId}/executions`;
}

function taskPath(taskId: string): string {
  return `/v1/orgs/${suite.fixtures.orgA.id}/tasks/${taskId}`;
}

describe('GET /executions — isolation', () => {
  it('reports the effective tier of a run that executed, and its missing controls', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(executionsPath(suite.fixtures.tasks.draftA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const { data } = response.body as DataBody<AttemptBody[]>;
    const executed = data.find((attempt) => attempt.id === executedAttemptId);

    expect(executed).toBeDefined();
    expect(executed?.isolation).toEqual(RESTRICTED_REPORT);

    // "restricted shared kernel" is stated, not implied: the controls it does not provide
    // travel with every row.
    expect(executed?.isolation?.controlsUnavailable).toEqual(
      expect.arrayContaining(['vm-isolation', 'kernel-isolation']),
    );
    // Phase 3's labelling is untouched by this phase.
    expect(executed?.simulated).toBe(false);
  });

  it('reports an attempt from before the tier existed as not recorded, never as sandboxed', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(executionsPath(suite.fixtures.tasks.draftA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const { data } = response.body as DataBody<AttemptBody[]>;
    const legacy = data.find((attempt) => attempt.attemptNumber === 1);

    // `null`, not `restricted-shared-kernel`: a default would describe a run nobody recorded.
    expect(legacy?.isolation).toBeNull();
  });

  it('reports a refused attempt as refused with the measurement, not as a weaker tier', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(executionsPath(suite.fixtures.tasks.queuedA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const { data } = response.body as DataBody<AttemptBody[]>;
    const refused = data.find((attempt) => attempt.id === refusedAttemptId);

    expect(refused?.status).toBe('failed');
    expect(refused?.simulated).toBe(true);
    expect(refused?.isolation).toMatchObject({
      required: 'vm',
      // The load-bearing assertion: no tier was granted, and no tier is claimed.
      effective: null,
      refused: true,
      vmAvailable: false,
    });
    expect(refused?.isolation?.reason).toContain('/dev/kvm');
    expect(refused?.error).toMatchObject({ code: ISOLATION_TIER_UNAVAILABLE, retryable: false });
  });
});

describe('GET /executions/:attemptId — isolation', () => {
  it('carries the same report on the detail route', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`${executionsPath(suite.fixtures.tasks.draftA)}/${executedAttemptId}`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const body = response.body as DataBody<{ attempt: AttemptBody }>;

    expect(body.data.attempt.isolation).toEqual(RESTRICTED_REPORT);
  });
});

describe('GET /tasks/:taskId — isolation', () => {
  it('exposes the effective tier of the newest attempt', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(taskPath(suite.fixtures.tasks.draftA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const body = response.body as DataBody<TaskDetailBody>;

    expect(body.data.latestAttempt?.id).toBe(executedAttemptId);
    expect(body.data.latestAttempt?.status).toBe('succeeded');
    expect(body.data.latestAttempt?.isolation?.effective).toBe('restricted-shared-kernel');
  });

  it('exposes a refusal on the task, where a reader looks after a failed run', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(taskPath(suite.fixtures.tasks.queuedA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const body = response.body as DataBody<TaskDetailBody>;

    expect(body.data.latestAttempt?.id).toBe(refusedAttemptId);
    expect(body.data.latestAttempt?.isolation?.refused).toBe(true);
    expect(body.data.latestAttempt?.isolation?.effective).toBeNull();
  });
});
