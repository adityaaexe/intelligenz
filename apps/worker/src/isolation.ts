import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';

import {
  SHARED_KERNEL_MISSING_CONTROLS,
  type ExecutionIsolation,
} from '@intelligenz/contracts';

import type { ResourceProfile } from './resource-profiles';

/**
 * Isolation capability — what this host can *actually* launch, and the gate that refuses
 * a profile it cannot serve.
 *
 * ## Why a measurement and not a flag
 *
 * ADR D-007 decided that bubblewrap is the only operational tier on this host and that a
 * profile requiring a virtual machine must **fail closed before the agent is launched**.
 * The rule was written down and unenforced: nothing read `/dev/kvm`, so a VM-requiring
 * profile would have run under a weaker tier with nothing in the record saying so.
 *
 * The fix cannot be a boolean in configuration. `WORKER_VM_AVAILABLE=1` on a host with no
 * virtualisation is not a capability, it is a wish, and a platform that believes it will
 * claim a boundary it does not have. So availability is probed from the two facts a VM
 * backend actually needs:
 *
 *   1. `/dev/kvm` exists **and opens for read/write** — the device a KVM-backed VMM issues
 *      its ioctls against. Existence alone is not enough (mode 000, a container mask, and a
 *      regular file all "exist"); readability alone is not enough either (a bind mount from
 *      a host without the module).
 *   2. `/proc/cpuinfo` reports `vmx` (Intel) or `svm` (AMD) — the hardware virtualisation
 *      extension the hypervisor needs.
 *
 * Both are filesystem reads, so both are injectable and both are testable, and neither can
 * be forged by a request field or an environment variable: nothing in this module reads
 * `process.env`.
 *
 * ## False negatives are the safe direction
 *
 * The flag check is x86-shaped. On arm64 `/proc/cpuinfo` has no `vmx`/`svm` line, so this
 * probe reports unavailable on a host that might in fact have KVM. That is deliberate: the
 * cost of the false negative is a refusal with a reason naming the missing signal, and the
 * cost of a false positive is a run that believes it has a boundary it does not. When an
 * arm64 host is provisioned, this probe gets an arch-aware branch — and it must be a
 * measurement there too.
 *
 * ## Why nothing is cached
 *
 * The cgroup probe runs once per process because it costs a child process. This one is two
 * file reads, so it runs per attempt, which means a worker that starts before `/dev/kvm` is
 * exposed and sees it appear later does not keep refusing — and a host that loses the
 * device stops being described as vm-capable on the next attempt.
 */

/** The KVM device node. Named as a constant so the refusal message can be asserted on. */
export const DEFAULT_KVM_PATH = '/dev/kvm';

/** Where the CPU's virtualisation extensions are reported on x86. */
export const DEFAULT_CPU_INFO_PATH = '/proc/cpuinfo';

/** The CPU flag either vendor sets when hardware virtualisation is exposed. */
const VIRTUALISATION_FLAGS = ['vmx', 'svm'] as const;

export interface IsolationCapability {
  /**
   * The strongest tier this host can launch. Only one value exists today, because bwrap is
   * the only backend; the field is present so a future backend changes the fact, not the
   * shape of the report.
   */
  readonly tier: 'restricted-shared-kernel';
  /** True only when both measurements agree. Never read from configuration. */
  readonly vmAvailable: boolean;
  /** One sentence naming each measurement, so a refusal is explainable from the record. */
  readonly reason: string;
}

/** Paths are injectable for exactly one reason: to prove the probe measures a file. */
export interface IsolationProbe {
  readonly kvmPath?: string;
  readonly cpuInfoPath?: string;
}

interface Measurement {
  readonly ok: boolean;
  readonly detail: string;
}

function describeError(error: unknown): string {
  const code = (error as { code?: unknown }).code;

  return typeof code === 'string' ? code : error instanceof Error ? error.message : String(error);
}

/**
 * Present, and openable read/write.
 *
 * The device type is deliberately **not** checked. What makes `/dev/kvm` KVM is the
 * `KVM_GET_API_VERSION` ioctl a backend issues after opening it, not `S_IFCHR`; a stat-based
 * device check would accept a stale node that ioctls fail on and reject a valid one behind
 * a different device number. The probe answers the question it can answer honestly — "can a
 * backend open this path" — and leaves the protocol check to the backend that exists.
 */
async function probeKvm(path: string): Promise<Measurement> {
  try {
    await stat(path);
  } catch (error) {
    return { ok: false, detail: `${path} is not present (${describeError(error)})` };
  }

  try {
    await access(path, constants.R_OK | constants.W_OK);
  } catch (error) {
    return {
      ok: false,
      detail: `${path} exists but cannot be opened read/write (${describeError(error)})`,
    };
  }

  return { ok: true, detail: `${path} is present and openable read/write` };
}

