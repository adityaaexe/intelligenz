import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { SETUP_REMEDIATION, getCgroupCapability, type CgroupCapability } from './capabilities';

/**
 * The execution-enforcement gate: may this process execute tasks at all?
 *
 * ## The defect this closes
 *
 * `getCgroupCapability` answers "can this host enforce". It does **not** answer "is this
 * process in the right place to use that ability", and for a long time the worker treated
 * the first answer as if it were the second: `main.ts` logged `UNAVAILABLE … rlimit-only`
 * at `warn` and then registered with Temporal and polled. A worker started with plain
 * `pnpm dev` therefore executed every task with rlimit-only enforcement while the boot log
 * said so — and every test passed, because no test asserted the worker's own placement.
 *
 * The I/O and CPU proofs (`6705712`, `1cf3c58`) are true for a worker launched through
 * `infra/scripts/worker-with-cgroup.sh`. Nothing enforced "launched through the launcher".
 * That is the gap: a documented deployment requirement is not a control.
 *
 * ## Why the check reads the process, not the configuration
 *
 * `WORKER_CGROUP_ROOT` is a *path this process can write to*. A worker started from a
 * login session can create a cgroup under the delegation root, write `memory.max`, read it
 * back, and still be unable to move a single process into it — a `cgroup.procs` write is
 * authorised against **both** the source and the destination. So the gate asks the kernel
 * where this process actually is (`/proc/self/cgroup`), maps the configured filesystem
 * root into that same namespace (`/proc/self/mountinfo`), and compares them as path
 * segments. `/intelligenz-evil` is not a child of `/intelligenz`; a string `startsWith`
 * would say it is.
 *
 * Five checks, in order of what can be known:
 *
 *   1. `CGROUP_V2_UNIFIED`           — `/proc/self/cgroup` is exactly `0::…`, no v1 lines
 *   2. `CGROUP_PATH_UNDER_ROOT`      — this process is at or below the delegation root
 *   3. `CGROUP_CONTROLLERS_DELEGATED`— cpu/memory/pids delegated to children at the root
 *   4. `CGROUP_CONTROL_FILES_SANE`   — `memory.max`, `pids.max` exist *and* read back sane
 *   5. `CGROUP_MODE_ENFORCED`        — the probe, which migrates a real child, says enforced
 *
 * Checks 1–4 are cheap and local; check 5 is the expensive one and is passed in when the
 * caller has already run it, so boot probes once. Both are needed: 1–4 would pass for a
 * process in the root whose *children* are never migrated, and 5 alone would pass for a
 * process outside the subtree on a host where… it cannot, which is precisely why 5 is a
 * real check — but it says nothing about *which* path the process is in when it succeeds
 * through a different mechanism (a privileged launcher, a future `nsdelegate` mount), and
 * the diagnostic a failed boot needs is the path, not just "the probe said no".
 *
 * ## Fail closed, not degraded
 *
 * A refusal throws `ExecutionEnforcementError` before `NativeConnection.connect`. The
 * process exits non-zero and never polls, so it is **unavailable for dispatch** rather
 * than quietly executing with weaker enforcement. A degraded worker is worse than a dead
 * one: tasks are accepted, executed without CPU/memory/PID/I/O bounds, and recorded as if
 * the platform's claim still held.
 */

export const EXECUTION_ENFORCEMENT_UNAVAILABLE = 'EXECUTION_ENFORCEMENT_UNAVAILABLE';

/** The controllers the attempt limits depend on. Same set `capabilities.ts` probes. */
export const REQUIRED_CONTROLLERS = ['cpu', 'memory', 'pids'] as const;

/**
 * Control files that must exist **and** read back sane at the delegation root.
 *
 * `pids.max` and `memory.max` are the two whose absence or garbage value cannot be
 * compensated for: without them an attempt has no memory ceiling and no fork ceiling, and
 * the profiles' numbers are decoration. `cpu.max` is checked indirectly — check 5's probe
 * writes and reads it back — so it is not duplicated here.
 */
