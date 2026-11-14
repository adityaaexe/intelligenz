/**
 * Resource profiles — the numbers, in one table, owned by the server.
 *
 * ## Why this is not a request field
 *
 * An agent that can ask for `HEAVY` is an agent that can ask for 2 GiB and 10 minutes,
 * and "the model chose to give itself more memory" is not a resource policy. The
 * profile is selected here, from the task's own risk class and from operator
 * configuration, **before** the adapter is asked for anything. `ExecutionRequest` has no
 * profile field and the adapter never sees one.
 *
 * ## Why the numbers are separate from the enforcement
 *
 * The table is intent; the effective limits are read back from the cgroup files after
 * they are written (`cgroup.ts#readEffectiveLimits`). Keeping them apart is what makes
 * "standard = 1 GiB" an auditable statement rather than a comment: the run's
 * `executionProfile` says which row was chosen and the cgroup says what was applied.
 *
 * ## `cpu.max` is a rate, not a total
 *
 * `cpu.max` is `quota period` in microseconds: `100000 100000` means "one CPU's worth
 * per 100 ms", i.e. one core. It is a bandwidth ceiling. The *maximum* CPU a run can
 * consume is therefore `quota/period × wallClock`, and that derived number is what the
 * worker checks after the fact — because if a run reports more CPU than the quota
 * allows, the quota was not in force and the platform must not claim it was.
 */

export const RESOURCE_PROFILE_NAMES = ['SMALL', 'STANDARD', 'HEAVY'] as const;

export type ResourceProfileName = (typeof RESOURCE_PROFILE_NAMES)[number];

export interface ResourceProfile {
  readonly name: ResourceProfileName;
  /** `memory.max` — aggregate RSS for the whole process tree. */
  readonly memoryMaxBytes: number;
  /** `pids.max` — every thread and process in the tree counts as one. */
  readonly pidsMax: number;
  readonly cpuQuotaMicros: number;
  readonly cpuPeriodMicros: number;
  /**
   * **Total** CPU this attempt may burn, in microseconds — a budget, not a rate.
   *
   * `cpu.max` alone says how fast, never how much: a run at 1 CPU for its whole 300 s
   * wall clock legitimately consumes 300 CPU-seconds, which is an enormous amount of
   * work for a task that should have taken ten. The budget is sampled from
   * `cpu.stat usage_usec` while the attempt is running, and when it is exhausted the
   * cgroup is killed and the reason is recorded as `cpu_budget` — distinct from
   * `timeout` (wall clock) and from `cpu` (the rate ceiling was not in force).
   *
   * Each value is deliberately below `quota/period × wallClock`: a budget that cannot be
   * reached before the deadline is a comment, not a limit. It also has to leave room for
   * the process to be killed and read back, so it is not set to the theoretical maximum.
   */
  readonly cpuBudgetUs: number;
  /** Enforced by the adapter's own timeout, capped by the activity's deadline. */
  readonly wallClockMs: number;
  /** Sum of bytes the attempt may leave behind as evidence. Enforced in `output-cap`. */
  readonly outputCapBytes: number;
  /**
   * The disk ceiling the workspace checkout is bounded to, in bytes.
   *
   * This is a **requirement on the volume**, not a number the platform can apply to a
   * directory: the quota is a property of a fixed-size block device (Gate D). A volume
   * smaller than this is refused at lease time; the effective value is the volume's,
   * read back with `statfs`, never this constant.
   */
  readonly diskQuotaBytes: number;
  /**
   * `io.max` on the volume's backing device, bytes per second. `0` disables it.
   *
   * A policy number, not a measurement: a bounded volume is shared by every attempt
   * leasing it over time, and a single attempt that saturates the device makes every
   * other attempt's `git clone` slow for reasons none of them can see. The values are
   * below what this host's loop device sustains (~500 MiB/s measured), so the limit is
   * reachable — a limit above the hardware is a comment.
   */
  readonly ioReadBps: number;
  readonly ioWriteBps: number;
  /** Per-attempt spend ceiling, applied as `min(profile, configured)`. */
  readonly usdCapUsd: number;
}

const MIB = 1024 * 1024;

/** Every profile's checkout lives on one bounded volume of this size. */
const VOLUME_BYTES = 1024 * MIB;

/**
 * The table from the Phase 4 directive, plus the two Phase 5 numbers.
 *
 * | Profile | cpu.max | wall clock | **cpu budget** | ratio |
 * |---|---|---|---|---|
 * | SMALL | 0.5 CPU | 120 s | 30 s | 50% of the theoretical maximum |
 * | STANDARD | 1 CPU | 300 s | 60 s | 20% |
 * | HEAVY | 2 CPU | 600 s | 120 s | 10% |
 *
 * The ratio shrinks as the profile grows on purpose: a larger profile buys *headroom*,
 * not *permission to spin*. `HEAVY` at 2 CPU for ten minutes could otherwise consume
 * twenty CPU-minutes; a twelve-CPU-minute budget is already generous for a coding task.
 */