/**
 * Does the CPU advertise hardware virtualisation?
 *
 * `/proc/cpuinfo` repeats a `flags` line per logical CPU on x86 (and a `Features` line per
 * core on arm64). Only those lines are inspected: a `model name` that happens to contain
 * "vmx" is not a capability, and a flag list parsed from the whole file would say yes to it.
 */
async function probeCpuVirtualisation(path: string): Promise<Measurement> {
  let contents: string;

  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    return { ok: false, detail: `${path} is unreadable (${describeError(error)})` };
  }

  const flags = contents
    .split('\n')
    .filter((line) => /^(flags|Features)\s*:/.test(line))
    .flatMap((line) => (line.split(':')[1] ?? '').trim().split(/\s+/))
    .filter((flag) => flag.length > 0);

  const present = VIRTUALISATION_FLAGS.filter((flag) => flags.includes(flag));

  return present.length > 0
    ? { ok: true, detail: `${path} reports ${present.join('/')}` }
    : { ok: false, detail: `${path} reports no ${VIRTUALISATION_FLAGS.join('/')} flag` };
}

/**
 * Probe the host. Both signals must agree; either one missing means no VM boundary.
 *
 * The reason string always names both paths, on the positive and the negative path, because
 * an operator reading a refusal needs to know which of the two measurements failed — and
 * because "vm is unavailable" without a path is the kind of message that gets ignored.
 */
export async function detectIsolationCapability(
  probe: IsolationProbe = {},
): Promise<IsolationCapability> {
  const kvmPath = probe.kvmPath ?? DEFAULT_KVM_PATH;
  const cpuInfoPath = probe.cpuInfoPath ?? DEFAULT_CPU_INFO_PATH;

  const [kvm, cpu] = await Promise.all([probeKvm(kvmPath), probeCpuVirtualisation(cpuInfoPath)]);

  const vmAvailable = kvm.ok && cpu.ok;

  return {
    tier: 'restricted-shared-kernel',
    vmAvailable,
    reason: vmAvailable
      ? `vm available: ${kvm.detail}; ${cpu.detail}`
      : `vm unavailable: ${kvm.detail}; ${cpu.detail}`,
  };
}

/** The profile fields the plan depends on. Structural, so a test can pass a stub. */
export type IsolationRequirement = Pick<ResourceProfile, 'name' | 'isolation'>;

/**
 * Decide what this profile may run under, before anything is provisioned.
 *
 * Three properties, each a requirement rather than a nicety:
 *
 *   - **Fail closed.** A `vm` requirement with `vmAvailable: false` yields `refused: true`
 *     and `effective: null`. There is no third outcome: the function cannot return a weaker
 *     tier for a stronger requirement, because the weaker tier is not a value it produces
 *     for that branch.
 *   - **No silent upgrade.** A vm-capable host serving a `restricted-shared-kernel` profile
 *     reports `restricted-shared-kernel`. Crediting a run with a boundary its profile never
 *     asked for — and which the launch path did not use — would be the same lie in the
 *     other direction.
 *   - **Controls are stated.** A shared-kernel run lists what it does not provide, so no
 *     consumer can render "isolated" from a tier name alone.
 */
export function planIsolation(
  profile: IsolationRequirement,
  capability: IsolationCapability,
): ExecutionIsolation {
  const required = profile.isolation;

  if (required === 'vm' && !capability.vmAvailable) {
    return {
      required,
      effective: null,
      refused: true,
      vmAvailable: false,
      controlsUnavailable: [...SHARED_KERNEL_MISSING_CONTROLS],
      // The measurement, verbatim. `required` already says what was asked for, so repeating
      // it here would push the actual evidence to the end of the sentence.
      reason: capability.reason,
    };
  }

  return {
    required,
    effective: required,
    refused: false,
    vmAvailable: capability.vmAvailable,
    controlsUnavailable: required === 'vm' ? [] : [...SHARED_KERNEL_MISSING_CONTROLS],
    reason: `profile ${profile.name} declares ${required}; ${capability.reason}`,
  };
}

/**
 * The refusal, as the sentence an operator reads in the task history.
 *
 * It names the profile, the tier, and the measurement, and it says what did **not** happen —
 * because the alternative to a refusal was a run that looked normal.
 */
export function isolationRefusalMessage(
  profile: IsolationRequirement,
  isolation: ExecutionIsolation,
): string {
  return (
    `Isolation tier unavailable: profile ${profile.name} requires "${isolation.required}", ` +
    `and this host cannot provide it — ${isolation.reason}. Refused before provisioning: no ` +
    'workspace, no agent process and no broker request were created, and the attempt is ' +
    'recorded as failed. A run that asked for a virtual machine is never served a shared ' +
    'kernel.'
  );
}
