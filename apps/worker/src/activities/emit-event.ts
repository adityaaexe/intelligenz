import { EventEnvelope } from '@intelligenz/contracts';
import type { Prisma } from '@intelligenz/database';
import type { ActorType } from '@intelligenz/contracts';

import type {
  EmitEventActivityInput,
  EmitEventActivityResult,
} from '../shared/contracts';
import { db, nonRetryable } from './support';

/**
 * `emitEventActivity` — contract §16.
 *
 * Persists an `EventEnvelope` (contract §7) to `AuditEvent`. The envelope arrives fully
 * built from the workflow, because `occurredAt` must come from `workflow.now()` and
 * `eventId` from `uuid4()` — both replay-safe. An activity that stamped its own time
 * would produce a different row on a retry, which is the one thing an audit trail must
 * never do.
 *
 * ## Idempotency
 *
 * `AuditEvent` has no unique constraint on `idempotencyKey` either (only an index), so
 * the check is explicit:
 *
 *   1. the same `(orgId, idempotencyKey)` already exists → return it, `created: false`;
 *   2. a **singleton** event type (`task.cancelled.v1`) already exists for this
 *      aggregate → return it.
 *
 * (2) exists because cancellation has two writers. `POST /cancel` writes
 * `task.cancelled.v1` in the same transaction that marks the task cancelled, and the
 * workflow catches `CancelledFailure` and wants to record the same fact. Two rows for
 * one cancellation would make the count meaningless, so the worker treats the API's row
 * as the event and reports `created: false`. The failure mode this cannot close is a
 * write ordering race with no shared key — reported as a follow-up, because the fix is a
 * constraint the schema does not have.
 *
 * `AuditEvent.aggregateType` is not part of §7's envelope, so it is derived from the
 * event type's noun (`task.` → `Task`). An unmapped prefix fails loudly instead of
 * writing a wrong aggregate type.
 */

const SINGLETON_EVENT_TYPES = new Set(['task.cancelled.v1']);

const AGGREGATE_TYPES: Record<string, string> = {
  task: 'Task',
  workflow: 'WorkflowRun',
  agent: 'AgentRun',
  approval: 'ApprovalRequest',
  project: 'Project',
  run: 'WorkflowRun',
};

export async function emitEventActivity(
  input: EmitEventActivityInput,
): Promise<EmitEventActivityResult> {
  // Parse, don't trust: a malformed envelope is a bug in the workflow, and storing it
  // would corrupt the one table that is supposed to be trustworthy.
  const event = EventEnvelope.parse(input.event);
  const aggregateType = aggregateTypeFor(event.eventType);
  const prisma = db();

  const existingByKey = await prisma.auditEvent.findFirst({
    where: { orgId: event.tenantId, idempotencyKey: event.idempotencyKey },
    select: { id: true },
  });

  if (existingByKey !== null) {
    return { eventId: existingByKey.id, created: false };
  }

  if (SINGLETON_EVENT_TYPES.has(event.eventType)) {
    const existing = await prisma.auditEvent.findFirst({
      where: {
        orgId: event.tenantId,
        eventType: event.eventType,
        aggregateType,
        aggregateId: event.aggregateId,
      },
      select: { id: true },
    });

    if (existing !== null) {
      return { eventId: existing.id, created: false };
    }
  }

  try {
    await prisma.auditEvent.create({
      data: {
        // The workflow's `uuid4()` is the id: a retry re-sends the same id, and the
        // primary key refuses a duplicate rather than producing a second history entry.
        id: event.eventId,
        orgId: event.tenantId,
        projectId: event.projectId,
        actorType: event.actor.type as ActorType,
        actorId: event.actor.id,
        action: actionOf(event.eventType),
        aggregateType,
        aggregateId: event.aggregateId,
        eventType: event.eventType,
        correlationId: event.correlationId,
        causationId: event.causationId,
        idempotencyKey: event.idempotencyKey,
        payload: event.payload as Prisma.InputJsonObject,
        occurredAt: new Date(event.occurredAt),
      },
      select: { id: true },
    });
  } catch (error) {
    // Two activities can race between the check and the insert. A primary-key collision
    // means the row exists, which is the outcome this activity promises, not a failure.
    if ((error as { code?: string }).code === 'P2002') {
      const existing = await prisma.auditEvent.findFirst({
        where: { orgId: event.tenantId, idempotencyKey: event.idempotencyKey },
        select: { id: true },
      });

      if (existing !== null) return { eventId: existing.id, created: false };
    }

    throw error;
  }

  return { eventId: event.eventId, created: true };
}

function aggregateTypeFor(eventType: string): string {
  const [noun] = eventType.split('.');
  const aggregateType = noun === undefined ? undefined : AGGREGATE_TYPES[noun];

  if (aggregateType === undefined) {
    throw nonRetryable(
      'UNMAPPED_EVENT_TYPE',
      `No aggregate type is mapped for event type "${eventType}".`,
    );
  }

  return aggregateType;
}

/** `task.created.v1` → `task.created`, matching the API's `action` column. */
function actionOf(eventType: string): string {
  return eventType.replace(/\.v\d+$/, '');
}
