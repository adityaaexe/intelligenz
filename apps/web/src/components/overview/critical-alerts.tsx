import { EmptyState, Icon, Panel, StatusPill, formatRelative } from '@intelligenz/design-system';

import type { OverviewSnapshot } from '../../lib/overview';
import { criticalAlerts } from '../../lib/overview';
import { RegionError } from './region-error';

/**
 * Critical alerts — source: failed runs + overdue approvals (contract §15 A6).
 *
 * Two of the three kinds are producible today: a task in `failed` and a pending
 * approval older than 24 hours. `failed-run` is not: `WorkflowRun` has no read
 * endpoint. The panel names that gap instead of quietly shrinking the contract.
 *
 * An approval is only counted as an alert when it is still pending — a decided
 * request is history, not a blocker.
 */
export function CriticalAlerts({
  snapshot,
  onRetry,
}: {
  readonly snapshot: OverviewSnapshot;
  readonly onRetry: () => void;
}) {
  const { tasks, approvals } = snapshot;

  if (!tasks.ok && !approvals.ok) {
    return (
      <Panel title="Critical alerts" meta="Failed tasks · overdue approvals">
        <RegionError
          headline="Alerts could not be computed."
          error={tasks.error}
          onRetry={onRetry}
        />
      </Panel>
    );
  }

  const alerts = criticalAlerts(
    tasks.ok ? tasks.value : [],
    approvals.ok ? approvals.value : [],
    snapshot.fetchedAt,
  );

  return (
    <Panel
      title="Critical alerts"
      meta={<span className="iz-num">{alerts.length}</span>}
      note="Failed tasks and approvals pending for more than 24 hours. Workflow-run failures are not instrumented: there is no WorkflowRun read endpoint."
      flush
    >
      {alerts.length === 0 ? (
        <EmptyState
          title="No critical alerts"
          description="No task is in a failed state and no approval has waited more than 24 hours. Alerts appear here the moment either becomes true."
        />
      ) : (
        <ul className="ov-alert-list">
          {alerts.map((alert) => (
            <li className="ov-alert" key={alert.id}>
              <span style={{ paddingTop: '2px', flexShrink: 0 }}>
                <Icon
                  name={alert.severity === 'critical' ? 'status-failed' : 'warning'}
                  size={16}
                  label={alert.severity === 'critical' ? 'Critical' : 'High'}
                />
              </span>
              <div className="ov-alert__body">
                <span className="ov-alert__title">{alert.title}</span>
                <span className="ov-alert__meta">
                  <StatusPill
                    status={alert.kind === 'failed-task' ? 'failed' : 'PENDING'}
                    label={alert.kind === 'failed-task' ? 'Failed task' : 'Overdue approval'}
                    size="sm"
                  />{' '}
                  {alert.detail} · {formatRelative(alert.at, snapshot.fetchedAt)}
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
