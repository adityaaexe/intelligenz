/**
 * Print the execution-enforcement verdict for **this process**.
 *
 *   npx tsx infra/scripts/execution-enforcement-probe.ts
 *   sudo bash infra/scripts/worker-with-cgroup.sh npx tsx infra/scripts/execution-enforcement-probe.ts
 *
 * The first form is what an operator runs to reproduce a boot refusal ("why will the worker
 * not start?"). The second is what proves the gate accepts a correctly launched process —
 * the difference between the two is one wrapper, and that is the whole point.
 *
 * Read-only: it creates no cgroup and starts nothing. The probe it consults does create a
 * short-lived leaf and migrate one child into it, then removes it.
 *
 * Exit codes: 0 = this process may execute tasks; 1 = it would be refused, with the failing
 * checks printed.
 */
import { getCgroupCapability, selfCgroupPath } from '../../apps/worker/src/capabilities';
import {
  assessExecutionEnforcement,
  describeExecutionEnforcement,
} from '../../apps/worker/src/execution-enforcement';

async function main(): Promise<void> {
  const root = process.env['WORKER_CGROUP_ROOT'] ?? '/sys/fs/cgroup/intelligenz';
  const self = await selfCgroupPath();
  const capability = await getCgroupCapability({ root });
  const assessment = await assessExecutionEnforcement({ root, capability });

  const lines = [
    `cgroup root        : ${root}`,
    `this process       : ${self}`,
    `delegation root    : ${assessment.expectedCgroupPath} (in /proc/self/cgroup terms)`,
    `host probe         : ${capability.mode}`,
    `verdict            : ${assessment.mode.toUpperCase()}`,
  ];

  if (assessment.mode === 'refused') {
    lines.push('', 'failing checks:');

    for (const failure of assessment.failures) {
      lines.push(`  ${failure.check}: ${failure.detail}`);
    }

    lines.push('', `remediation: ${assessment.remediation}`);
  } else {
    lines.push(
      `controllers        : ${assessment.controllers.join(' ') || 'none'}`,
      `memory.max         : ${assessment.limits['memory.max'] ?? 'unread'}`,
      `pids.max           : ${assessment.limits['pids.max'] ?? 'unread'}`,
    );
  }

  lines.push('', describeExecutionEnforcement(assessment));

  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = assessment.mode === 'verified' ? 0 : 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`execution-enforcement-probe failed: ${String(error)}\n`);
  process.exitCode = 1;
});