export const RESOURCE_PROFILES: Readonly<Record<ResourceProfileName, ResourceProfile>> = {
  SMALL: {
    name: 'SMALL',
    memoryMaxBytes: 512 * MIB,
    pidsMax: 64,
    cpuQuotaMicros: 50_000,
    cpuPeriodMicros: 100_000,
    cpuBudgetUs: 30_000_000,
    wallClockMs: 120_000,
    outputCapBytes: 5 * MIB,
    diskQuotaBytes: VOLUME_BYTES,
    ioReadBps: 50 * MIB,
    ioWriteBps: 50 * MIB,
    usdCapUsd: 0.1,
  },
  STANDARD: {
    name: 'STANDARD',
    memoryMaxBytes: 1024 * MIB,
    pidsMax: 128,
    cpuQuotaMicros: 100_000,
    cpuPeriodMicros: 100_000,
    cpuBudgetUs: 60_000_000,
    wallClockMs: 300_000,
    outputCapBytes: 5 * MIB,
    diskQuotaBytes: VOLUME_BYTES,
    ioReadBps: 100 * MIB,
    ioWriteBps: 100 * MIB,
    usdCapUsd: 0.5,
  },
  HEAVY: {
    name: 'HEAVY',
    memoryMaxBytes: 2048 * MIB,
    pidsMax: 256,
    cpuQuotaMicros: 200_000,
    cpuPeriodMicros: 100_000,
    cpuBudgetUs: 120_000_000,
    wallClockMs: 600_000,
    outputCapBytes: 10 * MIB,
    diskQuotaBytes: VOLUME_BYTES,
    ioReadBps: 200 * MIB,
    ioWriteBps: 200 * MIB,
    usdCapUsd: 2.0,
  },
};

/** The risk vocabulary the selection uses. Mirrors `RiskClass` without importing it. */
export type SelectionRiskClass = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

export interface ProfileSelectionInput {
  readonly riskClass: SelectionRiskClass;
  /**
   * True when the adapter spawns a real process tree (`opencode-cli`). A simulated
   * adapter gets no floor, so `SMALL` remains reachable for fixture and test work.
   */
  readonly realRuntime: boolean;
  /** `WORKER_RESOURCE_PROFILE`. An operator decision, validated at boot. */
  readonly configured: ResourceProfileName | undefined;
}

export interface ProfileSelection {
  readonly profile: ResourceProfile;
  /** Why this row, in one sentence. Logged with the attempt, so a profile is explainable. */
  readonly reason: string;
}

export class ResourceProfileError extends Error {
  readonly code: 'RESOURCE_PROFILE_UNKNOWN' | 'RESOURCE_PROFILE_UNAVAILABLE';

  constructor(code: ResourceProfileError['code'], message: string) {
    super(message);
    this.name = 'ResourceProfileError';
    this.code = code;
  }
}

export function isResourceProfileName(value: unknown): value is ResourceProfileName {
  return typeof value === 'string' && (RESOURCE_PROFILE_NAMES as readonly string[]).includes(value);
}

export function getResourceProfile(name: ResourceProfileName): ResourceProfile {
  const profile = RESOURCE_PROFILES[name];

  if (profile === undefined) {
    throw new ResourceProfileError(
      'RESOURCE_PROFILE_UNKNOWN',
      `Unknown resource profile "${name}"`,
    );
  }

  return profile;
}

/**
 * The selection policy. Deterministic, documented, and impossible for an agent to
 * influence: every input comes from the database row the API wrote and from operator
 * configuration.
 *
 * - An explicit `WORKER_RESOURCE_PROFILE` wins. Operators have context this function
 *   does not, and a wrong explicit value is a deployment decision, not a bug.
 * - `CRITICAL` gets `HEAVY`: a task the policy engine classified as critical is the one
 *   case where the larger ceiling is worth the larger blast radius — and `HEAVY` is
 *   refused outright when cgroups are unavailable.
 * - `HIGH` and `MEDIUM` get `STANDARD`.
 * - `LOW` gets `SMALL`.
 * - A real runtime has a floor of `STANDARD`. The sandbox runs `node`, the shim and the
 *   agent in one tree; 512 MiB leaves too little headroom for a run that is failing to
 *   still produce the transcript that explains why. This is a policy choice, stated as
 *   one — not a measurement.
 */
export function selectResourceProfile(input: ProfileSelectionInput): ProfileSelection {
  if (input.configured !== undefined) {
    return {
      profile: getResourceProfile(input.configured),
      reason: `operator override WORKER_RESOURCE_PROFILE=${input.configured}`,
    };
  }

  const byRisk: Record<SelectionRiskClass, ResourceProfileName> = {
    CRITICAL: 'HEAVY',
    HIGH: 'STANDARD',
    MEDIUM: 'STANDARD',
    LOW: 'SMALL',
  };

  const riskChoice = byRisk[input.riskClass];
  const floored = input.realRuntime && riskChoice === 'SMALL' ? 'STANDARD' : riskChoice;

  return {
    profile: getResourceProfile(floored),
    reason:
      floored === riskChoice
        ? `riskClass=${input.riskClass}`
        : `riskClass=${input.riskClass} raised to the real-runtime floor`,
  };
}

