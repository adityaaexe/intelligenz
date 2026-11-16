import { describe, expect, it } from 'vitest';

import {
  finishProgrammeActivity,
  loadProgrammeActivity,
  recordProgrammeCheckpointActivity,
  reserveProgrammeTaskActivity,
} from '../src/activities/programme';

/**
 * The programme activities refuse a caller that is not the programme's own workflow.
 *
 * These four activities are registered on the worker's task queue and dispatched by name,
 * exactly like the task activities. The difference is what they can do: `reserve…` mints an
 * `ExecutionAttempt`, which is the reservation that authorises one execution. Before
 * Phase 8.6 that reservation had exactly one minter (`POST /run`); a new minter without a
 * check would let any workflow on the queue reserve arbitrary tasks — the duplicate-
 * execution hole Phase 6 spent four review rounds closing, reopened from the side.
 *
 * The check is `requireProgrammeAuthority`: the caller's **workflow id**, read from
 * Temporal's activity context (never from the input), must be exactly
 * `programme-<programmeId>`. This suite proves the half that needs no server: an activity
 * invoked with no execution identity at all is refused **before it reads the database**.
 * The positive half — a real `programme-<id>` execution reserves and records — is proved
 * end-to-end by `programme-execution.test.ts`; a task execution running under a different
 * id is refused by the same comparison.
 *
 * No database, no Temporal server: the refusal happens before `db()` is called, which is
 * itself part of the property (a refused caller cannot even probe the tenant's rows).
 */

const PROGRAMME_ID = '2a4d6f8b-1c3e-4a5b-9d7e-8f0a1b2c3d4e';
const ORG_ID = '6f1d2c3b-4a59-4687-9a0b-1c2d3e4f5a6b';
const TASK_ID = '9d0e5c1a-1f2b-4c3d-8e4f-5a6b7c8d9e0f';

const refusal = { type: 'PROGRAMME_IDENTITY_UNAVAILABLE', nonRetryable: true } as const;

describe('programme activities refuse a call with no execution identity', () => {
  it('loadProgrammeActivity', async () => {
    await expect(
      loadProgrammeActivity({ programmeId: PROGRAMME_ID, orgId: ORG_ID }),
    ).rejects.toMatchObject(refusal);
  });

  it('reserveProgrammeTaskActivity — the one that mints an execution attempt', async () => {
    await expect(
      reserveProgrammeTaskActivity({
        programmeId: PROGRAMME_ID,
        orgId: ORG_ID,
        taskId: TASK_ID,
        attemptNumber: 1,
        correlationId: '0b9f2a1c-3d4e-4f50-8a9b-1c2d3e4f5a6b',
      }),
    ).rejects.toMatchObject(refusal);
  });

  it('recordProgrammeCheckpointActivity', async () => {
    await expect(
      recordProgrammeCheckpointActivity({
        programmeId: PROGRAMME_ID,
        orgId: ORG_ID,
        sequence: 1,
        taskId: TASK_ID,
        outcome: 'succeeded',
        evidence: null,
      }),
    ).rejects.toMatchObject(refusal);
  });

  it('finishProgrammeActivity', async () => {
    await expect(
      finishProgrammeActivity({
        programmeId: PROGRAMME_ID,
        orgId: ORG_ID,
        status: 'succeeded',
        reason: 'test',
      }),
    ).rejects.toMatchObject(refusal);
  });
});