const REQUIRED_LIMIT_FILES = ['memory.max', 'pids.max'] as const;

export type EnforcementCheckId =
  | 'CGROUP_V2_UNIFIED'
  | 'CGROUP_PATH_UNDER_ROOT'
  | 'CGROUP_CONTROLLERS_DELEGATED'
  | 'CGROUP_CONTROL_FILES_SANE'
  | 'CGROUP_MODE_ENFORCED';

export interface EnforcementFailure {
  readonly check: EnforcementCheckId;
  /** The measured fact, with the path and value that produced it. Never a category. */
  readonly detail: string;
}

export interface EnforcementVerified {
  readonly mode: 'verified';
  /** The configured delegation root, as a filesystem path. */
  readonly root: string;
  /** `/proc/self/cgroup`'s path — mount-relative, e.g. `/intelligenz/worker`. */
  readonly actualCgroup: string;
  /** The configured root in the same namespace, e.g. `/intelligenz`. */
  readonly expectedCgroupPath: string;
  readonly controllers: readonly string[];
  readonly limits: Readonly<Record<string, string>>;
}

export interface EnforcementRefused {
  readonly mode: 'refused';
  readonly root: string;
  readonly actualCgroup: string;
  /** `unresolved` when the configured root is not inside a cgroup2 mount at all. */
  readonly expectedCgroupPath: string;
  readonly failures: readonly EnforcementFailure[];
  readonly remediation: string;
}

export type ExecutionEnforcement = EnforcementVerified | EnforcementRefused;

export class ExecutionEnforcementError extends Error {
  readonly code = EXECUTION_ENFORCEMENT_UNAVAILABLE;
  readonly assessment: EnforcementRefused;

  constructor(assessment: EnforcementRefused) {
    super(
      `Execution enforcement unavailable: ${assessment.failures
        .map((failure) => `${failure.check}: ${failure.detail}`)
        .join(' | ')}`,
    );

    this.name = 'ExecutionEnforcementError';
    this.assessment = assessment;
  }

  /**
   * The boot-log record. Every field is a measured fact plus the one string that fixes it:
   * an operator reading this line should not need to read this file.
   */
  toDiagnostic(): Record<string, unknown> {
    return {
      code: this.code,
      failingChecks: this.assessment.failures.map((failure) => failure.check),
      failures: this.assessment.failures.map((failure) => ({
        check: failure.check,
        detail: failure.detail,
      })),
      actualCgroup: this.assessment.actualCgroup,
      expectedCgroupPath: this.assessment.expectedCgroupPath,
      cgroupRoot: this.assessment.root,
      remediation: this.assessment.remediation,
    };
  }
}

// ── Pure parsing ─────────────────────────────────────────────────────────────────
//
// Exported so the refusal cases are testable without a cgroup filesystem: a test that can
// only run where the condition already exists never runs.

export interface CgroupProcState {
  readonly unified: boolean;
  /** The path from the `0::` line, or `null` when there is no usable one. */
  readonly path: string | null;
  readonly detail: string;
}

/**
 * Parse `/proc/self/cgroup`.
 *
 * A unified (cgroup v2) process has exactly one line, `0::<path>`. A v1 or hybrid host has
 * `N:<controllers>:<path>` lines instead of, or beside, it. Hybrid is refused rather than
 * accepted: on a hybrid host the memory and pids controllers can be mounted on v1, where
 * the files this gate checks do not mean what they mean on v2 — a `memory.max` under v2 is
 * then a decorative file. Accepting the `0::` line alone would be the same class of false
 * positive as accepting a plain directory because a write succeeded.
 */
