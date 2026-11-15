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
 * # Start a run (workflow id `task-<taskId>`, REJECT_DUPLICATE). The attempt id is
 * # required since Phase 6 (F3); it is the `attemptId` POST /run returns.
 * pnpm --filter @intelligenz/worker exec tsx scripts/drive-run.ts start <taskId> <orgId> <attemptId>
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
  drive-run.ts start <taskId> <orgId> <attemptId> [correlationId]
  drive-run.ts cancel <taskId>
  drive-run.ts describe <taskId>
  drive-run.ts wait <taskId> [timeoutMs]

<attemptId> is required: since Phase 6 (F3) an execution with no reservation is
refused, so a start must name the queued ExecutionAttempt POST /run minted for this
task. The 202 body of POST /run returns it.`;

/** The missing-argument refusal, so the operator is told what to supply, not just refused. */
const MISSING_ATTEMPT_ID = `drive-run.ts start: an attempt id is required.

Since Phase 6 (F3), runTaskWorkflow refuses to execute a task that names no reserved
execution attempt (EXECUTION_CLAIM_REFUSED): an attempt is the reservation that
authorises exactly one execution, and a run that names none cannot be shown to be the
only one. The claim is written by validateTaskActivity under an identity the worker
reads from its own activity context, so there is no flag that can stand in for it.

Supply the queued attempt id that POST /run returned in its 202 body:

  drive-run.ts start <taskId> <orgId> <attemptId> [correlationId]

For a task with no reservation, create one first (POST /run), then start with its id.`;

/**
 * The second refusal: an attempt id that was **supplied but is blank**.
 *
 * A different operator mistake from an omitted argument, and a different fix: shell magic
 * (`$ATTEMPT_ID` unset, `""` from a script) produces an empty word rather than a missing
 * one. It is refused before a Temporal handshake for the same reason, and reported with its
 * own message so the operator can tell the two cases apart.
 */
const EMPTY_ATTEMPT_ID = `drive-run.ts start: the attempt id is empty.

An empty string is not an attempt id: it names no reservation, so the workflow would be
started, refused by validateTaskActivity three activities later, and reported as a worker
failure rather than as the argument bug it is.

Check the value you are passing (an unset shell variable expands to nothing):

  drive-run.ts start <taskId> <orgId> <attemptId> [correlationId]`;

async function main(): Promise<void> {
  loadNearestEnvFile();

  const [command, taskId, ...rest] = process.argv.slice(2);

  if (command === undefined || taskId === undefined) {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 2;
    return;
  }

  // Refuse a `start` with no attempt id **before** connecting: the argument is missing,
  // and making the operator wait for a Temporal handshake to be told so is noise. The
  // alternative — letting the workflow start — fails three activities later with
  // EXECUTION_CLAIM_REFUSED and reads like a worker bug rather than a missing argument.
  //
  // Two refusals, deliberately, and each is observed by its own test: *omitted* here, and
  // *empty* below. They are distinct mistakes with distinct fixes, so they are distinct
  // guards rather than one guard duplicated — a duplicate would let a revert of either one
  // hide behind the other.
  if (command === 'start') {
    const [orgId, attemptId] = rest;

    if (orgId === undefined) {
      process.stderr.write(`${USAGE}\n`);
      process.exitCode = 2;
      return;
    }

    if (attemptId === undefined) {
      process.stderr.write(`${MISSING_ATTEMPT_ID}\n`);
      process.exitCode = 2;
      return;
    }

    if (attemptId.trim().length === 0) {
      process.stderr.write(`${EMPTY_ATTEMPT_ID}\n`);
      process.exitCode = 2;
      return;
    }
  }

  const client = await TemporalTaskClient.connect();

  try {
    switch (command) {
      case 'start': {
        const [orgId, attemptId, correlationId] = rest;

        // Narrowed by the pre-flight above. This is an invariant, not a second refusal: if
        // it ever fires, the pre-flight was changed and the dispatch must not proceed on a
        // guess. It deliberately does not print an operator message — it would be
        // indistinguishable from the refusals above and would mask a revert of either.
        if (orgId === undefined || attemptId === undefined) {
          throw new Error('drive-run.ts: the start pre-flight did not narrow the arguments');
        }

        const started = await client.startRunTask({
          taskId,
          orgId,
          attemptId: attemptId.trim(),
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
      const timer = setTimeout(
        () => reject(new Error(`timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      timer.unref();
    }),
  ]);
}

void main();
