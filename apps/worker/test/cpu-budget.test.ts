import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { runInProcessGroup } from '@intelligenz/agent-runtime';

import {
  CgroupError,
  applyLimits,
  createCgroup,
  killCgroup,
  readCpuUsageUs,
  readUsage,
  removeCgroup,
  startCpuBudgetWatch,
  type CgroupHandle,
  type CgroupUsage,
  type CpuBudgetSample,
  type CpuBudgetWatch,
} from '../src/cgroup';
import {
  RESOURCE_PROFILES,
  checkCpuBudget,
  cpuBudgetMs,
  cpuCeilingFor,
  type ResourceProfile,
} from '../src/resource-profiles';
import { classifyTermination, statusForTermination } from '../src/termination';

import { ROOT, TIER, TIER_REASON } from './helpers/cgroup-tier';

/**
 * Gate C — the cumulative CPU budget.
 *
 * `cpu.max` is a **rate** ("half a CPU"). The budget is a **total** ("thirty CPU-seconds
 * for this attempt"). These are different controls and they must not collapse into one
 * another in the record: a run stopped by the budget is `cpu_budget`, a run stopped by
 * the clock is `timeout`, and a run that consumed more CPU than `cpu.max` mathematically
 * allows is `cpu` — the last one being evidence that the rate ceiling was *not* applied.
 *
 * The pure tests run everywhere. The kill tests need a process actually placed in an
 * attempt cgroup, which the kernel only permits when the worker itself runs inside the
 * delegated subtree (`infra/scripts/worker-with-cgroup.sh`). They are skipped with a
 * printed reason rather than mocked: a budget kill that did not happen is not evidence.
 */

const unique = (label: string): string =>
  `${label}-${String(process.pid)}-${String(Date.now() % 100_000)}`;

function limitsFor(profile: ResourceProfile): Parameters<typeof applyLimits>[1] {
  return {
    memoryMaxBytes: profile.memoryMaxBytes,
    swapMaxBytes: 0,
    pidsMax: profile.pidsMax,
    cpuQuotaMicros: profile.cpuQuotaMicros,
    cpuPeriodMicros: profile.cpuPeriodMicros,
  };
}

function usage(overrides: Partial<CgroupUsage> = {}): CgroupUsage {
  return {
    memoryPeakBytes: 1_048_576,
    pidsPeak: 3,
    cpuTimeMs: 0,
    cpuUsageUs: 0,
    oomKills: 0,
    pidsEventsMax: 0,
    nrThrottled: 0,
    throttledUs: 0,
    ...overrides,
  };
}

