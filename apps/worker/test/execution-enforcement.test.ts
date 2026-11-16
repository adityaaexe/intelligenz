import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { CgroupCapability } from '../src/capabilities';
import { SETUP_REMEDIATION } from '../src/capabilities';
import {
  EXECUTION_ENFORCEMENT_UNAVAILABLE,
  ExecutionEnforcementError,
  assessExecutionEnforcement,
  assertExecutionEnforcement,
  describeExecutionEnforcement,
  isCgroupPathUnder,
  parseCgroup2Mounts,
  parseCgroupProc,
  parseControllerList,
  parseLimitValue,
  resolveRelativeRoot,
} from '../src/execution-enforcement';
import { loadWorkerConfig } from '../src/config';
import { ROOT, TIER } from './helpers/cgroup-tier';

/**
 * The boot gate: does this process execute tasks at all?
 *
 * The defect it closes was not "the probe is wrong" — the probe was right, and it printed
 * `UNAVAILABLE [CGROUP_MIGRATION_DENIED]` at every `pnpm dev` boot. The defect was that
 * the worker logged it and then registered with Temporal anyway, so every task ran with
 * rlimit-only enforcement while every test passed. The tests below are therefore mostly
 * **refusals**: a gate that is only tested on the accepting path is the same shape as the
 * warning it replaced.
 *
 * Both dimensions, because either alone is a weak test:
 *
 *   1. unit — the parsers and the segment comparison, against fixtures that encode the
 *      cases that matter (`/intelligenz-evil`, hybrid hierarchies, `pids.max` = `0`);
 *   2. composition — `assessExecutionEnforcement` with injected `/proc` text, a fixture
 *      root and a stub capability, so every refusal is reachable without owning a broken
 *      cgroup. The one test that runs against the real host asserts whichever verdict the
 *      host actually justifies, using the same tier the cgroup suites use.
 */

const MOUNTINFO = [
  '36 31 0:30 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:8 - cgroup2 cgroup2 rw,nsdelegate',
  '28 1 0:26 / /proc rw,nosuid,nodev,noexec,relatime shared:12 - proc proc rw',
].join('\n');

const UNIFIED_OUTSIDE = '0::/user.slice/user-1000.slice/session-4.scope\n';
const UNIFIED_INSIDE = '0::/intelligenz/worker\n';

/** The files a healthy delegation root exposes, as the gate reads them. */
const HEALTHY_FILES: Readonly<Record<string, string>> = {
  [`${ROOT}/cgroup.controllers`]: 'cpu io memory pids\n',
  [`${ROOT}/cgroup.subtree_control`]: 'cpu io memory pids\n',
  [`${ROOT}/memory.max`]: 'max\n',
  [`${ROOT}/pids.max`]: 'max\n',
};

function readerFor(files: Readonly<Record<string, string>>) {
  return async (path: string): Promise<string> => {
    const value = files[path];
    if (value === undefined) {
      const error = Object.assign(new Error(`ENOENT: no such file or directory, open '${path}'`), {
        code: 'ENOENT',
      });
      throw error;
    }
    return value;
  };
}

function enforcedCapability(selfCgroup = '/intelligenz/worker'): CgroupCapability {
  return {
    mode: 'enforced',
    root: ROOT,
    evidence: {
      memoryMax: '67108864',
      pidsMax: '16',
      cpuMax: '10000 100000',
      cpuUsageUs: 1234,
      selfCgroup,
    },
  };
}

const unavailableCapability: CgroupCapability = {
  mode: 'unavailable',
  root: ROOT,
  code: 'CGROUP_MIGRATION_DENIED',
  reason:
    'Cannot move pid 4242 into /sys/fs/cgroup/intelligenz/probe-1: EACCES. This process runs ' +
    'in /user.slice/session-4.scope, which is outside the delegated subtree.',
  remediation: SETUP_REMEDIATION,
};

const assess = async (
  overrides: {
    readonly proc?: string;
    readonly capability?: CgroupCapability;
    readonly files?: Readonly<Record<string, string>>;
  } = {},
) =>
  assessExecutionEnforcement({
    root: ROOT,
    procCgroupText: overrides.proc ?? UNIFIED_INSIDE,
    mountInfoText: MOUNTINFO,
    capability: overrides.capability ?? enforcedCapability(),
    readText: readerFor(overrides.files ?? HEALTHY_FILES),
  });

