import { completeTaskActivity } from './complete-task';
import { emitEventActivity } from './emit-event';
import { executeAgentActivity } from './execute-agent';
import { persistResultActivity } from './persist-result';
import {
  finishProgrammeActivity,
  loadProgrammeActivity,
  recordProgrammeCheckpointActivity,
  reserveProgrammeTaskActivity,
} from './programme';
import { recordStartActivity } from './record-start';
import { validateTaskActivity } from './validate-task';

/**
 * The activity registry — contract §16, one function per name.
 *
 * The object keys are the activity **types** Temporal dispatches on. They must match the
 * names in §16 exactly: `proxyActivities<typeof activities>()` in the workflow derives the
 * call site from the same keys, so a rename here is a compile error there rather than a
 * task stuck in the queue with nothing to pick it up.
 *
 * Nothing but activities is exported from this module, and deliberately so: the whole
 * namespace is used as the proxy's type parameter, and an imported helper leaking into it
 * would become a proxy method that no worker registers.
 *
 * Every activity is idempotent on `taskId`. Temporal's at-least-once delivery means a
 * retried activity *will* re-run; the only question is whether re-running is safe.
 *
 * The four `programme*` activities (Phase 8.6) are idempotent on
 * `(programmeId, taskId, attemptNumber)` / `(programmeId, sequence)` instead, because a
 * programme is not a task: one node is reserved once, and a checkpoint's sequence is
 * allocated by the workflow.
 */
export const activities = {
  validateTaskActivity,
  recordStartActivity,
  executeAgentActivity,
  persistResultActivity,
  emitEventActivity,
  completeTaskActivity,
  loadProgrammeActivity,
  reserveProgrammeTaskActivity,
  recordProgrammeCheckpointActivity,
  finishProgrammeActivity,
};

export type Activities = typeof activities;