describe('CPU budget — arithmetic and verdicts (no cgroup needed)', () => {
  it('treats exactly the budget as within, and one microsecond past it as exhausted', () => {
    expect(checkCpuBudget(0, 30_000_000)).toBe('within');
    expect(checkCpuBudget(30_000_000, 30_000_000)).toBe('within');
    expect(checkCpuBudget(30_000_001, 30_000_000)).toBe('exhausted');
    // A zero budget disables the check rather than killing every run instantly.
    expect(checkCpuBudget(1_000_000, 0)).toBe('within');
  });

  it('states every profile budget in both units, and keeps it below the quota ceiling', () => {
    for (const profile of Object.values(RESOURCE_PROFILES)) {
      expect(cpuBudgetMs(profile)).toBe(profile.cpuBudgetUs / 1_000);
      // A budget that cannot be reached before the wall clock is a comment, not a limit.
      expect(profile.cpuBudgetUs).toBeLessThan(cpuCeilingFor(profile));
      // ...and it must be reachable well before the deadline.
      expect(profile.cpuBudgetUs).toBeLessThan(
        (profile.cpuQuotaMicros / profile.cpuPeriodMicros) * profile.wallClockMs * 1_000,
      );
    }

    expect(cpuBudgetMs(RESOURCE_PROFILES.SMALL)).toBe(30_000);
    expect(cpuBudgetMs(RESOURCE_PROFILES.STANDARD)).toBe(60_000);
    expect(cpuBudgetMs(RESOURCE_PROFILES.HEAVY)).toBe(120_000);
  });

  it('records a platform budget kill as cpu_budget, distinct from timeout and from cpu', () => {
    const profile = RESOURCE_PROFILES.SMALL;
    const base = {
      usage: usage({ cpuUsageUs: 5_000_000 }),
      cpuCeilingUs: cpuCeilingFor(profile),
      placementFailed: false,
      diskExhausted: false,
    } as const;

    // The platform killed it at a measured usage: that outranks the adapter's own report.
    const budget = classifyTermination({
      ...base,
      adapter: 'threw',
      cpuBudgetExceeded: true,
      cpuBudget: { usageUs: 30_500_000, budgetUs: profile.cpuBudgetUs },
    });

    expect(budget.reason).toBe('cpu_budget');
    expect(budget.resourceKill).toBe(true);
    expect(budget.overridesAdapter).toBe(true);
    expect(statusForTermination(budget)).toBe('failed');

    // Same tree, same exit, but it died because the clock ran out.
    expect(classifyTermination({ ...base, adapter: 'timeout' }).reason).toBe('timeout');

    // Same tree, judged by `cpu.max` alone: more CPU than the rate ceiling permits.
    expect(
      classifyTermination({
        ...base,
        adapter: 'threw',
        usage: usage({ cpuUsageUs: cpuCeilingFor(profile) + 1 }),
      }).reason,
    ).toBe('cpu');

    // The three are different strings, because an operator acts on them differently.
    expect(new Set(['cpu_budget', 'timeout', 'cpu']).size).toBe(3);
  });

  it('lets a budget kill outrank an oom kill and a refused fork recorded in the same window', () => {
    const verdict = classifyTermination({
      adapter: 'failed',
      usage: usage({ oomKills: 1, pidsEventsMax: 2 }),
      cpuCeilingUs: 0,
      placementFailed: false,
      cpuBudgetExceeded: true,
    });

    // The budget kill is the platform's own decision at a measured usage, so it is the
    // most specific fact available; an adapter that reports `failed` afterwards says
    // nothing that improves on it.
    expect(verdict.reason).toBe('cpu_budget');
  });

  it('never reports a resource kill as a success', () => {
    for (const reason of ['oom', 'pids', 'cpu', 'cpu_budget', 'disk', 'crashed'] as const) {
      const verdict = classifyTermination({
        adapter: 'succeeded',
        usage: usage({
          oomKills: reason === 'oom' ? 1 : 0,
          pidsEventsMax: reason === 'pids' ? 1 : 0,
          cpuUsageUs: reason === 'cpu' ? 1_000_000 : 0,
        }),
        cpuCeilingUs: reason === 'cpu' ? 1 : 0,
        placementFailed: reason === 'crashed',
        cpuBudgetExceeded: reason === 'cpu_budget',
        diskExhausted: reason === 'disk',
      });

      // `crashed` needs an adapter that did not succeed; the others override it.
      if (reason === 'crashed') {
        expect(
          statusForTermination(
            classifyTermination({
              adapter: 'threw',
              usage: usage(),
              cpuCeilingUs: 0,
              placementFailed: false,
            }),
          ),
        ).toBe('failed');
        continue;
      }

      expect(verdict.reason).toBe(reason);
      expect(statusForTermination(verdict)).toBe('failed');
    }
  });
});

/**
 * A cgroup directory is a directory: `cpu.stat` is the only file the budget sampler
 * reads, so a temp directory with that one file is a faithful fixture for the sampler and
 * costs no CPU. This is what lets the lifetime-vs-rate distinction be tested on a host
 * where the worker has no delegated cgroup subtree (tier `limited`), instead of skipped
 * with the real kill test.
 */
interface SyntheticCgroup {
  readonly handle: CgroupHandle;
  readonly dir: string;
  writeUsage(usageUs: number | null): Promise<void>;
  dispose(): Promise<void>;
}

async function syntheticCgroup(label: string): Promise<SyntheticCgroup> {
  const dir = await mkdtemp(join(tmpdir(), `intelligenz-cpubudget-${label}-`));

  return {
    dir,
    handle: { path: dir, id: label, root: tmpdir() },
    async writeUsage(usageUs) {
      if (usageUs === null) {
        await rm(join(dir, 'cpu.stat'), { force: true });

        return;
      }

      await writeFile(
        join(dir, 'cpu.stat'),
        `usage_usec ${String(usageUs)}\nuser_usec ${String(usageUs)}\nsystem_usec 0\n`,
        'utf8',
      );
    },
    dispose: () => rm(dir, { recursive: true, force: true }),
  };
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    timer.unref();
  });

