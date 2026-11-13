import { Chip, MetricTile, StatusPill, formatCost } from '@intelligenz/design-system';

import type { OverviewSnapshot } from '../../lib/overview';
import { POSTURE_RULE, derivePosture, sumUsage } from '../../lib/overview';

/**
 * R1 — the posture band.
 *
 * Not a card and not a shadow: five cells divided by 1px rules (§7.1). The
 * posture word is derived by `derivePosture` from real records, and the rule
 * that produced it is written next to it — a posture word with no stated rule is
 * a mood, not a measurement.
 */
export function PostureStrip({ snapshot }: { readonly snapshot: OverviewSnapshot }) {
  const posture = derivePosture({
    health: snapshot.health,
    tasks: snapshot.tasks,
    approvals: snapshot.approvals,
    now: snapshot.fetchedAt,
  });
  const usage = snapshot.agentRuns.ok ? sumUsage(snapshot.agentRuns.value) : null;
  const running = snapshot.tasks.ok
    ? snapshot.tasks.value.filter((task) => task.status === 'running').length
    : null;
  const failed = snapshot.tasks.ok
    ? snapshot.tasks.value.filter((task) => task.status === 'failed').length
    : null;
  const awaiting = snapshot.approvals.ok
    ? snapshot.approvals.value.filter((approval) => approval.status === 'PENDING').length
    : null;

  return (
    <section className="iz-hairlines ov-posture" aria-label="Posture">
      <div className="py-10 px-16">
        <span className="iz-metric__label">Posture</span>
        <div className="mt-4">
          <StatusPill status={posture.posture} label={posture.label} tone={posture.tone} />
        </div>
        <p className="iz-metric__hint mt-4">
          {posture.reason}
        </p>
      </div>

      <MetricTile
        label="Running now"
        value={running === null ? null : running}
        hint="Tasks in status running"
        tone="active"
      />
      <MetricTile
        label="Awaiting approval"
        value={awaiting === null ? null : awaiting}
        hint="Pending ApprovalRequest records"
        tone="awaiting"
      />
      <MetricTile
        label="Failed tasks"
        value={failed === null ? null : failed}
        hint="Tasks in status failed"
        tone="failed"
      />

      <div className="ov-posture__spend py-10 px-16">
        <span className="iz-metric__label">Recorded cost</span>
        <div className="ov-figure mt-4">
          {usage === null ? <span aria-label="Not reported">—</span> : formatCost(usage.costUsd)}
        </div>
        <div className="flex flex-wrap gap-4 mt-4">
          {usage === null ? (
            <span className="iz-metric__hint">Cost cannot be read.</span>
          ) : (
            <>
              <Chip tone="derived">Derived</Chip>
              {usage.reportedZeroCost ? <Chip tone="simulated">Simulated</Chip> : null}
            </>
          )}
        </div>
        <p className="iz-metric__hint mt-4">
          {usage === null
            ? 'Agent run usage is unavailable.'
            : `${usage.runs} agent run${usage.runs === 1 ? '' : 's'} across ${usage.tasks} task${usage.tasks === 1 ? '' : 's'}. No budget ceiling is configured in Phase 2.`}
        </p>
      </div>

      <p className="iz-sr-only">{POSTURE_RULE}</p>
    </section>
  );
}

/** R1b — operating constraints. The design has this line; Phase 2 has no source. */
export function ConstraintsLine() {
  return (
    <div className="ov-constraints">
      <Chip tone="neutral" icon="info">
        Not instrumented
      </Chip>
      <span>
        Operating constraints — mode, max risk, daily budget, sandbox and rollback policy — have no
        API source in Phase 2, so this line states none of them.
      </span>
    </div>
  );
}
