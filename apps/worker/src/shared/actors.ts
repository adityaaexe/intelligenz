/**
 * The worker's own actor identity for audit rows.
 *
 * A stable v5-shaped UUID, not a user row: `actorType` is `agent` and inventing a user id
 * would misattribute a platform decision to a person. It lives in `shared/` because two
 * places write audit rows as this actor — the workflow (task lifecycle events) and the
 * execution claim (grant/retry/duplicate) — and two copies of an id that must match is a
 * drift waiting to happen.
 *
 * Imported by `workflows/run-task.ts`, so this module must stay free of Node APIs and
 * Prisma: the Temporal sandbox evaluates it with the workflow bundle.
 */
export const AGENT_ACTOR_ID = '00000000-0000-5000-8000-000000000001';