describe('/proc/self/cgroup parsing', () => {
  it('accepts the single unified line and keeps the whole path', () => {
    expect(parseCgroupProc('0::/intelligenz/worker\n')).toMatchObject({
      unified: true,
      path: '/intelligenz/worker',
    });

    // The root of the hierarchy is `/`, not the empty string.
    expect(parseCgroupProc('0::/\n')).toMatchObject({ unified: true, path: '/' });
  });

  it('refuses a cgroup v1 hierarchy, where the limit files do not exist', () => {
    const state = parseCgroupProc('12:cpu,cpuacct:/docker/abc\n11:memory:/docker/abc\n');

    expect(state.unified).toBe(false);
    expect(state.path).toBeNull();
    expect(state.detail).toContain("found 0 of 2");
  });

  it('refuses a hybrid hierarchy, where memory and pids may be mounted on v1', () => {
    // Accepting the `0::` line here would be the same false positive as accepting a plain
    // directory: the v2 files would be present, writable, read back correctly, and bound
    // nothing that the v1 controllers are actually enforcing.
    const state = parseCgroupProc('0::/intelligenz/worker\n4:memory:/intelligenz/worker\n');

    expect(state.unified).toBe(false);
    expect(state.detail).toContain('hybrid');
  });

  it('refuses an empty file and a relative path', () => {
    expect(parseCgroupProc('').unified).toBe(false);
    expect(parseCgroupProc('0::intelligenz/worker\n').unified).toBe(false);
  });
});

describe('path containment is compared by segment, not by prefix', () => {
  it('accepts the delegated leaf and anything below it', () => {
    expect(isCgroupPathUnder('/intelligenz/worker', '/intelligenz')).toBe(true);
    expect(isCgroupPathUnder('/intelligenz/worker/a/b', '/intelligenz')).toBe(true);
    expect(isCgroupPathUnder('/intelligenz', '/intelligenz')).toBe(true);
    expect(isCgroupPathUnder('//intelligenz//worker/', '/intelligenz/')).toBe(true);
  });

  it('refuses a sibling that shares a prefix — the case a startsWith check misses', () => {
    // `/intelligenz-evil` starts with `/intelligenz` as a string and is not a child of it.
    // A worker placed there would run with no delegation in effect while a prefix check
    // reported success.
    expect(isCgroupPathUnder('/intelligenz-evil', '/intelligenz')).toBe(false);
    expect(isCgroupPathUnder('/intelligenz2/worker', '/intelligenz')).toBe(false);
    expect(isCgroupPathUnder('/intelligenza', '/intelligenz')).toBe(false);
  });

  it('refuses a login-session scope, which is the deployment mistake this gate is for', () => {
    expect(
      isCgroupPathUnder(
        '/user.slice/user-1000.slice/user@1000.service/tmux-spawn-1.scope',
        '/intelligenz',
      ),
    ).toBe(false);
  });
});

describe('mountinfo translation', () => {
  it('finds the cgroup2 mount and ignores every other filesystem', () => {
    const mounts = parseCgroup2Mounts(MOUNTINFO);

    expect(mounts).toEqual([{ mountPoint: '/sys/fs/cgroup', mountRoot: '/' }]);
  });

  it('expresses the configured root the way /proc/self/cgroup does', () => {
    // `/proc/self/cgroup` is mount-relative: the filesystem path
    // /sys/fs/cgroup/intelligenz is `/intelligenz` there. Comparing the two namespaces
    // directly would fail for every correct deployment.
    expect(resolveRelativeRoot(ROOT, parseCgroup2Mounts(MOUNTINFO))).toEqual({
      mountPoint: '/sys/fs/cgroup',
      relativeRoot: '/intelligenz',
    });
  });

  it('returns undefined for a root that is not on a cgroup2 mount', () => {
    const mounts = parseCgroup2Mounts(MOUNTINFO);

    expect(resolveRelativeRoot('/var/lib/intelligenz/cgroups', mounts)).toBeUndefined();
  });

  it('prefers the innermost mount when a cgroup2 hierarchy is mounted twice', () => {
    const mounts = parseCgroup2Mounts(
      [
        '36 31 0:30 / /sys/fs/cgroup rw - cgroup2 cgroup2 rw',
        '40 36 0:31 / /sys/fs/cgroup/intelligenz/nested rw - cgroup2 cgroup2 rw',
      ].join('\n'),
    );

    expect(
      resolveRelativeRoot(`${ROOT}/nested/leaf`, mounts)?.mountPoint,
      'the nested mount is a different hierarchy; the innermost one owns the path',
    ).toBe(`${ROOT}/nested`);
  });
});

