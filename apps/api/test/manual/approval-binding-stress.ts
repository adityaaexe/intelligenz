/**
 * P87-011 reproducer — the two-way (and n-way) `POST /run` race on one task.
 *
 * ## Why this exists
 *
 * `apps/api/test/approval-attempt-binding.e2e-spec.ts` failed once in eight full-suite
 * runs and passed every run afterwards. The assertion that failed was never captured, so
 * "it is flaky" is a guess and "it is fixed" would be a lie. This file reproduces the
 * *shape* of that test in a loop, records the exact evidence when an invariant breaks,
 * and is deliberately **not** collected by `pnpm test:e2e`:
 *
 *     include: ['**\/*.e2e-spec.ts']
 *
 * so it cannot turn a green suite red on a slow host. Run it by hand:
 *
 *     pnpm --filter @intelligenz/api exec tsx test/manual/approval-binding-stress.ts
 *
 * ## The invariant
 *
 * One task, one approved grant, N simultaneous `POST /run` against an unreachable
 * orchestrator:
 *
 *   - exactly one request reaches the orchestrator and answers 503;
 *   - every other request is refused with 409 (`CONFLICT` or `APPROVAL_CONSUMED`);
 *   - exactly one `ExecutionAttempt`, one `WorkflowRun`, one consumption, one
 *     `approval.consumed.v1` audit row.
 *
 * That is the same property the suite test asserts, generalised to n contenders. A
 * violation here is the same defect, with the evidence kept.
 */

import request from 'supertest';

import {
  authHeaders,
  createTestApp,
  login,
  startSuite,
  type Suite,
} from '../helpers/app';

const OFFLINE_TEMPORAL = {
  address: '127.0.0.1:1',
  namespace: 'default',
  taskQueue: 'intelligenz-tasks',
  rpcMaxAttempts: 1,
} as const;

