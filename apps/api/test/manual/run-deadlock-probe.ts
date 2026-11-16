/**
 * P87-011 mechanism diagnostic — does the `POST /run` statement order deadlock?
 *
 * This is **not** an application test and is not collected by any suite. It reproduces the
 * exact lock order `TasksService.run()` uses, with two interactive transactions and one
 * barrier, to answer a single question:
 *
 *   Can two concurrent reservations of the same task deadlock in PostgreSQL, given that
 *   each transaction inserts `WorkflowRun`/`ExecutionAttempt` (taking a `FOR KEY SHARE`
 *   lock on the task row through the foreign keys) *before* it takes the exclusive row
 *   lock with `UPDATE task`, and before the approval CAS that serialises them?
 *
 * If it deadlocks, the observed 500-shaped failure has a plausible mechanism and the API's
 * missing P2034 mapping is a real defect. If it does not, the mechanism is ruled out, and
 * the original failure stays unexplained rather than explained-by-story.
 *
 * Run: pnpm --filter @intelligenz/api exec tsx test/manual/run-deadlock-probe.ts
 */

import { randomUUID } from 'node:crypto';

import { startSuite } from '../helpers/app';

const shellTask = {
  title: 'Deadlock probe',
  goal: 'Run a shell command that rewrites scripts/build.sh.',
  acceptanceCriteria: ['probe'],
};

function barrier(parties: number): () => Promise<void> {
  let arrived = 0;
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return async () => {
    arrived += 1;
    if (arrived === parties) release?.();
    await gate;
  };
}

async function main(): Promise<void> {
  const suite = await startSuite();

  try {
    const orgId = suite.fixtures.orgA.id;
    const projectId = suite.fixtures.projectA;

    const task = await suite.prisma.task.create({
      data: {
        orgId,
        projectId,
        workspaceId: suite.fixtures.workspaceA,
        title: shellTask.title,
        goal: shellTask.goal,
        acceptanceCriteria: shellTask.acceptanceCriteria,
        riskClass: 'HIGH',
        riskSource: 'server',
        status: 'ready',
        createdById: suite.fixtures.users.memberA.id,
        idempotencyKey: `probe-${randomUUID()}`,
      },
      select: { id: true },
    });

    const approval = await suite.prisma.approvalRequest.create({
      data: {
        orgId,
        taskId: task.id,
        riskClass: 'HIGH',
        status: 'APPROVED',
        requestedById: suite.fixtures.users.memberA.id,
        decidedById: suite.fixtures.users.ownerA.id,
        decidedAt: new Date(),
      },
      select: { id: true },
    });

    const reached = barrier(2);

    /**
     * One transaction, in the order `TasksService.run()` uses:
     *   run → attempt → approval CAS → task CAS.
     */
    const reserve = async (label: string): Promise<string> => {
      try {
        await suite.prisma.$transaction(
          async (tx) => {
            const run = await tx.workflowRun.create({
              data: {
                orgId,
                taskId: task.id,
                workflowId: `task-${task.id}`,
                status: 'queued',
              },
              select: { id: true },
            });

            await tx.executionAttempt.create({
              data: {
                orgId,
                taskId: task.id,
                workflowRunId: run.id,
                attemptNumber: 1,
                runtimeId: 'unassigned',
                simulated: true,
                status: 'queued',
              },
            });

            // Both transactions hold a foreign-key share lock on the task row here.
            await reached();

            const consumed = await tx.approvalRequest.updateMany({
              where: {
                id: approval.id,
                orgId,
                status: 'APPROVED',
                consumedAt: null,
                revokedAt: null,
              },
              data: { consumedAt: new Date() },
            });

            const claimed = await tx.task.updateMany({
              where: { id: task.id, orgId, status: 'ready' },
              data: { status: 'queued' },
            });

            return `${label}: cas=${String(consumed.count)} task=${String(claimed.count)}`;
          },
          { timeout: 15_000, maxWait: 15_000 },
        );

        return `${label}: committed`;
      } catch (error: unknown) {
        const candidate = error as { code?: string; message?: string };
        return `${label}: ERROR code=${candidate.code ?? '<none>'} message=${
          candidate.message?.split('\n')[0] ?? '<none>'
        }`;
      }
    };

    const results = await Promise.all([reserve('T1'), reserve('T2')]);

    for (const line of results) console.log(line);

    // If one transaction deadlocked, PostgreSQL names it in the message. Prisma reports
    // P2034 for a write conflict / deadlock, and the API has no mapping for it.
    const deadlocked = results.some((line) => line.includes('P2034') || /deadlock/i.test(line));

    console.log(`\nDEADLOCK_OBSERVED=${String(deadlocked)}`);
    process.exitCode = deadlocked ? 0 : 1;
  } finally {
    await suite.close();
  }
}

main().catch((error: unknown) => {
  console.error('probe crashed:', error);
  process.exitCode = 2;
});