/**
 * The maximum CPU this profile's quota permits over its own wall clock, in
 * microseconds — with 10% headroom for period-boundary effects (a run can be granted a
 * full period's quota on both sides of the deadline).
 *
 * Used as an enforcement *check*, not as a second limit: a run that exceeds it consumed
 * more CPU than the quota allows, which means the quota was not applied.
 */
export function cpuCeilingFor(profile: ResourceProfile): number {
  const perMs = profile.cpuQuotaMicros / profile.cpuPeriodMicros;
  const derivedUs = perMs * profile.wallClockMs * 1000;

  return Math.round(derivedUs * 1.1);
}

/**
 * The CPU budget in milliseconds, for logs and for the error an operator reads.
 * `cpu.stat usage_usec` is microseconds; both units appear in the attempt record.
 */
export function cpuBudgetMs(profile: ResourceProfile): number {
  return Math.round(profile.cpuBudgetUs / 1000);
}

/**
 * What a sampled `usage_usec` means against the budget. Kept pure and separate from the
 * sampler so the arithmetic is testable without a cgroup.
 */
export type CpuBudgetVerdict = 'within' | 'exhausted';

export function checkCpuBudget(usageUs: number, budgetUs: number): CpuBudgetVerdict {
  if (budgetUs <= 0) return 'within';

  return usageUs > budgetUs ? 'exhausted' : 'within';
}

/**
 * `HEAVY` requires aggregate enforcement. Under rlimits alone the ceiling it promises
 * (2 GiB, 256 pids) is a per-process promise applied to an unbounded number of
 * processes, so the one profile whose promise is *most* dependent on cgroups is the one
 * refused when they are absent. `SMALL` and `STANDARD` still run — with their profiles
 * recorded as `rlimit-only`, which is what they actually are.
 *
 * ## Why disk joins the same refusal, and why it is opt-in
 *
 * `HEAVY` is the profile an operator reaches for when a task is expected to be large.
 * Without bounded volumes its checkout is unbounded, so a `HEAVY` label would promise
 * 2 GiB of memory and say nothing about a checkout that can fill the host. The rule is
 * the same one as for cgroups: a profile is refused when a control it names cannot be
 * enforced, rather than silently downgraded.
 *
 * `SMALL` and `STANDARD` keep running with disk declared-but-unenforced, and the
 * attempt log says so. That is a deliberate asymmetry: refusing every run on a host
 * without volumes would make the platform unusable for the ordinary case, while calling
 * an unbounded checkout `HEAVY` would be the lie this phase exists to stop.
 *
 * `disk` is an options object rather than a positional string so that omitting it means
 * "this caller has no opinion about disk" — the pre-Phase-5 behaviour — instead of
 * quietly defaulting to a mode that is either a silent allow or a spurious refusal. The
 * worker's activity passes it on every call.
 */
export function assertProfileAvailable(
  profile: ResourceProfile,
  cgroupMode: 'enforced' | 'unavailable',
  disk?: { readonly mode: 'bounded' | 'unavailable' },
): void {
  if (profile.name !== 'HEAVY') return;

  if (cgroupMode === 'unavailable') {
    throw new ResourceProfileError(
      'RESOURCE_PROFILE_UNAVAILABLE',
      'The HEAVY resource profile requires cgroup v2 enforcement (memory.max, pids.max, ' +
        'cpu.max per attempt). This worker reports cgroup isolation as unavailable, so a ' +
        'HEAVY run would be an unbounded run with a HEAVY label. Refused. ' +
        'Run infra/scripts/setup-cgroups.sh and start the worker via ' +
        'infra/scripts/worker-with-cgroup.sh.',
    );
  }

  if (disk?.mode === 'unavailable') {
    throw new ResourceProfileError(
      'RESOURCE_PROFILE_UNAVAILABLE',
      'The HEAVY resource profile requires a bounded workspace volume: without one the ' +
        'checkout is an unbounded directory on the host filesystem, so a HEAVY run would ' +
        'promise 2 GiB of memory and no disk ceiling at all. Refused. Run ' +
        'sudo bash infra/scripts/setup-workspace-volumes.sh once, then start the worker ' +
        'with WORKSPACE_VOLUMES_ROOT=/var/lib/intelligenz/mnt.',
    );
  }
}

/** The value written to `ExecutionAttempt.executionProfile`. Never a wish. */
export function executionProfileLabel(
  profile: ResourceProfile,
  cgroupMode: 'enforced' | 'unavailable',
): string {
  return cgroupMode === 'enforced' ? profile.name.toLowerCase() : 'rlimit-only';
}