export function parseCgroupProc(text: string): CgroupProcState {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    return { unified: false, path: null, detail: '/proc/self/cgroup is empty' };
  }

  const unifiedLines = lines.filter((line) => line.startsWith('0::'));
  const legacyLines = lines.filter((line) => !line.startsWith('0::'));

  if (unifiedLines.length !== 1) {
    return {
      unified: false,
      path: null,
      detail:
        `expected exactly one '0::<path>' line in /proc/self/cgroup, found ` +
        `${String(unifiedLines.length)} of ${String(lines.length)} line(s)`,
    };
  }

  if (legacyLines.length > 0) {
    return {
      unified: false,
      path: null,
      detail:
        `/proc/self/cgroup carries ${String(legacyLines.length)} cgroup v1 controller line(s) ` +
        `beside the unified one (first: "${legacyLines[0] ?? ''}"). This is a hybrid ` +
        'hierarchy, where memory/pids may be mounted on v1 and the v2 limit files are ' +
        'decorative. Refusing rather than claiming enforcement.',
    };
  }

  const path = unifiedLines[0]?.slice('0::'.length) ?? '';

  if (!path.startsWith('/')) {
    return {
      unified: false,
      path: null,
      detail: `the '0::' line does not carry an absolute path: "${path}"`,
    };
  }

  return { unified: true, path, detail: `cgroup v2, this process is at ${path}` };
}

export interface CgroupMount {
  readonly mountPoint: string;
  /** The mount's own root within the hierarchy; `/` for a normal mount. */
  readonly mountRoot: string;
}

/**
 * The cgroup2 mounts from `/proc/self/mountinfo`.
 *
 * Format: `id parent major:minor root mountpoint options [optional…] - fstype source
 * superoptions`. Splitting on ` - ` is the documented way to separate the optional fields,
 * which may themselves contain spaces.
 */
export function parseCgroup2Mounts(mountInfo: string): readonly CgroupMount[] {
  const mounts: CgroupMount[] = [];

  for (const line of mountInfo.split('\n')) {
    const [before, after] = line.split(' - ');
    if (before === undefined || after === undefined) continue;

    const fields = before.trim().split(' ');
    const type = after.trim().split(' ')[0];

    if (type !== 'cgroup2') continue;

    const mountRoot = fields[3];
    const mountPoint = fields[4];

    if (mountRoot === undefined || mountPoint === undefined) continue;

    mounts.push({ mountPoint, mountRoot });
  }

  return mounts;
}

/** Path segments, with empty segments dropped. `//a/b/` → `['a','b']`. */
function segments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function joinCgroupPath(...parts: readonly string[]): string {
  const joined = parts.flatMap((part) => segments(part)).join('/');

  return joined.length === 0 ? '/' : `/${joined}`;
}

/**
 * Is `child` at or below `parent`, compared by path segment?
 *
 * The whole point of this function is that `startsWith` is wrong: `/intelligenz-evil`
 * starts with `/intelligenz` and is a sibling, not a child. A worker placed there would
 * pass a prefix check and then run with no delegation in effect.
 */
export function isCgroupPathUnder(child: string, parent: string): boolean {
  const childSegments = segments(child);
  const parentSegments = segments(parent);

  if (childSegments.length < parentSegments.length) return false;

  return parentSegments.every((segment, index) => childSegments[index] === segment);
}

/**
 * Express the configured filesystem root in `/proc/self/cgroup`'s namespace.
 *
 * `/proc/self/cgroup` reports the path **relative to the hierarchy mount**, not the
 * filesystem path: a worker in `/sys/fs/cgroup/intelligenz/worker` reports
 * `/intelligenz/worker`. Comparing the two directly would fail for every correct
 * deployment, so the mount point is stripped and the mount's own root re-prepended.
 *
 * `undefined` means the configured root is not inside any cgroup2 mount — a
 * misconfiguration, not a placement failure, and the caller says so.
 */
