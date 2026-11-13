import { z } from 'zod';

import { ActorType } from './enums';

/**
 * Event envelope — contract §7 is authoritative (contract §15 A8: no external
 * spec §5.3 exists).
 *
 * Every event that leaves an aggregate matches this shape and is persisted to
 * `AuditEvent`. Consumers must tolerate unknown `eventType` values, so the type
 * is a pattern-validated string, never a closed enum.
 */

/**
 * `task.created.v1`, `run.finished.v2` — lowercase noun.verb with an explicit
 * schema version. Version is part of the name so a breaking payload change is a
 * new event type, not a silent reinterpretation of an old one.
 */
export const EVENT_TYPE_PATTERN = /^[a-z0-9_]+\.[a-z0-9_]+\.v\d+$/;

const IsoDateTime = z.iso.datetime({ offset: true });

export const EventActor = z
  .object({
    type: ActorType,
    id: z.uuid(),
  })
  .strict();

export type EventActor = z.infer<typeof EventActor>;

export const EventEnvelope = z
  .object({
    eventId: z.uuid(),
    eventType: z.string().regex(EVENT_TYPE_PATTERN, {
      message: 'eventType must look like "task.created.v1"',
    }),
    schemaVersion: z.literal(1),
    tenantId: z.uuid(),
    projectId: z.uuid(),
    aggregateId: z.uuid(),
    occurredAt: IsoDateTime,
    actor: EventActor,
    correlationId: z.uuid(),
    causationId: z.uuid().nullable(),
    idempotencyKey: z.string().min(1).max(255),
    payload: z.record(z.string(), z.unknown()),
  })
  .strict();

export type EventEnvelope = z.infer<typeof EventEnvelope>;
