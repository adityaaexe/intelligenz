import { z } from 'zod';

/**
 * Enum vocabulary shared by the API, the worker and the web client.
 *
 * Zod enums are the single source of truth: the TypeScript union is derived with
 * `z.infer`, so a value can never exist in one representation and not the other.
 *
 * These values mirror the Prisma enums in `packages/database/prisma/schema.prisma`
 * exactly. Prisma enums are the storage contract; these are the wire contract.
 * Postgres enum labels are case-sensitive, which is why the identity/risk enums are
 * upper-case and the workflow-state enums are lower-case.
 */

export const Role = z.enum(['OWNER', 'ADMIN', 'MEMBER', 'VIEWER']);
export type Role = z.infer<typeof Role>;

export const RiskClass = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type RiskClass = z.infer<typeof RiskClass>;

export const TaskStatus = z.enum([
  'draft',
  'ready',
  'queued',
  'running',
  'verifying',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
]);
export type TaskStatus = z.infer<typeof TaskStatus>;

export const TaskPriority = z.enum(['low', 'normal', 'high', 'urgent']);
export type TaskPriority = z.infer<typeof TaskPriority>;

/**
 * Phase 4 adds two terminal states, mirroring the Prisma enum exactly:
 *
 *   - `EXPIRED`  — the grant was approved and then aged past its own `expiresAt`
 *                  without being used. Not a rejection: execution was authorised once.
 *   - `REVOKED`  — a human withdrew a grant that had been approved.
 *
 * Append-only. A Postgres enum label is positional on disk, so these are added at the
 * end and the existing labels are never reordered.
 */
export const ApprovalStatus = z.enum([
  'PENDING',
  'APPROVED',
  'REJECTED',
  'CHANGES_REQUESTED',
  'EXPIRED',
  'REVOKED',
]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const RunStatus = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'timed_out',
]);
export type RunStatus = z.infer<typeof RunStatus>;

export const ActorType = z.enum(['user', 'agent', 'system']);
export type ActorType = z.infer<typeof ActorType>;

/**
 * Who produced a `Task.riskClass` (Phase 4, D-006).
 *
 * `client` is the truthful label for every row written before the server-side
 * classifier existed: the caller asserted the class and nothing checked it. `server`
 * means `apps/api/src/risk` derived it from the task's content and the request's
 * declared capabilities. The column behind this is a `String`, not an enum, because
 * the vocabulary is policy-owned and grows; this Zod enum is the wire vocabulary for
 * the values that exist today.
 */
export const RiskSource = z.enum(['client', 'server']);
export type RiskSource = z.infer<typeof RiskSource>;

export const Environment = z.enum(['prod', 'staging', 'dev']);
export type Environment = z.infer<typeof Environment>;
