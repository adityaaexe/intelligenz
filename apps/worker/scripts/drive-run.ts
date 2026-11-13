import { randomUUID } from 'node:crypto';

import { TemporalTaskClient } from '../src/client';
import { loadNearestEnvFile } from '../src/config';

/**
 * Operational driver for `runTaskWorkflow`.
 *
 * This is dev tooling, not part of the worker program (`tsconfig.json` only includes
 * `src/`). It exists because every end-to-end proof in this unit needs the same three
 * calls, and a one-off `tsx -e` snippet is not reproducible by the next person.
 *
 * ```bash
 * # Start a run (workflow id `task-<taskId>`, REJECT_DUPLICATE)
 * pnpm --filter @intelligenz/worker exec tsx scripts/drive-run.ts start <taskId> <orgId>
 *
 * # Request cancellation
 * pnpm --filter @intelligenz/worker exec tsx scripts/drive-run.ts cancel <taskId>
 *
 * # Describe without waiting
 * pnpm --filter @intelligenz/worker exec tsx scripts/drive-run.ts describe <taskId>
 *
 * # Block until the workflow returns its result (default 60s)
 * pnpm --filter @intelligenz/worker exec tsx scripts/drive-run.ts wait <taskId>
 * ```
 */

const USAGE = `usage:
  drive-run.ts start <taskId> <orgId> [correlationId]
  drive-run.ts cancel <taskId>
  drive-run.ts describe <taskId>
  drive-run.ts wait <taskId> [timeoutMs]`;

async function main(): Promise<void> {
  loadNearestEnvFile();

  const [command, taskId, ...rest] = process.argv.slice(2);

  if (command === undefined || taskId === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  const client = await TemporalTaskClient.connect();

  try {
    switch (command) {
      case 'start': {
        const [orgId, correlationId] = rest;

        if (orgId === undefined) {
          process.stderr.write(`${USAGE}\n`);
          process.exitCode = 2;
          return;
        }

        const started = await client.startRunTask({
          taskId,
          orgId,
          correlationId: correlationId ?? randomUUID(),
        });

        emit({ command, taskId, ...started });
        return;
      }

      case 'cancel': {
        emit({ command, taskId, outcome: await client.cancelRunTask(taskId) });
        return;
      }

      case 'describe': {
        emit({ command, taskId, ...(await client.describeRunTask(taskId)) });
        return;
      }

      case 'wait': {
        const timeoutMs = Number.parseInt(rest[0] ?? '60000', 10);

        try {
          const result = await withTimeout(client.waitForRunTask(taskId), timeoutMs);
          emit({ command, taskId, result });
        } catch (error) {
          emit({
            command,
            taskId,
            error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
          });
          process.exitCode = 1;
        }
        return;
      }

      default: {
        process.stderr.write(`${USAGE}\n`);
        process.exitCode = 2;
      }
    }
  } finally {
    await client.close();
  }
}

function emit(payload: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

/** A hung `result()` on a cancelled workflow must not hang the operator too. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref();
    }),
  ]);
}

void main();