export function resolveRelativeRoot(
  root: string,
  mounts: readonly CgroupMount[],
): { readonly mountPoint: string; readonly relativeRoot: string } | undefined {
  let best: { mountPoint: string; relativeRoot: string } | undefined;

  for (const mount of mounts) {
    if (!isCgroupPathUnder(root, mount.mountPoint)) continue;

    const remainder = segments(root).slice(segments(mount.mountPoint).length);
    const relativeRoot = joinCgroupPath(mount.mountRoot, ...remainder);

    // Longest mount point wins: a nested cgroup2 mount is a different hierarchy, and the
    // innermost one is the one the root actually lives on.
    if (best === undefined || segments(mount.mountPoint).length > segments(best.mountPoint).length) {
      best = { mountPoint: mount.mountPoint, relativeRoot };
    }
  }

  return best;
}

/** `cgroup.controllers` / `cgroup.subtree_control`, with or without the `+` prefixes. */
export function parseControllerList(text: string): ReadonlySet<string> {
  return new Set(
    text
      .replace(/\+/g, ' ')
      .trim()
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
}

export type LimitValue =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly detail: string };

/**
 * A limit file is not "present", it is *readable as a limit*.
 *
 * `max` is a legitimate value (unbounded) and is accepted: the delegation root is the
 * parent of every attempt, so bounding it is not this gate's requirement — the attempt
 * leaves carry the profiles' numbers. `0` is rejected: a zero memory ceiling on the
 * delegation root means no child can start, which is a broken host presented as a limit.
 * Anything else (`''`, `-1`, `unlimited`, `18446744073709551615`) is a value the kernel
 * did not write, and treating it as enforcement is the false positive this gate exists to
 * prevent.
 */
export function parseLimitValue(file: string, raw: string): LimitValue {
  const value = raw.trim();

  if (value === 'max') return { ok: true, value };

  if (!/^\d+$/.test(value)) {
    return {
      ok: false,
      detail: `${file} reads "${value}", which is neither "max" nor a decimal byte/pid count`,
    };
  }

  if (Number(value) <= 0) {
    return { ok: false, detail: `${file} reads "${value}": a non-positive limit bounds nothing` };
  }

  return { ok: true, value };
}

// ── The assessment ──────────────────────────────────────────────────────────────

export interface AssessExecutionEnforcementOptions {
  /** The configured delegation root, `WORKER_CGROUP_ROOT`. */
  readonly root: string;
  /**
   * The probe result, when the caller already has it. Boot passes it so the host is probed
   * once; a test passes a stub. When absent it is computed here.
   */
  readonly capability?: CgroupCapability;
  /** Test seams. Production reads `/proc` and `<root>` for real. */
  readonly procCgroupText?: string;
  readonly mountInfoText?: string;
  readonly readText?: (path: string) => Promise<string>;
}

const UNRESOLVED = 'unresolved';

