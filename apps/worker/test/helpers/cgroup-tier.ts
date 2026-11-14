import { applyLimits, createCgroup, removeCgroup } from '../../src/cgroup';
import { selfCgroupPath } from '../../src/capabilities';

/**
 * One probe of the host's cgroup capability, shared by every suite that needs it.
 *
 * The tier is a measured fact, not configuration:
 *
 *   unavailable  no delegated subtree — limits cannot be written at all
 *   limited      limits can be written, but this process is outside the subtree so the
 *                kernel refuses to migrate a child into it
 *   full         this process runs inside the subtree (started via
 *                `infra/scripts/worker-with-cgroup.sh`), so placement works
 *
 * Sharing one probe means a suite cannot accidentally report a different tier than the
 * one the worker would compute at boot.
 */

export const ROOT = process.env['WORKER_CGROUP_ROOT'] ?? '/sys/fs/cgroup/intelligenz';

export type Tier = 'unavailable' | 'limited' | 'full';

async function detect(): Promise<{ tier: Tier; self: string; reason: string }> {
  const self = await selfCgroupPath();
  const id = `tier-probe-${String(process.pid)}`;

  let writable = false;

  try {
    const handle = await createCgroup(ROOT, id);
    writable = true;

    try {
      await applyLimits(handle, {
        memoryMaxBytes: 16 * 1024 * 1024,
        swapMaxBytes: 0,
        pidsMax: 8,
        cpuQuotaMicros: 10_000,
        cpuPeriodMicros: 100_000,
      });
    } finally {
      await removeCgroup(handle, { attempts: 5, delayMs: 10 });
    }
  } catch (error) {
    return {
      tier: 'unavailable',
      self,
      reason: `cannot create or configure a cgroup under ${ROOT}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!writable) {
    return { tier: 'unavailable', self, reason: `${ROOT} is not writable` };
  }

  const inside = self === '/intelligenz' || self.startsWith('/intelligenz/');

  return {
    tier: inside ? 'full' : 'limited',
    self,
    reason: inside
      ? 'running inside the delegated subtree'
      : `this process is in cgroup ${self}, outside ${ROOT}; the kernel refuses migration. ` +
        'Run via: sudo bash infra/scripts/worker-with-cgroup.sh',
  };
}

const detected = await detect();

export const TIER: Tier = detected.tier;
export const SELF_CGROUP: string = detected.self;
export const TIER_REASON: string = detected.reason;

if (TIER !== 'full') {
  process.stdout.write(`\n[cgroup tier] ${TIER} — self=${SELF_CGROUP}\n${TIER_REASON}\n`);
}
