# ADR-009 — Audit and events

Status: Accepted
Date: 2026-11-13

## Context

The product sells traceability: *any outcome can be traced back to the instruction that caused it and forward to the evidence that justified it* (`INFORMATION-ARCHITECTURE.md` §4.1). The audit trail is therefore not a logging feature. It is the product.

Contract §7 fixes an event envelope and requires persistence to `AuditEvent`, with consumers tolerating unknown `eventType` values.

Two architectural questions remain: how a state change and its audit record stay consistent, and what "append-only" means when the application owns the database.

## Decision

### Envelope (normative, as implemented)

```json
{
  "eventId": "uuid",
  "eventType": "task.created.v1",
  "schemaVersion": 1,
  "tenantId": "uuid",
  "projectId": "uuid",
  "aggregateId": "uuid",
  "occurredAt": "ISO-8601",
  "actor": { "type": "user|agent|system", "id": "uuid" },
  "correlationId": "uuid",
  "causationId": "uuid|null",
  "idempotencyKey": "string",
  "payload": {}
}
```

### `eventType` is `<aggregate>.<action>.<version>`

- The version is **in the type**, not only in `schemaVersion`. Both are present because they answer different questions: `schemaVersion` is machine-readable and monotonic; the `.vN` suffix makes a breaking change visible in a log line, a grep, and a dashboard without parsing JSON.
- A breaking payload change ships as `.v2` and both versions are emitted until consumers migrate. A non-breaking addition (a new optional field) keeps the version and increments nothing.
- `log` does not use `eventType` at all. Operational logging is `pino` and is not an audit record. Conflating them is how audit trails become unqueryable.

### Correlation and causation

- `correlationId` is minted at the **entry point** — the HTTP request that starts a chain — and propagated to the workflow, every activity, every runtime call, and every emitted event.
- `causationId` is the `eventId` of the event that **directly** caused this one. Root events have `null`.
- Rule of thumb, applied in review: if you cannot name the one event that caused this one, `causationId` is `null` and the event is a root — not a guess.

This gives two traversals: forward (all events sharing a `correlationId`, ordered) and backward (follow `causationId` to the instruction). The IA's lineage rail and the "why did this happen" question both depend on the backward traversal being correct.

### Consistency: same transaction, not an outbox

Every state change writes its audit row **in the same Prisma transaction** as the change. If the transaction rolls back, no event exists. If it commits, the event exists.

An outbox pattern is deliberately **not** used in Phase 2 because there is no external broker and no external consumer. An outbox without a publisher is a table that grows and a reconciliation job that never runs.

The honest limitation: because there is no outbox, "emit an event to another system" is not a capability. `AuditEvent` rows are readable through the API and nothing else. If a webhook, stream, or analytics sink is added, an outbox (or CDC) becomes mandatory and this decision must be superseded — the dual-write problem it solves is real, it has simply not arrived yet.

### Append-only intent

- `AuditEvent` is insert-only at the application layer: the repository exposes `append()` and `findBy*()`, no `update`, no `delete`.
- The database role used by the application is granted `INSERT` and `SELECT` on `audit_events`, and **not** `UPDATE` or `DELETE`. This is enforced in `infra/scripts/bootstrap-db.sh`, not merely by code review.
- A hash chain (`prevHash`, `hash`) is **not** implemented. It would make tampering detectable, but it serialises inserts (each row must read the previous hash), and no tamper-evidence claim is being made in Phase 2. The columns are not reserved either — adding them later requires a backfill, and that backfill would itself be unauditable for historical rows. Stated plainly so nobody assumes tamper-evidence exists.

### Consumer tolerance

Dispatch is by prefix with a default no-op handler, never a closed enum or exhaustive switch. An unknown `eventType` is logged at `debug` and skipped. This is requirement, not style: it is what allows a `.v2` to ship without a coordinated deploy.

## Consequences

### Positive

- State and audit cannot diverge for the writes that go through the application: one transaction, one outcome.
- `correlationId` + `causationId` make both traversals of the product's central claim mechanically answerable.
- Insert-only grants make "append-only" a database fact, not a promise.
- Version-in-type makes schema evolution visible in every log aggregator and every grep.
- Unknown-event tolerance means the audit consumer can be deployed independently of the producers.

### Negative / costs

- **Every write path must remember to emit.** A new endpoint that forgets is a hole in the trail with no automatic detection. Mitigation: a repository-level helper that requires an event for state-changing methods, plus a test that asserts an event per state transition. Neither covers a hand-written `$executeRaw`.
- **Audit rows are unbounded.** No partitioning, no archival, no retention. The table will outgrow the rest of the schema and every `WHERE orgId = ?` scan will eventually need an index strategy (`(orgId, occurredAt)`) that is not yet justified by volume.
- **Same-transaction writes lengthen transactions.** An activity that holds a transaction while writing a large `payload` increases lock time. Payloads must stay small (ids and summaries, not artifact bytes).
- **No delivery guarantee to anything external.** Any future webhook is at-most-once until an outbox exists.
- No tamper-evidence. A DBA can rewrite history; only the grants discourage it.
- `payload` is `jsonb` with no schema enforcement at the database level. The Zod schema is the only guard, and it guards writes, not reads of historical rows.

## Alternatives considered

**Application logs as the audit trail (`pino` → file → collector).** Rejected. Logs are lossy, rotated, unqueryable by aggregate, and mutable by anyone with filesystem access. They cannot answer "what is the complete history of this task" without a reconstruction step that is itself unreliable.

**Event sourcing (events are the source of truth; state is derived).** Rejected. The Overview needs current state for eight regions in one request; a projection pipeline does not exist and would become the critical path. Also, event sourcing changes the entire data-access design, not one table.

**A dedicated audit service / append-only store (e.g. an immutable log service).** Rejected for now: another deployable and another credential to hold history that is already transactional with the state it describes. Revisit when audit export to a customer's SIEM becomes a requirement — at that point, a sink is needed anyway.

**A hash chain now.** Rejected on cost/benefit, as above. It is the correct answer the day a customer asks for tamper-evidence, and it should then be added as a new table of checkpoints rather than retrofitting hashes into existing rows.

## Open item

Contract §7 says the envelope matches **"spec §5.3"**. No document with a §5.3 exists in this repository; the only specification of the envelope is contract §7 itself, which is what this ADR implements. **Unknown — the referenced spec must be located or the reference corrected**, because if a fuller definition exists (field names, required vs optional, ordering) the implementation may diverge from an authority the team cannot see.

## Revisit trigger

Revisit when the first **external** consumer appears — a webhook, a customer SIEM export, an analytics sink. At that moment the same-transaction write is no longer sufficient and an outbox (or CDC) becomes mandatory. Revisit separately when tamper-evidence is requested, which requires checkpoints rather than retrofitted hashes, and when `audit_events` growth makes partitioning necessary.