export async function assessExecutionEnforcement(
  options: AssessExecutionEnforcementOptions,
): Promise<ExecutionEnforcement> {
  const root = options.root.length > 1 ? options.root.replace(/\/+$/, '') : options.root;
  const read =
    options.readText ??
    ((path: string): Promise<string> => readFile(path, 'utf8') as Promise<string>);

  const failures: EnforcementFailure[] = [];
  let actualCgroup = 'unknown';
  let expectedCgroupPath = UNRESOLVED;

  // ── 1. Is this a unified cgroup v2 process? ────────────────────────────────────
  let procText = options.procCgroupText;

  if (procText === undefined) {
    try {
      procText = await read('/proc/self/cgroup');
    } catch (error) {
      failures.push({
        check: 'CGROUP_V2_UNIFIED',
        detail: `cannot read /proc/self/cgroup: ${describeError(error)}`,
      });
    }
  }

  const proc: CgroupProcState =
    procText === undefined
      ? { unified: false, path: null, detail: '/proc/self/cgroup is unreadable' }
      : parseCgroupProc(procText);

  if (proc.path !== null) actualCgroup = proc.path;

  if (!proc.unified) {
    failures.push({ check: 'CGROUP_V2_UNIFIED', detail: proc.detail });
  } else {
    // ── 2. Is this process inside the delegation root? ───────────────────────────
    let mountInfoText = options.mountInfoText;

    if (mountInfoText === undefined) {
      try {
        mountInfoText = await read('/proc/self/mountinfo');
      } catch (error) {
        failures.push({
          check: 'CGROUP_PATH_UNDER_ROOT',
          detail: `cannot read /proc/self/mountinfo to map ${root} into cgroup-path space: ${describeError(error)}`,
        });
      }
    }

    const resolved =
      mountInfoText === undefined
        ? undefined
        : resolveRelativeRoot(root, parseCgroup2Mounts(mountInfoText));

    if (resolved === undefined) {
      if (mountInfoText !== undefined) {
        failures.push({
          check: 'CGROUP_PATH_UNDER_ROOT',
          detail:
            `${root} is not inside any cgroup2 mount listed in /proc/self/mountinfo, so the ` +
            `process's cgroup path (${actualCgroup}) cannot be compared against it. ` +
            'Point WORKER_CGROUP_ROOT at a path on the cgroup2 hierarchy.',
        });
      }
    } else {
      expectedCgroupPath = resolved.relativeRoot;

      if (!isCgroupPathUnder(actualCgroup, expectedCgroupPath)) {
        failures.push({
          check: 'CGROUP_PATH_UNDER_ROOT',
          detail:
            `this process is in cgroup ${actualCgroup}; the delegation root ${root} is ` +
            `${expectedCgroupPath} in cgroup-path terms, and ${actualCgroup} is neither that ` +
            'path nor below it (compared by path segment, so /intelligenz-evil does not ' +
            `count as a child of ${expectedCgroupPath}). A cgroup.procs write is authorised ` +
            'against both the source and the destination, so limits written from here would ' +
            'never be applied to anything this process starts.',
        });
      }
    }
  }

  // ── 3. Are the controllers delegated to children of the root? ──────────────────
  const controllers = await readControllerDelegation(read, root, failures);

  // ── 4. Do the required limit files read back sane? ─────────────────────────────
  const limits = await readLimits(read, root, failures);

  // ── 5. Does the probe — which migrates a real child — report enforcement? ──────
  const capability = options.capability ?? (await getCgroupCapability({ root }));

  if (capability.mode !== 'enforced') {
    failures.push({
      check: 'CGROUP_MODE_ENFORCED',
      detail: `the enforcement probe reported ${capability.mode} [${capability.code}]: ${capability.reason}`,
    });
  } else if (
    expectedCgroupPath !== UNRESOLVED &&
    !isCgroupPathUnder(capability.evidence.selfCgroup, expectedCgroupPath)
  ) {
    // The probe's own evidence must agree with the path check above. If it does not, one
    // of the two measurements is stale or the probe ran for a different root; neither is
    // a state to execute under.
    failures.push({
      check: 'CGROUP_MODE_ENFORCED',
      detail:
        `the probe reports enforced but recorded self cgroup ${capability.evidence.selfCgroup}, ` +
        `which is not under ${expectedCgroupPath}. The probe and the placement check disagree.`,
    });
  }

  if (failures.length > 0) {
    return {
      mode: 'refused',
      root,
      actualCgroup,
      expectedCgroupPath,
      failures,
      remediation: capability.mode === 'unavailable' ? capability.remediation : SETUP_REMEDIATION,
    };
  }

  return {
    mode: 'verified',
    root,
    actualCgroup,
    expectedCgroupPath,
    controllers,
    limits,
  };
}

/**
 * Throw when this process may not execute tasks. Returns the verified assessment so the
 * caller can log what was actually checked rather than a generic "ok".
 */
export async function assertExecutionEnforcement(
  options: AssessExecutionEnforcementOptions,
): Promise<EnforcementVerified> {
  const assessment = await assessExecutionEnforcement(options);

  if (assessment.mode === 'refused') throw new ExecutionEnforcementError(assessment);

  return assessment;
}

