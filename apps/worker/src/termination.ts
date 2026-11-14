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

  const usage = input.usage;

  // OOM first: the kernel's kill is the most specific fact available, and an adapter
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

  if (input.adapter === 'succeeded') {
    return { reason: 'completed', resourceKill: false, overridesAdapter: false };
  }

  return { reason: 'crashed', resourceKill: false, overridesAdapter: false };
}

/**
 * `RunStatus` for the attempt, given the verdict. A resource kill is never a success and
 * never an agent failure: `oom`/`pids`/`cpu` become `failed` with a `terminationReason`
 * that says who ended it, and only the wall clock produces `timed_out`.
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
    case 'crashed':
    case 'workspace_error':
      return 'failed';
  }
}
