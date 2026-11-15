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
 * The test execution harness — Phase 6, AG-603.
 *
 * ## Why this file exists
 *
 * Before AG-603 the tests called the guarded activities as **plain functions** and passed
 * the execution identity in the input (`executionRunId`, or `workflowRunId` on validation,
 * which `executionIdentity` fell back to). The independent re-review broke exactly that
 * fallback: a standalone activity could name a victim's run id and satisfy the launch-site
 * claim. Deleting the fallback deleted the seam, so the tests that relied on it have to get
 * their identity the same way production does — from a **real workflow execution**.
 *
 * This workflow is that execution, and nothing more. It:
 *
 *   - emits nothing the identity depends on: the run id is minted by the Temporal server
 *     and read back from `workflowInfo()`, not from the workflow's arguments;
 *   - takes its steps as **updates**, so a test can start the workflow, learn its run id
 *     from the server, arrange database state under that id, run one activity, assert, and
 *     run another — several times over, inside one execution. That is what makes "claim
 *     under this run, then launch, then retry" testable without a supplied identity;
 *   - dispatches through `proxyActivities`, so each step is a genuine activity task
 *     dispatched by the server. A step is not a function call in the test process.
 *
 * Determinism (ADR-003): this file imports only `@temporalio/workflow` and **types**. No
 * clock, no randomness, no I/O. The loop is over a value that arrives by update and is
 * therefore fixed for the life of the run.
 *
 * The workflow stays alive so updates keep arriving, and ends on `finishSignal`.
 */

/** One activity dispatch. `input` is passed through unchanged. */
export interface ProbeStep {
  readonly op: 'validate' | 'execute' | 'persist' | 'complete';
  readonly input: Record<string, unknown>;
  /**
   * Attach the previous step's result to `input` under this key.
   *
   * Needed for exactly one shape: `persistResultActivity` takes the `ExecutionResult` that
   * `executeAgentActivity` returned, and that value only exists at runtime inside the
   * workflow. A test cannot supply it without fabricating a run, and a fabricated result
   * would make the legitimate-path test a test of the fixture.
   */
  readonly attachPreviousAs?: string;
}

/** What a completed probe run returns. `runId` is the same value the activities saw. */
export interface ProbeRun {
  readonly runId: string;
  readonly note: string;
}

/**
 * Runs a batch of steps inside this execution and returns their results.
 *
 * An update rather than a signal: the caller gets the results (and the activity's failure)
 * back, which is what lets a test interleave database assertions with steps of one
 * execution. A signal would have made every multi-step test a polling loop.
 */
export const runStepsUpdate = defineUpdate<readonly unknown[], [readonly ProbeStep[]]>('runSteps');

/** Ends the execution. Every test calls it; a leaked run would poll the queue for ever. */
export const finishSignal = defineSignal('finish');

/**
 * A generous, non-retrying proxy.
 *
 * `maximumAttempts: 1` on purpose: a refusal must be observed as one refusal, not three.
 * Retry behaviour is a *worker* property that `runTaskWorkflow` owns and that the
 * legitimate-path tests exercise through the real workflow, so re-testing it here would
 * only make a refusal slow.
 */
const { validateTaskActivity, executeAgentActivity, persistResultActivity, completeTaskActivity } =
  proxyActivities<typeof activitiesModule.activities>({
    startToCloseTimeout: '4m',
    scheduleToCloseTimeout: '10m',
    retry: { maximumAttempts: 1 },
  });

export async function probeExecution(): Promise<ProbeRun> {
  setHandler(runStepsUpdate, async (steps: readonly ProbeStep[]) => {
    const results: unknown[] = [];
    let previous: unknown;

    for (const step of steps) {
      previous = await dispatch(step, previous);
      results.push(previous);
    }

    return results;
  });

  let finished = false;
  setHandler(finishSignal, () => {
    finished = true;
  });

  await condition(() => finished);

  return { runId: workflowInfo().runId, note: 'finished' };
}

function dispatch(step: ProbeStep, previous: unknown): Promise<unknown> {
  const input =
    step.attachPreviousAs === undefined
      ? step.input
      : { ...step.input, [step.attachPreviousAs]: previous };

  // The activity inputs are typed per activity and the step carries one opaque object; the
  // cast is at this boundary only, and `unknown` is required because the union of the four
  // shapes does not overlap with any single one of them.
  switch (step.op) {
    case 'validate':
      return validateTaskActivity(input as unknown as Parameters<typeof validateTaskActivity>[0]);
    case 'execute':
      return executeAgentActivity(input as unknown as Parameters<typeof executeAgentActivity>[0]);
    case 'persist':
      return persistResultActivity(input as unknown as Parameters<typeof persistResultActivity>[0]);
    case 'complete':
      return completeTaskActivity(input as unknown as Parameters<typeof completeTaskActivity>[0]);
  }
}