describe('controller and limit files', () => {
  it('parses both the read-back form and the write form of a controller list', () => {
    expect([...parseControllerList('cpu io memory pids\n')]).toEqual(['cpu', 'io', 'memory', 'pids']);
    expect([...parseControllerList('+cpu +memory +pids')]).toEqual(['cpu', 'memory', 'pids']);
    expect(parseControllerList('').size).toBe(0);
  });

  it('accepts "max" and a positive count, and refuses everything else', () => {
    expect(parseLimitValue('memory.max', 'max')).toEqual({ ok: true, value: 'max' });
    expect(parseLimitValue('pids.max', '512\n')).toEqual({ ok: true, value: '512' });

    for (const raw of ['', '0', '-1', 'unlimited', '18446744073709551616x']) {
      const parsed = parseLimitValue('pids.max', raw);
      expect(parsed.ok, `${JSON.stringify(raw)} must not be read as a limit`).toBe(false);
    }
  });
});

describe('the assessment refuses a process it cannot vouch for', () => {
  it('verifies a worker inside the delegated leaf with an enforced probe', async () => {
    const assessment = await assess();

    expect(assessment.mode).toBe('verified');
    if (assessment.mode !== 'verified') return;

    expect(assessment.actualCgroup).toBe('/intelligenz/worker');
    expect(assessment.expectedCgroupPath).toBe('/intelligenz');
    expect(assessment.limits['pids.max']).toBe('max');
    expect(describeExecutionEnforcement(assessment)).toContain('VERIFIED');
  });

  it('refuses a worker started from a login session — the `pnpm dev` case', async () => {
    const assessment = await assess({
      proc: UNIFIED_OUTSIDE,
      capability: unavailableCapability,
    });

    expect(assessment.mode).toBe('refused');
    if (assessment.mode !== 'refused') return;

    const checks = assessment.failures.map((failure) => failure.check);

    // Both dimensions fail, and both are named: the placement check is the one an operator
    // can act on, the mode check is the one that certifies enforcement is absent.
    expect(checks).toContain('CGROUP_PATH_UNDER_ROOT');
    expect(checks).toContain('CGROUP_MODE_ENFORCED');

    const placement = assessment.failures.find(
      (failure) => failure.check === 'CGROUP_PATH_UNDER_ROOT',
    );
    expect(placement?.detail).toContain('/user.slice/user-1000.slice/session-4.scope');
    expect(placement?.detail).toContain('/intelligenz');
    expect(assessment.actualCgroup).toBe('/user.slice/user-1000.slice/session-4.scope');
    expect(assessment.expectedCgroupPath).toBe('/intelligenz');
    expect(assessment.remediation).toContain('worker-with-cgroup.sh');
  });

  it('refuses /intelligenz-evil even when the probe claims enforcement', async () => {
    // A sibling whose name shares the prefix. The probe is stubbed healthy and its own
    // evidence records the same path, so nothing here depends on the probe being wrong:
    // the segment comparison is what refuses, and a `startsWith` would pass.
    const assessment = await assess({
      proc: '0::/intelligenz-evil/worker\n',
      capability: enforcedCapability('/intelligenz-evil/worker'),
    });

    expect(assessment.mode).toBe('refused');
    if (assessment.mode !== 'refused') return;

    const placement = assessment.failures.find(
      (failure) => failure.check === 'CGROUP_PATH_UNDER_ROOT',
    );

    expect(placement?.detail).toContain('/intelligenz-evil/worker');
    expect(placement?.detail).toContain('does not count as a child');
    // The probe's evidence is outside the root too, so the mode check refuses alongside
    // it. Both are true statements about this process; neither replaces the other.
    expect(assessment.failures.map((failure) => failure.check)).toContain(
      'CGROUP_MODE_ENFORCED',
    );
  });

  it('refuses a hybrid hierarchy before it checks anything else', async () => {
    const assessment = await assess({
      proc: '0::/intelligenz/worker\n4:memory:/intelligenz/worker\n',
    });

    expect(assessment.mode).toBe('refused');
    if (assessment.mode !== 'refused') return;

    expect(assessment.failures.map((failure) => failure.check)).toContain('CGROUP_V2_UNIFIED');
    // The path check could not run without a unified path, so it is not reported as a
    // second, unrelated failure.
    expect(assessment.expectedCgroupPath).toBe('unresolved');
  });

  it('refuses when a controller is not delegated to children', async () => {
    const assessment = await assess({
      files: {
        ...HEALTHY_FILES,
        [`${ROOT}/cgroup.subtree_control`]: 'cpu memory\n',
      },
    });

    expect(assessment.mode).toBe('refused');
    if (assessment.mode !== 'refused') return;

    const failure = assessment.failures.find(
      (candidate) => candidate.check === 'CGROUP_CONTROLLERS_DELEGATED',
    );
    expect(failure?.detail).toContain('does not delegate pids');
  });

  it('refuses when pids.max exists but reads as a non-limit', async () => {
    const assessment = await assess({
      files: { ...HEALTHY_FILES, [`${ROOT}/pids.max`]: '0\n' },
    });

    expect(assessment.mode).toBe('refused');
    if (assessment.mode !== 'refused') return;

    const failure = assessment.failures.find(
      (candidate) => candidate.check === 'CGROUP_CONTROL_FILES_SANE',
    );
    expect(failure?.detail).toContain('non-positive');
  });

  it('refuses when a required control file does not exist at all', async () => {
    const files = { ...HEALTHY_FILES };
    delete (files as Record<string, string>)[`${ROOT}/memory.max`];

    const assessment = await assess({ files });

    expect(assessment.mode).toBe('refused');
    if (assessment.mode !== 'refused') return;

    const failure = assessment.failures.find(
      (candidate) => candidate.check === 'CGROUP_CONTROL_FILES_SANE',
    );
    expect(failure?.detail).toContain('ENOENT');
  });

  it('refuses when the probe contradicts its own placement evidence', async () => {
    // Enforced capability whose recorded self cgroup is elsewhere: one of the two
    // measurements is stale, and neither is a state to execute under.
    const assessment = await assess({ capability: enforcedCapability('/elsewhere/worker') });

    expect(assessment.mode).toBe('refused');
    if (assessment.mode !== 'refused') return;

    const failure = assessment.failures.find(
      (candidate) => candidate.check === 'CGROUP_MODE_ENFORCED',
    );
    expect(failure?.detail).toContain('disagree');
  });
});