async function firstSample(watch: CpuBudgetWatch): Promise<CpuBudgetSample> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const sample = watch.lastSample();

    if (sample !== null) return sample;

    await delay(5);
  }

  throw new Error('the sampler produced no sample within two seconds');
}

/** True when the promise settled inside the window. The losing branch is a timer, not a leak. */
async function settledWithin(promise: Promise<unknown>, ms: number): Promise<boolean> {
  return Promise.race([promise.then(() => true), delay(ms).then(() => false)]);
}

describe('CPU budget — sampler behaviour on synthetic cpu.stat (no cgroup needed)', () => {
  it('does not stop a run whose cumulative usage stays below the budget', async () => {
    const budget = RESOURCE_PROFILES.SMALL.cpuBudgetUs;
    const cgroup = await syntheticCgroup('below');
    let watch: CpuBudgetWatch | undefined;

    try {
      await cgroup.writeUsage(1_000_000);

      watch = startCpuBudgetWatch({
        handle: cgroup.handle,
        budgetUs: budget,
        intervalMs: 10,
      });

      const sample = await firstSample(watch);

      expect(sample.usageUs).toBe(1_000_000);
      expect(sample.budgetUs).toBe(budget);
      expect(sample.fraction).toBeCloseTo(1_000_000 / budget, 6);
      expect(sample.fraction).toBeLessThan(1);

      // Eight more intervals of the same value: the sampler keeps measuring, never fires.
      expect(await settledWithin(watch.exceeded, 80)).toBe(false);
      expect(watch.lastSample()?.usageUs).toBe(1_000_000);

      // The verdict for that run is the adapter's, not a resource kill.
      const verdict = classifyTermination({
        adapter: 'succeeded',
        usage: usage({ cpuUsageUs: sample.usageUs }),
        cpuCeilingUs: cpuCeilingFor(RESOURCE_PROFILES.SMALL),
        placementFailed: false,
        cpuBudgetExceeded: false,
      });

      expect(verdict.reason).toBe('completed');
      expect(verdict.resourceKill).toBe(false);
    } finally {
      watch?.stop();
      await cgroup.dispose();
    }
  });

  it('fires exactly once past the budget, and at exactly the budget it does not fire', async () => {
    const budget = RESOURCE_PROFILES.SMALL.cpuBudgetUs;
    const cgroup = await syntheticCgroup('over');
    let watch: CpuBudgetWatch | undefined;

    try {
      // Boundary first: `checkCpuBudget` documents "exactly the budget is within", and the
      // sampler uses `> budget`, so the two agree. One microsecond past is a breach.
      await cgroup.writeUsage(budget);

      const fired: CpuBudgetSample[] = [];

      watch = startCpuBudgetWatch({
        handle: cgroup.handle,
        budgetUs: budget,
        intervalMs: 10,
        onExceeded: (sample) => fired.push(sample),
      });

      const atBudget = await firstSample(watch);

      expect(atBudget.usageUs).toBe(budget);
      expect(atBudget.fraction).toBe(1);
      expect(checkCpuBudget(atBudget.usageUs, budget)).toBe('within');
      expect(await settledWithin(watch.exceeded, 60)).toBe(false);
      expect(fired).toHaveLength(0);

      // Now cross the line. The next tick must fire, once.
      await cgroup.writeUsage(budget + 1);

      const outcome = await Promise.race([
        watch.exceeded.then((sample) => ({ kind: 'fired' as const, sample })),
        delay(2_000).then(() => ({ kind: 'quiet' as const, sample: null })),
      ]);

      expect(outcome.kind).toBe('fired');
      if (outcome.kind !== 'fired') throw new Error('the budget sampler never fired');

      expect(outcome.sample.usageUs).toBe(budget + 1);
      expect(outcome.sample.fraction).toBeGreaterThan(1);
      expect(fired).toHaveLength(1);

      // It stopped itself: no further samples, no second callback. `stop()` afterwards is
      // safe and does not resurrect the timer.
      const settledSample = watch.lastSample();

      await delay(50);

      expect(fired).toHaveLength(1);
      expect(watch.lastSample()).toBe(settledSample);
      watch.stop();
      watch.stop();

      // `onExceeded` is where the activity kills the cgroup; the flag it sets is what the
      // verdict reads. The mapping is the assertion that the kill is recorded as cpu_budget.
      const verdict = classifyTermination({
        adapter: 'threw',
        usage: usage({ cpuUsageUs: outcome.sample.usageUs }),
        cpuCeilingUs: cpuCeilingFor(RESOURCE_PROFILES.SMALL),
        placementFailed: false,
        cpuBudgetExceeded: true,
        cpuBudget: { usageUs: outcome.sample.usageUs, budgetUs: budget },
        diskExhausted: false,
      });

      expect(verdict.reason).toBe('cpu_budget');
      expect(verdict.resourceKill).toBe(true);
      expect(verdict.overridesAdapter).toBe(true);
      expect(statusForTermination(verdict)).toBe('failed');
    } finally {
      watch?.stop();
      await cgroup.dispose();
    }
  });

  it('does not report a cpu.max-throttled run as a budget breach when it is under its lifetime budget', async () => {
    const budget = RESOURCE_PROFILES.SMALL.cpuBudgetUs; // 30 CPU-seconds
    // The trap: 40 seconds of *throttled* time against a 30-second budget and only 2
    // seconds of actual CPU. `throttledUs` is time spent waiting for the rate ceiling; it
    // is not CPU consumed, and a sampler that charged it would kill a healthy run.
    const throttled = usage({
      cpuUsageUs: 2_000_000,
      nrThrottled: 50_000,
      throttledUs: 40_000_000,
    });

    expect(throttled.throttledUs).toBeGreaterThan(budget);
    expect(throttled.cpuUsageUs).toBeLessThan(budget);
    expect(checkCpuBudget(throttled.cpuUsageUs, budget)).toBe('within');

    const succeeded = classifyTermination({
      adapter: 'succeeded',
      usage: throttled,
      cpuCeilingUs: cpuCeilingFor(RESOURCE_PROFILES.SMALL),
      placementFailed: false,
      cpuBudgetExceeded: false,
    });
    const threw = classifyTermination({
      adapter: 'threw',
      usage: throttled,
      cpuCeilingUs: cpuCeilingFor(RESOURCE_PROFILES.SMALL),
      placementFailed: false,
      cpuBudgetExceeded: false,
    });

    expect(succeeded.reason).toBe('completed');
    expect(threw.reason).toBe('crashed');
    // The regression this exists for: neither is the budget, and neither is the rate kill.
    for (const verdict of [succeeded, threw]) {
      expect(verdict.reason).not.toBe('cpu_budget');
      expect(verdict.reason).not.toBe('cpu');
      expect(verdict.resourceKill).toBe(false);
    }
  });

  it('keeps a wall-clock timeout distinct from a budget kill on the same usage', async () => {
    const budget = RESOURCE_PROFILES.SMALL.cpuBudgetUs;
    const underBudget = usage({ cpuUsageUs: 1_000_000 });

    // The clock ran out before the CPU did: the sampler never fired, and the record says
    // `timeout`, not `cpu_budget`.
    const timedOut = classifyTermination({
      adapter: 'timeout',
      usage: underBudget,
      cpuCeilingUs: cpuCeilingFor(RESOURCE_PROFILES.SMALL),
      placementFailed: false,
      cpuBudgetExceeded: false,
    });
    const budgetKill = classifyTermination({
      adapter: 'threw',
      usage: usage({ cpuUsageUs: budget + 1 }),
      cpuCeilingUs: cpuCeilingFor(RESOURCE_PROFILES.SMALL),
      placementFailed: false,
      cpuBudgetExceeded: true,
    });

    expect(timedOut.reason).toBe('timeout');
    expect(timedOut.resourceKill).toBe(true);
    // The adapter's own `timeout` already explains the stop; the platform does not need to
    // override it, unlike a budget kill where the adapter usually reports `threw`.
    expect(timedOut.overridesAdapter).toBe(false);

    expect(budgetKill.reason).toBe('cpu_budget');
    expect(budgetKill.overridesAdapter).toBe(true);

    expect(new Set([timedOut.reason, budgetKill.reason]).size).toBe(2);
    expect(statusForTermination(timedOut)).toBe('timed_out');
    expect(statusForTermination(budgetKill)).toBe('failed');
  });

  it('catches a budget reached between polls with the final counter read', async () => {
    const budget = RESOURCE_PROFILES.SMALL.cpuBudgetUs;
    const cgroup = await syntheticCgroup('between');
    let watch: CpuBudgetWatch | undefined;

    try {
      await cgroup.writeUsage(1_000_000);

      // A deliberately long interval: the sampler sees the run once and would not look
      // again before the attempt ends. That is the "between polls" window in slow motion.
      watch = startCpuBudgetWatch({
        handle: cgroup.handle,
        budgetUs: budget,
        intervalMs: 60_000,
      });

      const sample = await firstSample(watch);

      expect(sample.fraction).toBeLessThan(1);
      watch.stop();

      // The tree burned the rest of its budget after the last sample.
      await cgroup.writeUsage(budget + 5_000_000);

      const finalUsage = await readCpuUsageUs(cgroup.handle);

      expect(finalUsage).not.toBeNull();
      if (finalUsage === null) throw new Error('expected a final usage measurement');

      // The sampler alone would have recorded "within"; the counter is the authority. This
      // is the exact branch in `execute-agent.ts` that runs after the adapter returns.
      expect(watch.lastSample()?.fraction).toBeLessThan(1);
      expect(checkCpuBudget(finalUsage, budget)).toBe('exhausted');

      const verdict = classifyTermination({
        adapter: 'succeeded',
        usage: usage({ cpuUsageUs: finalUsage }),
        cpuCeilingUs: cpuCeilingFor(RESOURCE_PROFILES.SMALL),
        placementFailed: false,
        cpuBudgetExceeded: checkCpuBudget(finalUsage, budget) === 'exhausted',
      });

      expect(verdict.reason).toBe('cpu_budget');
    } finally {
      watch?.stop();
      await cgroup.dispose();
    }
  });

  it('treats a missing cpu.stat as unknown usage and never as a breach', async () => {
    const cgroup = await syntheticCgroup('missing');
    let watch: CpuBudgetWatch | undefined;

    try {
      // Nothing was written: the file does not exist.
      await expect(readCpuUsageUs(cgroup.handle)).resolves.toBeNull();

      watch = startCpuBudgetWatch({
        handle: cgroup.handle,
        budgetUs: RESOURCE_PROFILES.SMALL.cpuBudgetUs,
        intervalMs: 10,
      });

      await delay(60);

      expect(watch.lastSample()).toBeNull();
      expect(await settledWithin(watch.exceeded, 60)).toBe(false);

      // The verdict has no CPU measurement, so it cannot invent one. The adapter's own
      // status stands and no resource kill is recorded.
      const verdict = classifyTermination({
        adapter: 'succeeded',
        usage: null,
        cpuCeilingUs: cpuCeilingFor(RESOURCE_PROFILES.SMALL),
        placementFailed: false,
        cpuBudgetExceeded: false,
      });

      expect(verdict.reason).toBe('completed');
      expect(verdict.reason).not.toBe('cpu_budget');
      expect(verdict.reason).not.toBe('cpu');
    } finally {
      watch?.stop();
      await cgroup.dispose();
    }
  });

  it('stops the sampler on an unreadable cpu.stat instead of killing the run', async () => {
    const cgroup = await syntheticCgroup('unreadable');
    let watch: CpuBudgetWatch | undefined;

    try {
      // A directory where the counter should be: reading it is EISDIR, not ENOENT, so the
      // reader reports a named failure rather than a fabricated zero.
      await mkdir(join(cgroup.dir, 'cpu.stat'));

      const failure: unknown = await readCpuUsageUs(cgroup.handle).then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(CgroupError);
      expect((failure as CgroupError).code).toBe('CGROUP_READ_FAILED');
      expect((failure as CgroupError).message).toContain('cpu.stat');

      watch = startCpuBudgetWatch({
        handle: cgroup.handle,
        budgetUs: RESOURCE_PROFILES.SMALL.cpuBudgetUs,
        intervalMs: 10,
      });

      await delay(60);

      // The watcher's `.catch` stops it. No sample, no kill: a read failure is not
      // evidence that the run overspent.
      expect(watch.lastSample()).toBeNull();
      expect(await settledWithin(watch.exceeded, 60)).toBe(false);
    } finally {
      watch?.stop();
      await cgroup.dispose();
    }
  });

  it('reads the cgroup-wide usage_usec verbatim, without adjusting for descendants', async () => {
    // cgroup v2 `cpu.stat` is hierarchical: `usage_usec` on a cgroup includes the CPU of
    // every descendant. The reader returns that number unchanged — it does not walk the
    // child cgroups or subtract them — which is what makes a budget on the attempt's
    // cgroup cover the whole process tree. This fixture proves the reader does not alter
    // the value; the kernel-side proof is the tier-gated test below.
    const cgroup = await syntheticCgroup('subtree');

    try {
      await cgroup.writeUsage(42_000_001);
      await expect(readCpuUsageUs(cgroup.handle)).resolves.toBe(42_000_001);

      // A value that only makes sense as a subtree total is still returned as-is.
      await cgroup.writeUsage(7_000_000_000);
      await expect(readCpuUsageUs(cgroup.handle)).resolves.toBe(7_000_000_000);
    } finally {
      await cgroup.dispose();
    }
  });
});

