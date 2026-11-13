import type { RiskClass } from '@intelligenz/contracts';
import { z } from 'zod';

/**
 * Runtime-neutral port — contract §8, with the A4 correction (`cancel(taskId)`).
 *
 * Nothing in this package may name a vendor. `apps/api`, `apps/worker/src/workflows`
 * and `packages/contracts` depend on these types; an adapter implements them and is
 * registered by id (ADR-006).
 *
 * ## Schemas, not just types
 *
 * An adapter is untrusted: it may be a thin HTTP wrapper around a vendor whose
 * response shape changes without notice. The schemas below validate at the seam, so
 * a malformed adapter result becomes a typed `RUNTIME_RESULT_INVALID` failure
 * instead of an `undefined` reaching Prisma and becoming a corrupt row.
 *
 * ## Dependency note
 *
 * `RiskClass` is a type-only import from `@intelligenz/contracts`, resolved through
 * `tsconfig.base.json` paths and erased at build time. This package therefore has no
 * runtime dependency on the wire layer — a worker's workflow bundle cannot pull Zod
 * schemas in through the port.
 */

export const FilesystemAccess = z.enum(['none', 'read', 'write']);
export type FilesystemAccess = z.infer<typeof FilesystemAccess>;

/**
 * What an adapter can actually do. This is a **precondition**, not documentation:
 * the dispatch activity checks it before spending money (ADR-006).
 */
export const RuntimeCapabilities = z
  .object({
    shell: z.boolean(),
    network: z.boolean(),
    filesystem: FilesystemAccess,
    browser: z.boolean(),
    mcp: z.boolean(),
    imageInput: z.boolean(),
  })
  .strict();

export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilities>;

/** Mirrors `packages/contracts/src/enums.ts`; validated rather than trusted. */
export const ExecutionRiskClass = z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']);
export type ExecutionRiskClass = z.infer<typeof ExecutionRiskClass>;

/**
 * Compile-time parity with the wire contract. Adding a risk class to
 * `@intelligenz/contracts` without adding it here fails `tsc`, which is the point:
 * the port must not silently narrower than the domain.
 */
type AssertTrue<T extends true> = T;

/** Compile-time equality, in both directions. No runtime value; nothing to drift. */
type _RiskClassParity = AssertTrue<
  ExecutionRiskClass extends RiskClass
    ? RiskClass extends ExecutionRiskClass
      ? true
      : false
    : false
>;

export const ExecutionRequest = z
  .object({
    taskId: z.string().min(1),
    goal: z.string().min(1),
    /** Advisory. Enforcement needs a sandbox this environment does not have. */
    allowedPaths: z.array(z.string()),
    /** Advisory, same reason. Checked against capabilities at dispatch. */
    allowedActions: z.array(z.string()),
    riskClass: ExecutionRiskClass,
    timeoutMs: z.number().int().positive(),
    /** Advisory only — recorded, never enforced (contract §15 A7). */
    budgetUsd: z.number().nonnegative(),
    correlationId: z.string().min(1),
  })
  .strict();

export type ExecutionRequest = z.infer<typeof ExecutionRequest>;

/**
 * The normalised event vocabulary (ADR-006: normalised events, never raw vendor
 * logs — a raw log is an artifact, not an event stream).
 */
export const ExecutionEventType = z.enum([
  'started',
  'progress',
  'artifact-written',
  'log',
  'finished',
]);
export type ExecutionEventType = z.infer<typeof ExecutionEventType>;

export const ExecutionEvent = z
  .object({
    /** Monotonic within one execution, starting at 1. */
    seq: z.number().int().positive(),
    type: ExecutionEventType,
    /** Wall clock from the adapter. Not used for ordering — `seq` is. */
    at: z.string().min(1),
    message: z.string().min(1),
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export type ExecutionEvent = z.infer<typeof ExecutionEvent>;

/**
 * A reference to bytes in the artifact store (ADR-008), never the bytes themselves.
 * `checksum` is a lowercase hex SHA-256; an adapter with a different digest must
 * normalise it, because the persistence layer deduplicates on this value.
 */
export const ArtifactReference = z
  .object({
    kind: z.string().min(1),
    /** Filesystem path or store URL. Resolvable, not decorative. */
    uri: z.string().min(1),
    checksum: z.string().regex(/^[a-f0-9]{64}$/, 'checksum must be lowercase hex SHA-256'),
    sizeBytes: z.number().int().nonnegative(),
    mediaType: z.string().min(1).optional(),
  })
  .strict();

export type ArtifactReference = z.infer<typeof ArtifactReference>;

export const ExecutionStatus = z.enum(['succeeded', 'failed', 'timeout', 'cancelled']);
export type ExecutionStatus = z.infer<typeof ExecutionStatus>;

export const ExecutionError = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    /** Consumed by the Temporal retry decision. The adapter's judgement, not ours. */
    retryable: z.boolean(),
  })
  .strict();

export type ExecutionError = z.infer<typeof ExecutionError>;

/**
 * `usage` is best-effort per field. A missing field is `undefined`, never `0` —
 * except `usd`, which a simulated runtime reports as a genuine `0` because it
 * genuinely spends nothing (see `LocalSimulatedRuntime`; ADR-006's "never 0" rule
 * exists to stop a real adapter from hiding unknown cost behind a zero).
 */
export const ExecutionUsage = z
  .object({
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional(),
    usd: z.number().nonnegative().optional(),
  })
  .strict();

export type ExecutionUsage = z.infer<typeof ExecutionUsage>;

export const ExecutionResult = z
  .object({
    status: ExecutionStatus,
    summary: z.string().min(1),
    artifacts: z.array(ArtifactReference),
    events: z.array(ExecutionEvent),
    usage: ExecutionUsage,
    error: ExecutionError.optional(),
    /** ADR-006 labelling: which adapter produced this, and whether it is real. */
    runtimeId: z.string().min(1),
    simulated: z.boolean(),
  })
  .strict();

export type ExecutionResult = z.infer<typeof ExecutionResult>;

export const RuntimeHealthStatus = z.enum(['ok', 'degraded', 'down']);
export type RuntimeHealthStatus = z.infer<typeof RuntimeHealthStatus>;

export const RuntimeHealth = z
  .object({
    status: RuntimeHealthStatus,
    /** `true` means no real work is performed by this adapter (ADR-006). */
    simulated: z.boolean(),
    checkedAt: z.string().min(1),
    latencyMs: z.number().nonnegative().optional(),
    detail: z.string().min(1).optional(),
  })
  .strict();

export type RuntimeHealth = z.infer<typeof RuntimeHealth>;

/**
 * The port. One implementation exists in Phase 2 and it is simulated — the
 * interface has never been exercised against a vendor (ADR-006, "Open items").
 */
export interface AgentRuntime {
  readonly id: string;
  capabilities(): Promise<RuntimeCapabilities>;
  health(): Promise<RuntimeHealth>;
  execute(req: ExecutionRequest, signal: AbortSignal): Promise<ExecutionResult>;
  /**
   * Contract §15 A4: `execute()` returns a result, never a handle, so the only id
   * a caller can hold is the `taskId` it passed in.
   */
  cancel(taskId: string): Promise<void>;
}
