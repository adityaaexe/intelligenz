import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';
import { ExecutionIsolation, SHARED_KERNEL_MISSING_CONTROLS } from '@intelligenz/contracts';

import {
  detectIsolationCapability,
  isolationRefusalMessage,
  planIsolation,
  type IsolationCapability,
} from '../src/isolation';
import {
  RESOURCE_PROFILES,
  VM_PROFILE,
  getResourceProfile,
} from '../src/resource-profiles';

/**
 * Isolation capability and the tier gate (ADR D-007).
 *
 * The rule under test is the one the ADR wrote down and nothing enforced: bubblewrap is a
 * *restricted shared-kernel* tier, a virtual machine is not available on this host, and a
 * profile that requires one must be refused **before** anything is provisioned.
 *
 * Two kinds of assertion here, and they are deliberately different:
 *
 *   - detection is measured against **real files**. The refusal tests read this host's
 *     `/dev/kvm`, so they fail if someone invents a capability. The positive control
 *     injects a fake path, because a host that *can* launch a VM cannot be fabricated.
 *   - planning is pure. A vm-capable capability is constructed, not faked, so the
 *     "no silent upgrade" direction is testable on a host that cannot virtualise.
 */

const temporaryDirectories: string[] = [];

afterAll(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

/** A fake host filesystem: a KVM node stand-in and a cpuinfo with chosen flags. */
async function fakeHost(flags: readonly string[], kvmMode = 0o600): Promise<{
  readonly kvmPath: string;
  readonly cpuInfoPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'iz-isolation-'));
  temporaryDirectories.push(directory);

  const kvmPath = join(directory, 'kvm');
  await writeFile(kvmPath, '', { mode: kvmMode });

  const cpuInfoPath = join(directory, 'cpuinfo');
  await writeFile(
    cpuInfoPath,
    [
      'processor\t: 0',
      'model name\t: Intel(R) Xeon(R) with vmx in the name, which is not a flag',
      `flags\t\t: fpu vme de pse tsc msr pae ${flags.join(' ')}`,
      '',
    ].join('\n'),
  );

  return { kvmPath, cpuInfoPath };
}

const VM_CAPABLE: IsolationCapability = {
  tier: 'restricted-shared-kernel',
  vmAvailable: true,
  reason: 'vm available: /dev/kvm is present; /proc/cpuinfo reports vmx',
};

const NO_VM: IsolationCapability = {
  tier: 'restricted-shared-kernel',
  vmAvailable: false,
  reason: 'vm unavailable: /dev/kvm is not present (ENOENT); /proc/cpuinfo reports no vmx/svm flag',
};

describe('profile isolation declarations', () => {
  it('declares every selectable profile as restricted-shared-kernel', () => {
    for (const profile of Object.values(RESOURCE_PROFILES)) {
      expect(profile.isolation).toBe('restricted-shared-kernel');
    }
  });

  it('declares the VM profile as vm, and keeps it out of the policy table', () => {
    expect(VM_PROFILE.isolation).toBe('vm');
    expect(VM_PROFILE.name).toBe('VM');
    // A profile the risk policy could return would make every CRITICAL task unrunnable on
    // this host; VM is reachable only by an explicit operator override.
    expect(Object.keys(RESOURCE_PROFILES)).not.toContain('VM');
    expect(getResourceProfile('VM').isolation).toBe('vm');
  });
});