describe.skipIf(TIER !== 'full')('CPU budget — descendant accounting in a real subtree', () => {
  it('counts a process in a child cgroup against the parent’s usage_usec', async () => {
    const parent = await createCgroup(ROOT, unique('cpu-desc-parent'));
    const child = await createCgroup(parent.path, unique('cpu-desc-child'));

    try {
      const before = (await readCpuUsageUs(parent)) ?? 0;

      const outcome = await runInProcessGroup({
        // Bounded work: a few hundred milliseconds on a delegated subtree, never the host.
        file: '/bin/sh',
        args: ['-c', 'i=0; while [ $i -lt 200000 ]; do i=$((i+1)); done'],
        timeoutMs: 10_000,
        signal: new AbortController().signal,
        killGraceMs: 500,
        placement: { cgroupProcsPath: `${child.path}/cgroup.procs` },
        onStdout: () => undefined,
      });

      expect(outcome.exitCode).toBe(0);

      const childUsage = await readCpuUsageUs(child);
      const parentUsage = await readCpuUsageUs(parent);

      expect(childUsage).not.toBeNull();
      expect(childUsage ?? 0).toBeGreaterThan(0);
      expect(parentUsage).not.toBeNull();

      // The parent has no processes of its own; the delta is the child's CPU, counted
      // because `cpu.stat` is subtree-wide.
      expect((parentUsage ?? 0) - before).toBeGreaterThanOrEqual(childUsage ?? 0);
      expect((parentUsage ?? 0) - before).toBeGreaterThan(0);
    } finally {
      await removeCgroup(child, { attempts: 5, delayMs: 20 }).catch(() => undefined);
      await removeCgroup(parent, { attempts: 5, delayMs: 20 }).catch(() => undefined);
    }
  }, 30_000);
});

