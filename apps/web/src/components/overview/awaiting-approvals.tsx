import {
  EmptyState,
  Panel,
  RiskBadge,
  StatusPill,
  formatRelative,
  riskFromWire,
} from '@intelligenz/design-system';

import type { OverviewSnapshot } from '../../lib/overview';
import { RegionError } from './region-error';

/**
 * Awaiting approvals — source: `ApprovalRequest` where `PENDING` (contract §15 A6).
 *
 * The API already risk-ranks (`CRITICAL → HIGH → MEDIUM → LOW`, oldest first
 * inside a class, `api-contract.md` §4), so this panel renders the server's
 * order rather than inventing one. Risk is the segmented badge, not a pill, so
 * it cannot be confused with the task's status next to it.
 *
 * Read-only in this phase: the decision endpoint exists, the Approvals screen
 * does not. The footer says so rather than hiding the buttons' absence.
 */
export function AwaitingApprovals({
  snapshot,
  onRetry,
}: {
  readonly snapshot: OverviewSnapshot;
  readonly onRetry: () => void;
}) {
  const { approvals } = snapshot;

  if (!approvals.ok) {
    return (
      <Panel title="Awaiting approvals" meta="ApprovalRequest · PENDING">
        <RegionError headline="Approvals could not be read." error={approvals.error} onRetry={onRetry} />
      </Panel>
    );
  }

  const pending = approvals.value.filter((approval) => approval.status === 'PENDING');

  return (
    <Panel
      title="Awaiting approvals"
      meta={<span className="iz-num">{pending.length}</span>}
      note="Risk-ranked by the API: critical first, oldest first within a class."
      flush
      footer="Deciding an approval is not available in this phase — the Approvals screen is not implemented. The decision endpoint exists at POST /v1/orgs/:orgId/approvals/:approvalId/decision."
    >
      {pending.length === 0 ? (
        <EmptyState
          title="No approvals waiting"
          description="Nothing needs a human decision right now. A HIGH or CRITICAL task creates a pending request automatically when it is created."
        />
      ) : (
        <ul className="ov-approval-list">
          {pending.map((approval) => {
            const risk = riskFromWire(approval.riskClass);
            return (
              <li
                className="ov-approval"
                key={approval.id}
                data-critical={approval.riskClass === 'CRITICAL' ? 'true' : undefined}
              >
                <div className="ov-approval__head">
                  {risk !== null ? <RiskBadge level={risk} /> : <span>{approval.riskClass}</span>}
                  <span className="iz-mono" title={approval.id}>
                    {approval.id.slice(-6)}
                  </span>
                </div>
                <p className="ov-approval__title">{approval.task.title}</p>
                <div className="ov-approval__meta">
                  <StatusPill status={approval.task.status} size="sm" />
                  <span>
                    Requested by {approval.requestedBy?.name ?? 'unknown'} ·{' '}
                    {formatRelative(approval.createdAt, snapshot.fetchedAt)}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}