describe('the typed refusal', () => {
  it('throws a distinct code and carries the measured diagnostic', async () => {
    const attempt = assertExecutionEnforcement({
      root: ROOT,
      procCgroupText: UNIFIED_OUTSIDE,
      mountInfoText: MOUNTINFO,
      capability: unavailableCapability,
      readText: readerFor(HEALTHY_FILES),
    });

    await expect(attempt).rejects.toBeInstanceOf(ExecutionEnforcementError);

    let captured: unknown;
    await attempt.catch((caught: unknown) => {
      captured = caught;
      return undefined;
    });

    expect(captured).toBeInstanceOf(ExecutionEnforcementError);
    const error = captured as ExecutionEnforcementError;

    expect(error.code).toBe(EXECUTION_ENFORCEMENT_UNAVAILABLE);
    expect(error.message).toContain('CGROUP_PATH_UNDER_ROOT');

    const diagnostic = error.toDiagnostic();

    expect(diagnostic['code']).toBe('EXECUTION_ENFORCEMENT_UNAVAILABLE');
    expect(diagnostic['actualCgroup']).toBe('/user.slice/user-1000.slice/session-4.scope');
    expect(diagnostic['expectedCgroupPath']).toBe('/intelligenz');
    expect(diagnostic['cgroupRoot']).toBe(ROOT);
    expect(String(diagnostic['remediation'])).toContain('setup-cgroups.sh');
    expect(diagnostic['failingChecks']).toEqual(
      expect.arrayContaining(['CGROUP_PATH_UNDER_ROOT', 'CGROUP_MODE_ENFORCED']),
    );
  });

  it('resolves with the verified assessment rather than throwing', async () => {
    const verified = await assertExecutionEnforcement({
      root: ROOT,
      procCgroupText: UNIFIED_INSIDE,
      mountInfoText: MOUNTINFO,
      capability: enforcedCapability(),
      readText: readerFor(HEALTHY_FILES),
    });

    expect(verified.mode).toBe('verified');
  });
});