describe.skipIf(TIER !== 'full')('CPU budget — enforced against a real cgroup', () => {
  it('kills a busy loop at the profile budget, records cpu_budget, and persists usage_usec', async () => {
    const profile = RESOURCE_PROFILES.SMALL;
    const handle = await createCgroup(ROOT, unique('cpu-budget'));

    await applyLimits(handle, limitsFor(profile));

    const watch = startCpuBudgetWatch({
      handle: handle,
      budgetUs: profile.cpuBudgetUs,
      intervalMs: 100,
    });

    const startedAt = Date.now();
    const executed = runInProcessGroup({
      // A pure CPU loop: no I/O, no sleeps, no output. It can only stop by being killed.
      file: '/bin/sh',
      args: ['-c', 'while :; do :; done'],
      timeoutMs: profile.wallClockMs,
      signal: new AbortController().signal,
      killGraceMs: 500,
      placement: { cgroupProcsPath: `${handle.path}/cgroup.procs` },
      onStdout: () => undefined,
    });

    try {
      // The sampler observes `cpu.stat usage_usec`; past the budget it kills the cgroup,
      // exactly as the activity does in its `onExceeded` callback.
      const sample = await watch.exceeded;

      await killCgroup(handle);
      const outcome = await executed;
      const elapsedMs = Date.now() - startedAt;

      expect(sample.usageUs).toBeGreaterThan(profile.cpuBudgetUs);
      expect(sample.budgetUs).toBe(profile.cpuBudgetUs);
      expect(sample.fraction).toBeGreaterThan(1);

      // Literal numbers for the attempt log: a kill without a measurement is not evidence.
      process.stdout.write(
        `[cpu budget] budget_us=${String(profile.cpuBudgetUs)} sampled_us=${String(sample.usageUs)} ` +
          `fraction=${sample.fraction.toFixed(3)} elapsed_ms=${String(Date.now() - startedAt)}\n`,
      );

      // The tree is gone and it did not exit on its own.
      expect(outcome.exitCode).not.toBe(0);

      // The persisted number is a measurement read back from the kernel, not the sample.
      const used = await readUsage(handle);

      expect(used.cpuUsageUs).toBeGreaterThan(profile.cpuBudgetUs);
      expect(used.cpuTimeMs).toBe(Math.round(used.cpuUsageUs / 1_000));
      expect(used.cpuUsageUs).toBeLessThan(cpuCeilingFor(profile));

      process.stdout.write(
        `[cpu budget] persisted usage_usec=${String(used.cpuUsageUs)} cpu_time_ms=${String(used.cpuTimeMs)} ` +
          `ceiling_us=${String(cpuCeilingFor(profile))} exit=${String(outcome.exitCode)}\n`,
      );

      // It was the CPU budget that stopped the run, not the wall clock: with a 0.5-CPU
      // quota the 30 CPU-second budget is reached at roughly 60 seconds, well inside the
      // 120-second deadline. Asserting the margin is what makes "not a timeout" a
      // measurement rather than a label.
      expect(elapsedMs).toBeLessThan(profile.wallClockMs);

      const verdict = classifyTermination({
        adapter: 'threw',
        usage: used,
        cpuCeilingUs: cpuCeilingFor(profile),
        placementFailed: false,
        cpuBudgetExceeded: true,
        cpuBudget: { usageUs: used.cpuUsageUs, budgetUs: profile.cpuBudgetUs },
        diskExhausted: false,
      });

      expect(verdict.reason).toBe('cpu_budget');
      expect(statusForTermination(verdict)).toBe('failed');

      // The same measured usage, classified as the other two controls would:
      expect(
        classifyTermination({
          adapter: 'timeout',
          usage: used,
          cpuCeilingUs: cpuCeilingFor(profile),
          placementFailed: false,
        }).reason,
      ).toBe('timeout');

      expect(
        classifyTermination({
          adapter: 'threw',
          usage: { ...used, cpuUsageUs: cpuCeilingFor(profile) + 1 },
          cpuCeilingUs: cpuCeilingFor(profile),
          placementFailed: false,
        }).reason,
      ).toBe('cpu');
    } finally {
      watch.stop();
      await removeCgroup(handle);
    }
  }, 150_000);

  it('does not stop a run that stays inside the budget', async () => {
    const profile = RESOURCE_PROFILES.SMALL;
    const handle = await createCgroup(ROOT, unique('cpu-under'));

    await applyLimits(handle, limitsFor(profile));

    const watch = startCpuBudgetWatch({
      handle: handle,
      budgetUs: profile.cpuBudgetUs,
      intervalMs: 50,
    });

    try {
      const outcome = await runInProcessGroup({
        file: '/bin/sh',
        args: ['-c', 'i=0; while [ $i -lt 20000 ]; do i=$((i+1)); done'],
        timeoutMs: 20_000,
        signal: new AbortController().signal,
        killGraceMs: 500,
        placement: { cgroupProcsPath: `${handle.path}/cgroup.procs` },
        onStdout: () => undefined,
      });

      expect(outcome.exitCode).toBe(0);

      // The sampler was running for the whole attempt and never fired.
      const raced = await Promise.race<string>([
        watch.exceeded.then((): string => 'fired'),
        new Promise<string>((resolvePromise) => {
          const timer = setTimeout(() => resolvePromise('quiet'), 600);
          timer.unref();
        }),
      ]);

      expect(raced).toBe('quiet');

      const used = await readUsage(handle);

      // Real CPU was consumed — otherwise "under budget" would be vacuous.
      expect(used.cpuUsageUs).toBeGreaterThan(0);
      expect(used.cpuUsageUs).toBeLessThan(profile.cpuBudgetUs);
      expect(checkCpuBudget(used.cpuUsageUs, profile.cpuBudgetUs)).toBe('within');

      const verdict = classifyTermination({
        adapter: 'succeeded',
        usage: used,
        cpuCeilingUs: cpuCeilingFor(profile),
        placementFailed: false,
        cpuBudgetExceeded: false,
        diskExhausted: false,
      });

      expect(verdict.reason).toBe('completed');
      expect(statusForTermination(verdict)).toBe('succeeded');
    } finally {
      watch.stop();
      await removeCgroup(handle);
    }
  }, 60_000);
});

if (TIER !== 'full') {
  process.stdout.write(
    `\n[cpu budget] kill tests skipped — cgroup tier is "${TIER}"\n${TIER_REASON}\n` +
      'Run: sudo bash infra/scripts/worker-with-cgroup.sh pnpm --filter @intelligenz/worker test\n',
  );
}
