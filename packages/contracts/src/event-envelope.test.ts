import { describe, expect, it } from 'vitest';

import { EVENT_TYPE_PATTERN, EventEnvelope } from './event-envelope';

const validEnvelope = {
  eventId: 'ab0ddf2a-5773-4ad9-a142-1a42d4328525',
  eventType: 'task.created.v1',
  schemaVersion: 1,
  tenantId: '00f91bb8-289f-4779-930f-5d5a00350f65',
  projectId: 'cfbb0320-8ac1-4824-8dba-ac2bc3185b60',
  aggregateId: '595b95e6-815b-45f4-bd5a-0cb4883e93d3',
  occurredAt: '2026-11-13T09:30:00.000Z',
  actor: { type: 'user', id: '3e140b9f-c47a-4a77-a85f-c23a3906b2d5' },
  correlationId: '294b53af-2461-49d8-a0da-23b7c6adbac7',
  causationId: null,
  idempotencyKey: 'task:create:client-request-42',
  payload: { title: 'Add the overview endpoint' },
} as const;

describe('EventEnvelope', () => {
  it('accepts the contract §7 shape', () => {
    expect(EventEnvelope.parse(validEnvelope)).toEqual(validEnvelope);
  });

  it('accepts a causationId when the event was caused by another event', () => {
    const parsed = EventEnvelope.parse({
      ...validEnvelope,
      causationId: '2046df41-a246-4f7f-8dc1-0da6e2e0f7e5',
    });

    expect(parsed.causationId).toBe('2046df41-a246-4f7f-8dc1-0da6e2e0f7e5');
  });

  it.each(['task.created', 'Task.Created.v1', 'task..v1', 'task.created.1', 'task.created.v'])(
    'rejects the event type %s',
    (eventType) => {
      expect(EventEnvelope.safeParse({ ...validEnvelope, eventType }).success).toBe(false);
    },
  );

  it('accepts a multi-digit schema version in the event type', () => {
    expect(EVENT_TYPE_PATTERN.test('agent_run.finished.v12')).toBe(true);
  });

  it('rejects schemaVersion 2 — v1 is the only envelope this build speaks', () => {
    expect(EventEnvelope.safeParse({ ...validEnvelope, schemaVersion: 2 }).success).toBe(false);
  });

  it('rejects a non-ISO occurredAt', () => {
    expect(EventEnvelope.safeParse({ ...validEnvelope, occurredAt: '13/11/2026' }).success).toBe(
      false,
    );
  });

  it('rejects an unknown actor type', () => {
    expect(
      EventEnvelope.safeParse({
        ...validEnvelope,
        actor: { type: 'robot', id: validEnvelope.actor.id },
      }).success,
    ).toBe(false);
  });

  it('rejects additional top-level fields', () => {
    expect(
      EventEnvelope.safeParse({ ...validEnvelope, orgId: validEnvelope.tenantId }).success,
    ).toBe(false);
  });
});
