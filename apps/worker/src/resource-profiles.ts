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
  /** Enforced by the adapter's own timeout, capped by the activity's deadline. */
  readonly wallClockMs: number;
  /** Sum of bytes the attempt may leave behind as evidence. */
  readonly outputCapBytes: number;
  /** Per-attempt spend ceiling, applied as `min(profile, configured)`. */
  readonly usdCapUsd: number;
}

const MIB = 1024 * 1024;

/**
 * The table from the Phase 4 directive, verbatim. `STANDARD` is the profile a real
 * adapter gets by default; `SMALL` is for cheap, simulated or fixture work; `HEAVY` is
 * opt-in through policy only.
 */
export const RESOURCE_PROFILES: Readonly<Record<ResourceProfileName, ResourceProfile>> = {
  SMALL: {
    name: 'SMALL',
    memoryMaxBytes: 512 * MIB,
    pidsMax: 64,
    cpuQuotaMicros: 50_000,
    cpuPeriodMicros: 100_000,
    wallClockMs: 120_000,
    outputCapBytes: 5 * MIB,
    usdCapUsd: 0.1,
  },
  STANDARD: {
    name: 'STANDARD',
    memoryMaxBytes: 1024 * MIB,
    pidsMax: 128,
    cpuQuotaMicros: 100_000,
    cpuPeriodMicros: 100_000,
    wallClockMs: 300_000,
    outputCapBytes: 5 * MIB,
    usdCapUsd: 0.5,
  },
  HEAVY: {
    name: 'HEAVY',
    memoryMaxBytes: 2048 * MIB,
    pidsMax: 256,
    cpuQuotaMicros: 200_000,
    cpuPeriodMicros: 100_000,
    wallClockMs: 600_000,
    outputCapBytes: 10 * MIB,
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
 * `HEAVY` requires aggregate enforcement. Under rlimits alone the ceiling it promises
 * (2 GiB, 256 pids) is a per-process promise applied to an unbounded number of
 * processes, so the one profile whose promise is *most* dependent on cgroups is the one
 * refused when they are absent. `SMALL` and `STANDARD` still run — with their profiles
 * recorded as `rlimit-only`, which is what they actually are.
 */
export function assertProfileAvailable(
  profile: ResourceProfile,
  cgroupMode: 'enforced' | 'unavailable',
): void {
  if (profile.name === 'HEAVY' && cgroupMode === 'unavailable') {
    throw new ResourceProfileError(
      'RESOURCE_PROFILE_UNAVAILABLE',
      'The HEAVY resource profile requires cgroup v2 enforcement (memory.max, pids.max, ' +
        'cpu.max per attempt). This worker reports cgroup isolation as unavailable, so a ' +
        'HEAVY run would be an unbounded run with a HEAVY label. Refused. ' +
        'Run infra/scripts/setup-cgroups.sh and start the worker via ' +
        'infra/scripts/worker-with-cgroup.sh.',
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