async function readControllerDelegation(
  read: (path: string) => Promise<string>,
  root: string,
  failures: EnforcementFailure[],
): Promise<readonly string[]> {
  const file = join(root, 'cgroup.controllers');
  const subtreeFile = join(root, 'cgroup.subtree_control');

  let available: ReadonlySet<string>;
  let delegated: ReadonlySet<string>;

  try {
    available = parseControllerList(await read(file));
  } catch (error) {
    failures.push({
      check: 'CGROUP_CONTROLLERS_DELEGATED',
      detail: `cannot read ${file}: ${describeError(error)}. A cgroup2 root always has one, so this is not a hierarchy to trust.`,
    });

    return [];
  }

  try {
    delegated = parseControllerList(await read(subtreeFile));
  } catch (error) {
    failures.push({
      check: 'CGROUP_CONTROLLERS_DELEGATED',
      detail: `cannot read ${subtreeFile}: ${describeError(error)}. Without it the attempt leaves inherit no controller files.`,
    });

    return [...available];
  }

  const missingAvailable = REQUIRED_CONTROLLERS.filter((controller) => !available.has(controller));
  const missingDelegated = REQUIRED_CONTROLLERS.filter((controller) => !delegated.has(controller));

  if (missingAvailable.length > 0) {
    failures.push({
      check: 'CGROUP_CONTROLLERS_DELEGATED',
      detail:
        `${file} does not list ${missingAvailable.join(', ')} ` +
        `(available: ${[...available].join(' ') || 'none'}). The attempt leaves would have no such limit file.`,
    });
  }

  if (missingDelegated.length > 0) {
    failures.push({
      check: 'CGROUP_CONTROLLERS_DELEGATED',
      detail:
        `${subtreeFile} does not delegate ${missingDelegated.join(', ')} to children ` +
        `(delegated: ${[...delegated].join(' ') || 'none'}). A limit on a controller that is ` +
        'not delegated is a file write, not a limit.',
    });
  }

  return [...available];
}

async function readLimits(
  read: (path: string) => Promise<string>,
  root: string,
  failures: EnforcementFailure[],
): Promise<Readonly<Record<string, string>>> {
  const limits: Record<string, string> = {};

  for (const file of REQUIRED_LIMIT_FILES) {
    const path = join(root, file);

    let raw: string;

    try {
      raw = await read(path);
    } catch (error) {
      failures.push({
        check: 'CGROUP_CONTROL_FILES_SANE',
        detail: `cannot read ${path}: ${describeError(error)}. The file's absence means the controller is not delegated at this root.`,
      });
      continue;
    }

    const parsed = parseLimitValue(file, raw);

    if (!parsed.ok) {
      failures.push({ check: 'CGROUP_CONTROL_FILES_SANE', detail: `${path}: ${parsed.detail}` });
      continue;
    }

    limits[file] = parsed.value;
  }

  return limits;
}

function describeError(error: unknown): string {
  if (typeof error !== 'object' || error === null) return String(error);

  const code = (error as { code?: unknown }).code;
  const message = error instanceof Error ? error.message : String(error);

  return typeof code === 'string' && !message.includes(code) ? `${code} (${message})` : message;
}

/** One line for the boot log, in the same shape as `describeCgroupCapability`. */
export function describeExecutionEnforcement(assessment: ExecutionEnforcement): string {
  if (assessment.mode === 'verified') {
    return (
      `execution enforcement: VERIFIED (this process is in ${assessment.actualCgroup}, ` +
      `under ${assessment.expectedCgroupPath}; controllers ${assessment.controllers.join(' ') || 'none'}; ` +
      `memory.max=${assessment.limits['memory.max'] ?? 'unread'} ` +
      `pids.max=${assessment.limits['pids.max'] ?? 'unread'})`
    );
  }

  return (
    `execution enforcement: UNAVAILABLE [${EXECUTION_ENFORCEMENT_UNAVAILABLE}] ` +
    `${assessment.failures.map((failure) => `${failure.check}: ${failure.detail}`).join(' | ')} ` +
    `${assessment.remediation}`
  );
}
