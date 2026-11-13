import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
// `ActorType` is both a Zod enum and a type, so one import serves both uses.
import { ActorType, EventEnvelope } from '@intelligenz/contracts';
import type { Prisma, PrismaClient } from '@intelligenz/database';

import { PRISMA_CLIENT } from '../database/database.module';

/**
 * Audit trail — the one place an `AuditEvent` row is written.
 *
 * The contract requires an event on task creation, status change, run start, run
 * cancel, approval decision and login. Scattering `prisma.auditEvent.create` across
 * six services would make the shape drift; here the envelope is built once and
 * validated against `EventEnvelope` before it is stored (contract §7, §15 A8).
 *
 * Writes join the caller's transaction when one is supplied. That matters: a task
 * row without its `task.created.v1` event is a history that lags the state, and a
 * log line that appears before a rollback is a false record.
 */

export interface AuditActor {
  readonly type: ActorType;
  readonly id: string;
}

export interface AuditEventInput {
  readonly orgId: string;
  /**
   * Null for identity events (login). `EventEnvelope.projectId` is a required UUID,
   * so a domain event without a project is a programming error and is rejected by
   * the envelope parse below. Login is not a project-scoped aggregate; the column is
   * nullable precisely so it can be recorded without inventing a project id.
   */
  readonly projectId?: string | null;
  readonly actor: AuditActor;
  /** Dotted lowercase action, e.g. `task.created`. Used for human queries. */
  readonly action: string;
  /** Versioned type, e.g. `task.created.v1` (pattern-checked by the envelope). */
  readonly eventType: string;
  readonly aggregateType: string;
  readonly aggregateId: string;
  readonly correlationId: string;
  readonly causationId?: string | null;
  readonly idempotencyKey?: string;
  readonly payload: Prisma.InputJsonObject;
}

type AuditEventRecord = {
  id: string;
  orgId: string;
  projectId: string | null;
  actorType: ActorType;
  actorId: string;
  action: string;
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  correlationId: string;
  causationId: string | null;
  idempotencyKey: string;
  payload: Prisma.InputJsonValue;
  occurredAt: Date;
};

type AuditWriteClient = Pick<Prisma.TransactionClient, 'auditEvent'>;

@Injectable()
export class AuditService {
  constructor(@Inject(PRISMA_CLIENT) private readonly prisma: PrismaClient) {}

  /**
   * Writes outside a caller transaction. Used for events that are not part of a
   * state change (login).
   */
  async record(input: AuditEventInput): Promise<string> {
    return this.recordWith(this.prisma, input);
  }

  /**
   * Writes inside the caller's transaction so state and history commit together.
   */
  async recordWithin(
    transaction: Prisma.TransactionClient,
    input: AuditEventInput,
  ): Promise<string> {
    return this.recordWith(transaction, input);
  }

  private async recordWith(client: AuditWriteClient, input: AuditEventInput): Promise<string> {
    const record = buildAuditRecord(input);

    await client.auditEvent.create({ data: record });

    return record.id;
  }
}

/**
 * Builds and validates the row. `EventEnvelope` requires a `projectId`, so a
 * project-scoped event is checked against the contract in full; an identity event
 * keeps every other field and stores a null project.
 */
function buildAuditRecord(input: AuditEventInput): AuditEventRecord {
  const eventId = randomUUID();
  const occurredAt = new Date();
  const projectId = input.projectId ?? null;
  const idempotencyKey =
    input.idempotencyKey ?? `${input.eventType}:${input.aggregateId}:${eventId}`;

  if (projectId !== null) {
    EventEnvelope.parse({
      eventId,
      eventType: input.eventType,
      schemaVersion: 1,
      tenantId: input.orgId,
      projectId,
      aggregateId: input.aggregateId,
      occurredAt: occurredAt.toISOString(),
      actor: { type: input.actor.type, id: input.actor.id },
      correlationId: input.correlationId,
      causationId: input.causationId ?? null,
      idempotencyKey,
      payload: input.payload,
    });
  }

  return {
    id: eventId,
    orgId: input.orgId,
    projectId,
    // Narrowed to Prisma's enum: the contract enum is the same literal set.
    actorType: ActorType.parse(input.actor.type),
    actorId: input.actor.id,
    action: input.action,
    aggregateType: input.aggregateType,
    aggregateId: input.aggregateId,
    eventType: input.eventType,
    correlationId: input.correlationId,
    causationId: input.causationId ?? null,
    idempotencyKey,
    payload: input.payload,
    occurredAt,
  };
}
