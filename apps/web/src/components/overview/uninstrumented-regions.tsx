import { NotInstrumented, Panel } from '@intelligenz/design-system';

/**
 * The two Overview regions with no source at all (contract §15 A6).
 *
 * These are not errors and not empty states: the API has no endpoint that could
 * populate them, so they say so, name the missing source, and name what would
 * unblock them. A fixture would make the page look complete and make every other
 * number on it untrustworthy.
 */
export function ActiveWorkflowsRegion() {
  return (
    <Panel title="Active workflows" meta="WorkflowRun · running / queued">
      <NotInstrumented
        reason="No endpoint lists workflow runs. A run is only reachable through the task that owns it (GET /v1/orgs/:orgId/tasks/:taskId → latestRun), so this region cannot count runs in flight."
        source="WorkflowRun where status in (running, queued) — no read route in apps/api"
        unblockedBy="Reading task status in the Task queues region above is the closest real signal in this phase."
      />
    </Panel>
  );
}

export function RecentDecisionsRegion() {
  return (
    <Panel title="Recent decisions" meta="AuditEvent · decision actions">
      <NotInstrumented
        reason="No endpoint lists audit events. Approvals are written to AuditEvent (approval.decided.v1) but nothing reads them back, so a decisions ledger cannot be built from this API."
        source="AuditEvent where eventType is a decision — no read route in apps/api"
        unblockedBy="A read-only audit endpoint, or the Approvals screen reading decision history, would make this region real."
      />
    </Panel>
  );
}