interface HttpResult {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

interface IterationEvidence {
  readonly iteration: number;
  readonly concurrency: number;
  readonly taskId: string;
  readonly approvalId: string;
  readonly results: readonly HttpResult[];
  readonly attempts: number;
  readonly runs: number;
  readonly consumptions: number;
  readonly auditRows: number;
  readonly consumedByAttemptId: string | null;
}

const shellTask = {
  title: 'Rewrite the build script',
  goal: 'Run a shell command that rewrites scripts/build.sh.',
  acceptanceCriteria: [] as string[],
};

function errorFields(body: unknown): { code: string; message: string } {
  const candidate = body as { error?: { code?: unknown; message?: unknown } };
  const code = typeof candidate?.error?.code === 'string' ? candidate.error.code : '<none>';
  const message =
    typeof candidate?.error?.message === 'string' ? candidate.error.message : '<none>';

  return { code, message };
}

function dataOf<T>(body: unknown): T {
  return (body as { data: T }).data;
}

async function oneIteration(
  suite: Suite,
  offline: Awaited<ReturnType<typeof createTestApp>>,
  memberToken: string,
  ownerToken: string,
  iteration: number,
  concurrency: number,
): Promise<IterationEvidence | null> {
  const orgId = suite.fixtures.orgA.id;
  const tasksPath = `/v1/orgs/${orgId}/projects/${suite.fixtures.projectA}/tasks`;
  const taskPath = `/v1/orgs/${orgId}/tasks`;

  const created = await request(suite.app.getHttpServer())
    .post(tasksPath)
    .set(authHeaders(memberToken, orgId))
    .set('idempotency-key', `p87-011-task-${String(iteration)}`)
    .send(shellTask)
    .expect(201);

  const taskId = dataOf<{ id: string }>(created.body).id;

  await request(suite.app.getHttpServer())
    .patch(`${taskPath}/${taskId}`)
    .set(authHeaders(memberToken, orgId))
    .send({ status: 'ready', reason: 'P87-011 stress fixture.' })
    .expect(200);

  const approval = await suite.prisma.approvalRequest.findFirstOrThrow({
    where: { taskId, orgId },
    select: { id: true },
    orderBy: { createdAt: 'desc' },
  });

  const decided = await request(suite.app.getHttpServer())
    .post(`/v1/orgs/${orgId}/approvals/${approval.id}/decision`)
    .set(authHeaders(ownerToken, orgId))
    .send({ decision: 'approve', note: 'P87-011 stress fixture.' });

  if (decided.status !== 200) {
    throw new Error(`approval decision answered ${String(decided.status)}`);
  }

  const fire = async (): Promise<HttpResult> => {
    const response = await request(offline.getHttpServer())
      .post(`${taskPath}/${taskId}/run`)
      .set(authHeaders(memberToken, orgId));

    const fields = errorFields(response.body);

    return { status: response.status, ...fields };
  };

  const results = await Promise.all(
    Array.from({ length: concurrency }, () => fire()),
  );

  // Read the durable state *after* every response settled.
  const [attempts, runs, consumptions, auditRows, consumed] = await Promise.all([
    suite.prisma.executionAttempt.count({ where: { orgId, taskId } }),
    suite.prisma.workflowRun.count({ where: { orgId, taskId } }),
    suite.prisma.approvalRequest.count({ where: { id: approval.id, consumedAt: { not: null } } }),
    suite.prisma.auditEvent.count({
      where: { aggregateId: approval.id, eventType: 'approval.consumed.v1' },
    }),
    suite.prisma.approvalRequest.findUniqueOrThrow({
      where: { id: approval.id },
      select: { consumedByAttemptId: true },
    }),
  ]);

  const evidence: IterationEvidence = {
    iteration,
    concurrency,
    taskId,
    approvalId: approval.id,
    results,
    attempts,
    runs,
    consumptions,
    auditRows,
    consumedByAttemptId: consumed.consumedByAttemptId,
  };

  const accepted = results.filter((r) => r.status === 503).length;
  const refused = results.filter((r) => r.status === 409).length;
  const other = results.filter((r) => r.status !== 503 && r.status !== 409);

  const broken =
    accepted !== 1 ||
    refused !== concurrency - 1 ||
    other.length > 0 ||
    attempts !== 1 ||
    runs !== 1 ||
    consumptions !== 1 ||
    auditRows !== 1;

  // Cheap cleanup so 50 iterations do not accumulate arbitrary rows; the suite's own
  // close() truncates at the end anyway.
  if (!broken) return null;

  return evidence;
}

async function main(): Promise<void> {
  const suite = await startSuite();
  const offline = await createTestApp({
    temporal: { ...OFFLINE_TEMPORAL },
    readinessTimeoutMs: 1_000,
    // Errors must be visible: a 500 here is the evidence.
    logLevel: 'error',
  });

  const memberToken = await login(suite.app, suite.fixtures.users.memberA.email);
  const ownerToken = await login(suite.app, suite.fixtures.users.ownerA.email);

  const plan: readonly { concurrency: number; iterations: number }[] = [
    { concurrency: 2, iterations: 30 },
    { concurrency: 4, iterations: 20 },
  ];

  const failures: IterationEvidence[] = [];
  let executed = 0;

  try {
    for (const phase of plan) {
      for (let i = 1; i <= phase.iterations; i += 1) {
        const evidence = await oneIteration(
          suite,
          offline,
          memberToken,
          ownerToken,
          i + phase.concurrency * 1000,
          phase.concurrency,
        );

        executed += 1;

        if (evidence !== null) {
          failures.push(evidence);
          console.log(
            `\n=== VIOLATION concurrency=${String(phase.concurrency)} iteration=${String(i)} ===`,
          );
          console.log(JSON.stringify(evidence, null, 2));
        }

        if (i % 10 === 0) {
          console.log(
            `progress: concurrency=${String(phase.concurrency)} ` +
              `${String(i)}/${String(phase.iterations)} — violations so far: ${String(failures.length)}`,
          );
        }
      }
    }
  } finally {
    await offline.close();
    await suite.close();
  }

  console.log('\n=== SUMMARY ===');
  console.log(`request batches: ${String(executed)}`);
  console.log(`violations: ${String(failures.length)}`);
  console.log(
    JSON.stringify(
      failures.map((f) => ({
        concurrency: f.concurrency,
        iteration: f.iteration,
        statuses: f.results.map((r) => `${String(r.status)}:${r.code}`),
        attempts: f.attempts,
        runs: f.runs,
        consumptions: f.consumptions,
        auditRows: f.auditRows,
      })),
      null,
      2,
    ),
  );

  process.exitCode = failures.length === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error('reproducer crashed:', error);
  process.exitCode = 2;
});