describe('capability detection — measured, never configured', () => {
  it('reports vmAvailable=false on this host and names /dev/kvm', async () => {
    const capability = await detectIsolationCapability();

    expect(capability.tier).toBe('restricted-shared-kernel');
    expect(capability.vmAvailable).toBe(false);
    // The evidence, not an adjective: the refusal must be explainable from the record.
    expect(capability.reason).toContain('/dev/kvm');
    expect(capability.reason.toLowerCase()).toContain('unavailable');
  });

  it('reports available when the injected node is readable and the CPU is flagged', async () => {
    const host = await fakeHost(['vmx']);

    const capability = await detectIsolationCapability(host);

    expect(capability.vmAvailable).toBe(true);
    expect(capability.reason).toContain(host.kvmPath);
    expect(capability.reason).toContain('vmx');
  });

  it('refuses a KVM node when the CPU exposes no virtualisation extension', async () => {
    // A device node is a necessary condition, not a sufficient one: without `vmx`/`svm`
    // the hypervisor has no hardware virtualisation to use.
    const host = await fakeHost(['fpu', 'pse']);

    const capability = await detectIsolationCapability(host);

    expect(capability.vmAvailable).toBe(false);
    expect(capability.reason).toContain('no vmx/svm flag');
  });

  it('refuses a KVM node that exists but cannot be opened read/write', async () => {
    // `existence` is the cheap false positive: a mode-000 node, or one masked by a
    // container, exists and is useless.
    if (process.getuid?.() === 0) return; // root can read anything; the assertion is vacuous.

    const host = await fakeHost(['vmx'], 0o000);
    await chmod(host.kvmPath, 0o000);

    const capability = await detectIsolationCapability(host);

    expect(capability.vmAvailable).toBe(false);
    expect(capability.reason).toContain(host.kvmPath);
    expect(capability.reason).toContain('cannot be opened');
  });

  it('ignores a model name that contains a flag name', async () => {
    const host = await fakeHost([]);

    const capability = await detectIsolationCapability(host);

    // The fixture's `model name` line contains `vmx` deliberately: only `flags:` lines
    // are capability evidence.
    expect(capability.vmAvailable).toBe(false);
  });

  it('is not forgeable by environment variables', async () => {
    const forged = [
      'WORKER_VM_AVAILABLE',
      'KVM_AVAILABLE',
      'VM_AVAILABLE',
      'ISOLATION_TIER',
      'WORKER_ISOLATION_TIER',
    ];
    const previous = forged.map((name) => [name, process.env[name]] as const);

    try {
      for (const name of forged) process.env[name] = '1';

      const capability = await detectIsolationCapability();

      // Capability comes from the filesystem. A variable that could assert it would turn
      // a missing boundary into a claimed one.
      expect(capability.vmAvailable).toBe(false);
      expect(capability.reason).toContain('/dev/kvm');
    } finally {
      for (const [name, value] of previous) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });
});

describe('tier planning — fail closed, never downgrade', () => {
  it('refuses a vm profile on a host that cannot launch one', () => {
    const plan = planIsolation(VM_PROFILE, NO_VM);

    expect(plan.required).toBe('vm');
    expect(plan.refused).toBe(true);
    // The load-bearing assertion: there is no weaker tier standing in for the missing one.
    expect(plan.effective).toBeNull();
    expect(plan.vmAvailable).toBe(false);
    expect(plan.controlsUnavailable).toEqual(expect.arrayContaining([...SHARED_KERNEL_MISSING_CONTROLS]));
    expect(plan.reason).toContain('/dev/kvm');

    // The report is the wire contract, so it must satisfy it.
    expect(ExecutionIsolation.safeParse(plan).success).toBe(true);
  });

  it('grants vm when the host can launch it, and claims nothing missing', () => {
    const plan = planIsolation(VM_PROFILE, VM_CAPABLE);

    expect(plan.required).toBe('vm');
    expect(plan.refused).toBe(false);
    expect(plan.effective).toBe('vm');
    expect(plan.controlsUnavailable).toEqual([]);
  });

  it('does not upgrade a restricted profile on a vm-capable host', () => {
    // The other direction of "no silent downgrade": a host that *can* virtualise does not
    // credit a shared-kernel profile with a boundary its launch path never used.
    const plan = planIsolation(getResourceProfile('STANDARD'), VM_CAPABLE);

    expect(plan.required).toBe('restricted-shared-kernel');
    expect(plan.effective).toBe('restricted-shared-kernel');
    expect(plan.refused).toBe(false);
    expect(plan.vmAvailable).toBe(true);
    expect(plan.controlsUnavailable).toEqual(expect.arrayContaining([...SHARED_KERNEL_MISSING_CONTROLS]));
  });

  it('reports the restricted tier honestly on this host', () => {
    const plan = planIsolation(getResourceProfile('HEAVY'), NO_VM);

    expect(plan.effective).toBe('restricted-shared-kernel');
    expect(plan.refused).toBe(false);
    // The controls it does not provide are stated, so no consumer can render "isolated"
    // from the tier name alone.
    expect(plan.controlsUnavailable).toContain('kernel-isolation');
  });

  it('writes a refusal sentence that names the tier, the profile and the measurement', () => {
    const plan = planIsolation(VM_PROFILE, NO_VM);
    const message = isolationRefusalMessage(VM_PROFILE, plan);

    expect(message).toContain('VM');
    expect(message).toContain('"vm"');
    expect(message).toContain('/dev/kvm');
    // What did not happen is part of the record: the alternative was a run that looked normal.
    expect(message).toContain('Refused before provisioning');
    expect(message).toContain('no workspace, no agent process and no broker request');
  });
});
