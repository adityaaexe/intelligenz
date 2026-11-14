import type { CgroupUsage } from './cgroup';

/**
 * Why an attempt stopped, in the platform's vocabulary.
 *
 * These are the values written to `ExecutionAttempt.terminationReason`. The set is
 * deliberately about the **process**, not the agent's opinion of its own work:
 *
 *   completed       the process tree exited on its own, whatever it concluded
 *   timeout         the wall clock ran out and the platform killed it
 *   cancelled       a human or the API cancelled it and the platform killed it
 *   oom             the kernel killed a process here because memory.max was reached
 *   pids            a fork was refused because pids.max was reached
 *   cpu             more CPU was consumed than cpu.max allows — i.e. the quota was
 *                   not in force, which is an enforcement failure, not a busy run
 *   cpu_budget      the attempt spent its cumulative CPU budget and the platform killed
 *                   the cgroup. Distinct from `timeout` (the clock, not the CPU) and
 *                   from `cpu` (a rate ceiling that was not applied)
 *   disk            a write failed because the workspace volume hit ENOSPC
 *   crashed         the process died without a verdict (signal, non-zero exit, throw)
 *   workspace_error nothing ran: provisioning, cgroup placement or the lease failed
 *
 * `crashed` rather than `completed` for a failed exit is on purpose: a reader must not
 * have to join against `status` to learn that the process died instead of finishing.
 */
export const TERMINATION_REASONS = [
  'completed',
  'timeout',
  'cancelled',
  'oom',
  'pids',
  'cpu',
  'cpu_budget',
  'disk',
  'crashed',
  'workspace_error',
] as const;

export type TerminationReason = (typeof TERMINATION_REASONS)[number];

export type AdapterOutcome = 'succeeded' | 'failed' | 'timeout' | 'cancelled' | 'threw';

export interface TerminationInput {
  readonly adapter: AdapterOutcome;
  /** Null when no cgroup existed (rlimit-only mode, or nothing was spawned). */
  readonly usage: CgroupUsage | null;
  /** `cpuCeilingFor(profile)`; 0 disables the check. */
  readonly cpuCeilingUs: number;
  /** True when the sandbox process never made it into its cgroup. */
  readonly placementFailed: boolean;
  /**
   * True when the CPU-budget sampler fired and the platform killed the cgroup.
   *
   * This is a **decision the platform made**, not an inference: the sampler observed
   * `usage_usec > budget`, called `cgroup.kill`, and set this flag. That is why it
   * outranks `crashed` — the process died because we stopped it, and recording a
   * deliberate stop as a crash would hide the only interesting fact about the run.
   */
  readonly cpuBudgetExceeded?: boolean;
  /** The sampler's last measurement, for the error message and the attempt log. */
  readonly cpuBudget?: { readonly usageUs: number; readonly budgetUs: number } | undefined;
  /**
   * True when the attempt's writes failed with `ENOSPC` on its workspace volume: the
   * disk quota is real and the run hit it. Recorded separately from `crashed` because
   * "the agent ran out of room" is a capacity fact, not an agent bug.
   */
  readonly diskExhausted?: boolean;
}

export interface TerminationVerdict {
  readonly reason: TerminationReason;
  /**
   * True when the kernel or the platform stopped the run for a resource reason. Such an
   * attempt is recorded as `failed`/`timed_out` with this reason — never as an ordinary
   * agent failure, because "the agent could not do it" and "we did not let it" are
   * different facts and an operator needs to tell them apart.
   */
  readonly resourceKill: boolean;
  /** True when the verdict overrides the adapter's own status. */
  readonly overridesAdapter: boolean;
}

export function classifyTermination(input: TerminationInput): TerminationVerdict {
  if (input.placementFailed) {
    return { reason: 'workspace_error', resourceKill: false, overridesAdapter: true };
  }

  // A CPU-budget kill is the most specific fact available *after* placement: the platform
  // killed this run on purpose, at a measured `usage_usec`. It has to be decided before
  // the adapter's own status, because a killed tree usually reports `threw` or `failed`
  // and both are true but neither explains anything.
  if (input.cpuBudgetExceeded === true) {
    return { reason: 'cpu_budget', resourceKill: true, overridesAdapter: true };
  }

  const usage = input.usage;

  // OOM next: the kernel's kill is the most specific fact available, and an adapter
  // that reports "failed" after its process tree was shot is not telling us why.
  if (usage !== null && usage.oomKills > 0) {
    return { reason: 'oom', resourceKill: true, overridesAdapter: true };
  }

  if (input.adapter === 'cancelled') {
    return { reason: 'cancelled', resourceKill: false, overridesAdapter: false };
  }

  if (input.adapter === 'timeout') {
    return { reason: 'timeout', resourceKill: true, overridesAdapter: false };
  }

  // A refused fork is a breach even when the run still produced a result: the process
  // tree hit its ceiling, and calling that "completed" would hide the ceiling.
  if (usage !== null && usage.pidsEventsMax > 0) {
    return { reason: 'pids', resourceKill: true, overridesAdapter: true };
  }

  if (usage !== null && input.cpuCeilingUs > 0 && usage.cpuUsageUs > input.cpuCeilingUs) {
    return { reason: 'cpu', resourceKill: true, overridesAdapter: true };
  }

  // Disk last among the resource verdicts: a run that hit ENOSPC usually failed for that
  // reason, but if it also lost a process to the kernel the kernel's fact is more
  // specific and is already returned above.
  if (input.diskExhausted === true) {
    return { reason: 'disk', resourceKill: true, overridesAdapter: true };
  }

  if (input.adapter === 'succeeded') {
    return { reason: 'completed', resourceKill: false, overridesAdapter: false };
  }

  return { reason: 'crashed', resourceKill: false, overridesAdapter: false };
}

/**
 * `RunStatus` for the attempt, given the verdict. A resource kill is never a success and
 * never an agent failure: `oom`/`pids`/`cpu`/`cpu_budget`/`disk` become `failed` with a
 * `terminationReason` that says who ended it, and only the wall clock produces
 * `timed_out`.
 */
export function statusForTermination(
  verdict: TerminationVerdict,
): 'succeeded' | 'failed' | 'timed_out' | 'cancelled' {
  switch (verdict.reason) {
    case 'completed':
      return 'succeeded';
    case 'cancelled':
      return 'cancelled';
    case 'timeout':
      return 'timed_out';
    case 'oom':
    case 'pids':
    case 'cpu':
    case 'cpu_budget':
    case 'disk':
    case 'crashed':
    case 'workspace_error':
      return 'failed';
  }
}
