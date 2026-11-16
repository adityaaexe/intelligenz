import {
  condition,
  defineSignal,
  defineUpdate,
  proxyActivities,
  setHandler,
  workflowInfo,
} from '@temporalio/workflow';

import type * as activitiesModule from '../../src/activities';

/**
 * A probe execution for the four **programme** activities — the counterpart of
 * `probe.workflow.ts` for the parent's half of Phase 8.6.
 *
 * ## Why this has to be a workflow, not a function call
 *
 * Every programme activity refuses a caller whose workflow id is not exactly
 * `programme-<programmeId>` (`requireProgrammeAuthority`), and it reads that id from
 * Temporal's activity context — never from the input. So a test that wants to ask "what
 * does a second, identical reservation answer?" or "what happens to a checkpoint write for
 * a sequence already owned by another task?" has to make the call from inside a real
 * execution started under that id. Calling the activity as a plain function would be
 * testing a call shape production cannot produce.
 *
 * Three behaviours this fixture needs and `runTaskWorkflow` cannot provide:
 *
 *   1. **the same activity twice**, with identical input, in one execution — the retry a
 *      lost activity response produces, without having to lose a response;
 *   2. **a refusal captured as a value** (`captureFailure`), so a test can assert the
 *      second call failed *and* keep the first call's result;
 *   3. **no retries** (`maximumAttempts: 1`), so a refusal is observed once instead of
 *      three times over.
 *
 * Determinism (ADR-003): only `@temporalio/workflow` and types. No clock, no randomness,
 * no I/O. The steps arrive by update and are fixed for the life of the run.
 */

/** One programme-activity dispatch. `input` is passed through unchanged. */
export interface ProgrammeProbeStep {
  readonly op: 'load' | 'reserve' | 'checkpoint' | 'finish';
  readonly input: Record<string, unknown>;
  /**
   * Return the activity's failure as a value instead of failing the update.
   *
   * Needed to observe a refusal that happens *after* a successful step in the same batch:
   * a thrown failure ends the update and discards the results already collected.
   */
  readonly captureFailure?: boolean;
}

/** The update name. Exported as a string so the test process never imports the sandbox. */
export const PROGRAMME_PROBE_UPDATE = 'runProgrammeSteps';

/** Ends the execution. A leaked run would keep polling the queue for ever. */
export const PROGRAMME_PROBE_FINISH = 'finishProgrammeProbe';

const runProgrammeStepsUpdate = defineUpdate<readonly unknown[], [readonly ProgrammeProbeStep[]]>(
  PROGRAMME_PROBE_UPDATE,
);

const finishProgrammeProbeSignal = defineSignal(PROGRAMME_PROBE_FINISH);

const {
  loadProgrammeActivity,
  reserveProgrammeTaskActivity,
  recordProgrammeCheckpointActivity,
  finishProgrammeActivity,
} = proxyActivities<typeof activitiesModule.activities>({
  startToCloseTimeout: '30s',
  scheduleToCloseTimeout: '2m',
  retry: { maximumAttempts: 1 },
});

export async function programmeProbe(): Promise<{ readonly runId: string }> {
  setHandler(runProgrammeStepsUpdate, async (steps: readonly ProgrammeProbeStep[]) => {
    const results: unknown[] = [];

    for (const step of steps) {
      results.push(await dispatch(step));
    }

    return results;
  });

  let finished = false;
  setHandler(finishProgrammeProbeSignal, () => {
    finished = true;
  });

  await condition(() => finished);

  return { runId: workflowInfo().runId };
}

async function dispatch(step: ProgrammeProbeStep): Promise<unknown> {
  try {
    switch (step.op) {
      case 'load':
        return await loadProgrammeActivity(
          step.input as unknown as Parameters<typeof loadProgrammeActivity>[0],
        );
      case 'reserve':
        return await reserveProgrammeTaskActivity(
          step.input as unknown as Parameters<typeof reserveProgrammeTaskActivity>[0],
        );
      case 'checkpoint':
        return await recordProgrammeCheckpointActivity(
          step.input as unknown as Parameters<typeof recordProgrammeCheckpointActivity>[0],
        );
      case 'finish':
        return await finishProgrammeActivity(
          step.input as unknown as Parameters<typeof finishProgrammeActivity>[0],
        );
      default:
        throw new Error(`programmeProbe received an unknown op: ${String(step.op)}`);
    }
  } catch (error) {
    if (step.captureFailure !== true) throw error;

    // A refusal, as data. The proxy wraps the activity's `ApplicationFailure` in an
    // `ActivityFailure` whose `type` is undefined, so the chain is walked: the useful code
    // and sentence are at the bottom, and those are what the assertions are about.
    return { failed: true, ...describeFailure(error) };
  }
}

/**
 * The innermost failure's `type` and `message` — the activity's own refusal, not Temporal's
 * wrapper.
 */
function describeFailure(error: unknown): { readonly type: string; readonly message: string } {
  let type = 'UNKNOWN';
  let message = String(error);
  let candidate: unknown = error;

  for (
    let depth = 0;
    depth < 8 && typeof candidate === 'object' && candidate !== null;
    depth += 1
  ) {
    const failure = candidate as { type?: unknown; message?: unknown; cause?: unknown };

    if (typeof failure.type === 'string' && failure.type.length > 0) type = failure.type;
    if (typeof failure.message === 'string' && failure.message.length > 0)
      message = failure.message;

    if (failure.cause === candidate) break;
    candidate = failure.cause;
  }

  return { type, message };
}
