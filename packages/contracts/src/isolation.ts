import { z } from 'zod';

/**
 * Execution isolation vocabulary (ADR D-007).
 *
 * ## Two tiers, and only two
 *
 * `restricted-shared-kernel` is what this host can launch: bubblewrap namespaces, mount
 * confinement, a cleared environment and cgroup limits, on **the host's own kernel**.
 * It is a real control and it is not a virtual machine. `vm` is the tier that would put a
 * guest kernel between the agent and the host; no backend on this host can produce it.
 *
 * The list is closed on purpose. A free-text tier ("container", "sandboxed", "isolated")
 * would make every claim unfalsifiable, and the ADR's whole point is that the weakest
 * honest statement is the one that gets recorded.
 */
export const IsolationTier = z.enum(['restricted-shared-kernel', 'vm']);
export type IsolationTier = z.infer<typeof IsolationTier>;

export const ISOLATION_TIERS = IsolationTier.options;

/**
 * The controls a shared-kernel tier does *not* provide, as stable identifiers.
 *
 * `kernel-isolation` is the one that matters: a kernel or `bwrap` vulnerability is host
 * compromise, so this tier is not a boundary between mutually hostile tenants.
 * `vm-isolation` is the absent hardware-virtualised boundary that would provide it.
 *
 * Identifiers rather than prose so a client can group and filter; the attempt's `reason`
 * carries the sentence.
 */
export const CONTROL_KERNEL_ISOLATION = 'kernel-isolation';
export const CONTROL_VM_ISOLATION = 'vm-isolation';

/** What a `restricted-shared-kernel` run does not give you. Never empty for that tier. */
export const SHARED_KERNEL_MISSING_CONTROLS: readonly string[] = [
  CONTROL_VM_ISOLATION,
  CONTROL_KERNEL_ISOLATION,
];

/**
 * The typed refusal. `code` is what an operator filters on and what the attempt records.
 *
 * It is produced **only** when the tier a profile declares cannot be launched on this
 * host — today, a `vm` requirement with no `/dev/kvm`. It is never a warning: a task that
 * requires a virtual machine and receives a shared kernel has silently lost the control it
 * was authorised under, so the honest outcome is a refusal before anything runs.
 */
export const ISOLATION_TIER_UNAVAILABLE = 'ISOLATION_TIER_UNAVAILABLE';

/**
 * What an attempt may say about its isolation, and nothing more.
 *
 * - `required` — what the *profile* declared. Server-owned: it comes from the profile
 *   table, never from a request field, so a client cannot lower it.
 * - `effective` — the tier the attempt actually ran under. `null` means no tier was
 *   granted because the run was refused; it is never a weaker tier standing in for a
 *   stronger one.
 * - `refused` — true exactly when `effective` is null *because* `required` was
 *   unavailable. Distinct from "not recorded" (the whole report is `null` there).
 * - `vmAvailable` — the host capability measured at attempt time, so a reader can tell
 *   "the platform chose not to" from "the host cannot".
 * - `controlsUnavailable` — the controls this tier does not provide. For a shared-kernel
 *   run this is never empty: that is the difference between reporting a tier and
 *   implying "isolated".
 * - `reason` — one sentence naming the measurement behind the verdict.
 */
export const ExecutionIsolation = z
  .object({
    required: IsolationTier,
    effective: IsolationTier.nullable(),
    refused: z.boolean(),
    vmAvailable: z.boolean(),
    controlsUnavailable: z.array(z.string().min(1)),
    reason: z.string().min(1),
  })
  .strict();

export type ExecutionIsolation = z.infer<typeof ExecutionIsolation>;

/**
 * The error JSON a refused attempt records, so the refusal is readable from the attempt
 * alone (`GET /executions`) without an `AgentRun` — which by design does not exist for a
 * run that never started.
 *
 * The shape is a superset of `ExecutionError` (`code`, `message`, `retryable`): the
 * adapter-facing error triple is unchanged, and the isolation report rides alongside it
 * because it is the reason.
 */
export const IsolationRefusalError = z
  .object({
    code: z.literal(ISOLATION_TIER_UNAVAILABLE),
    message: z.string().min(1),
    retryable: z.literal(false),
    isolation: ExecutionIsolation,
  })
  .strict();

export type IsolationRefusalError = z.infer<typeof IsolationRefusalError>;