describe('the gate is wired before Temporal, not after', () => {
  it('asserts enforcement before the connection is opened or a worker is created', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');

    const positions = {
      probe: source.indexOf('await getCgroupCapability('),
      gate: source.indexOf('await assertExecutionEnforcement('),
      connect: source.indexOf('NativeConnection.connect('),
      create: source.indexOf('await Worker.create('),
      run: source.indexOf('await worker.run()'),
    };

    // A rename would make an index `-1` and silently satisfy every `<` below.
    for (const [name, position] of Object.entries(positions)) {
      expect(position, `${name} must exist in main.ts`).toBeGreaterThan(-1);
    }

    expect(positions.gate).toBeGreaterThan(positions.probe);
    expect(positions.gate).toBeLessThan(positions.connect);
    expect(positions.gate).toBeLessThan(positions.create);
    expect(positions.gate).toBeLessThan(positions.run);

    // Exactly one gate and one connection: a second call site would be a second place to
    // forget, and the ordering assertion above would say nothing about it.
    expect(source.match(/assertExecutionEnforcement\(/g) ?? []).toHaveLength(1);
    expect(source.match(/NativeConnection\.connect\(/g) ?? []).toHaveLength(1);
  });

  it('exits non-zero on refusal instead of continuing', async () => {
    const source = await readFile(fileURLToPath(new URL('../src/main.ts', import.meta.url)), 'utf8');
    const gate = source.slice(
      source.indexOf('} else {\n    try {\n      const enforcement'),
      source.indexOf('const runtime = getAgentRuntime(config);'),
    );

    expect(gate).toContain('process.exitCode = 1');
    // The refusal path must leave `main` before the connection is reached: `return` inside
    // the catch is what makes "unavailable for dispatch" true rather than aspirational.
    expect(gate).toMatch(/process\.exitCode = 1;\s*return;/);
  });
});

describe('the opt-out is documented, configurable and off by default', () => {
  const base = { DATABASE_URL: 'postgresql://user:pass@localhost:5432/db' } as const;

  it('defaults to off', () => {
    expect(loadWorkerConfig({ ...base }).resources.allowUnenforcedExecution).toBe(false);
  });

  it('can be turned on explicitly', () => {
    expect(
      loadWorkerConfig({ ...base, WORKER_ALLOW_UNENFORCED_EXECUTION: 'true' }).resources
        .allowUnenforcedExecution,
    ).toBe(true);
  });

  it('refuses a value that is neither true nor false', () => {
    expect(() =>
      loadWorkerConfig({ ...base, WORKER_ALLOW_UNENFORCED_EXECUTION: 'sometimes' }),
    ).toThrow(/must be a boolean/);
  });
});

describe('the real host, judged against its own state', () => {
  it('matches the tier the cgroup suites measured', async () => {
    // No seam here: this reads /proc and the real root. `TIER` is the same measured fact
    // the cgroup suites use, so the gate and the suites cannot disagree about this host.
    const assessment = await assessExecutionEnforcement({ root: ROOT });
    const capability = await import('../src/capabilities').then((module) =>
      module.getCgroupCapability({ root: ROOT }),
    );

    if (TIER === 'full') {
      expect(capability.mode).toBe('enforced');
      expect(assessment.mode).toBe('verified');
      if (assessment.mode !== 'verified') return;

      // The launcher puts the worker in `${ROOT}/worker`; /proc reports it mount-relative.
      expect(assessment.actualCgroup).toBe('/intelligenz/worker');
      expect(capability.mode === 'enforced' && capability.evidence.selfCgroup).toBe(
        '/intelligenz/worker',
      );
    } else {
      // Outside the subtree — a tmux scope, a plain `pnpm dev`, a CI container — every
      // task would run with rlimit-only enforcement, so the gate must refuse.
      expect(assessment.mode).toBe('refused');
      if (assessment.mode !== 'refused') return;

      expect(assessment.failures.map((failure) => failure.check)).toContain(
        'CGROUP_PATH_UNDER_ROOT',
      );
      expect(describeExecutionEnforcement(assessment)).toContain('UNAVAILABLE');
    }
  }, 30_000);
});
