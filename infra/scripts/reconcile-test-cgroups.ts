/**
 * Reconcile cgroup leaves left behind by crashed or timed-out test runs.
 *
 *   npx tsx infra/scripts/reconcile-test-cgroups.ts            # list only (default)
 *   npx tsx infra/scripts/reconcile-test-cgroups.ts --apply    # remove empty test leaves
 *   npx tsx infra/scripts/reconcile-test-cgroups.ts --root=/sys/fs/cgroup/intelligenz
 *
 * Dry run by default. `--apply` removes **only** leaves that satisfy both conditions:
 * the name matches the test-owned allowlist in `apps/worker/src/cgroup-hygiene.ts`, and
 * `cgroup.procs` is empty at the moment of removal. Everything else is printed and
 * refused — including `${root}/worker`, which belongs to the launcher, and any leaf named
 * by an execution workspace id.
 *
 * This is an operator tool, not a daemon: nothing schedules it. A leaf that survives
 * because it still holds a process is a finding, not a nuisance — that process is what
 * kept the leaf alive, and killing it is a decision with its own evidence requirement.
 *
 * Exit codes: 0 = nothing actionable (dry run, or all removable leaves removed);
 *             1 = a **test-owned** leaf could not be removed, or a removal failed.
 *             An unrecognised leaf (`worker`, a workspace-id leaf) is reported but is not
 *             an error: it is a leaf this tool must never touch, not a leaf it failed at.
 */
import { basename } from 'node:path';

import { isTestOwnedLeafName, reconcileTestLeaves } from '../../apps/worker/src/cgroup-hygiene';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const apply = argv.includes('--apply');
  const rootArgument = argv.find((argument) => argument.startsWith('--root='));
  const root = rootArgument?.slice('--root='.length);

  const report = await reconcileTestLeaves({
    ...(root === undefined || root.length === 0 ? {} : { root }),
    apply,
  });

  const lines: string[] = [
    `cgroup root : ${report.root}`,
    `mode        : ${report.applied ? 'APPLY' : 'DRY RUN (pass --apply to remove)'}`,
    `leaves      : ${String(report.leaves.length)}`,
    `removable   : ${String(report.removable.length)}`,
    '',
  ];

  for (const leaf of report.leaves) {
    const state = leaf.removable
      ? report.applied && report.removed.includes(leaf.path)
        ? 'removed'
        : 'removable'
      : 'refused';

    lines.push(
      `  ${state.padEnd(10)} ${leaf.name}` +
        (leaf.pids.length === 0 ? '' : `  pids=${leaf.pids.slice(0, 8).join(',')}`) +
        (leaf.refusal === undefined ? '' : `  reason=${leaf.refusal}`),
    );
  }

  const refusals = report.refused.length;

  if (refusals > 0) {
    lines.push(
      '',
      `${String(refusals)} leaf/leaves not deleted, for the reasons above. ` +
        'Only an unrecognised name is expected here; a held process is a finding.',
    );
  }

  // A refusal of `worker` or of a workspace-id leaf is the tool working correctly, not
  // failing: it must never delete those. Only a stuck test leaf is an error.
  const actionable = report.refused.filter((entry) => isTestOwnedLeafName(basename(entry.path)));

  process.stdout.write(`${lines.join('\n')}\n`);
  process.exitCode = actionable.length > 0 ? 1 : 0;
}

main().catch((error: unknown) => {
  process.stderr.write(`reconcile-test-cgroups failed: ${String(error)}\n`);
  process.exitCode = 1;
});
