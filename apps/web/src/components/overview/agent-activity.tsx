import {
  Chip,
  DataTable,
  EmptyState,
  Panel,
  StatusPill,
  formatCost,
  formatDuration,
  formatRelative,
  formatTokenCount,
  isSimulatedRuntime,
} from '@intelligenz/design-system';
import type { DataTableColumn } from '@intelligenz/design-system';

import type { AgentRunRow, OverviewSnapshot } from '../../lib/overview';
import { DETAIL_BUDGET } from '../../lib/overview';
import { RegionError } from './region-error';

/**
 * Agent activity — source: `AgentRun` latest N (contract §15 A6).
 *
 * There is no `AgentRun` list endpoint. `GET /v1/orgs/:orgId/tasks/:taskId`
 * returns `latestRun.agentRuns`, so the page reads the task detail of the most
 * recently updated tasks and shows what it found. The scope line says exactly
 * that.
 *
 * Every row produced by `LocalSimulatedRuntime` carries a `Simulated` chip. The
 * product must never let a reader believe a real coding agent ran (contract §8);
 * the chip is derived from the `runtimeId` the API reported, so it cannot drift
 * from the data.
 */
export function AgentActivity({
  snapshot,
  onRetry,
}: {
  readonly snapshot: OverviewSnapshot;
  readonly onRetry: () => void;
}) {
  const { agentRuns } = snapshot;

  if (!agentRuns.ok) {
    return (
      <Panel title="Agent activity" meta="AgentRun">
        <RegionError headline="Agent runs could not be read." error={agentRuns.error} onRetry={onRetry} />
      </Panel>
    );
  }

  const columns: DataTableColumn<AgentRunRow>[] = [
    {
      key: 'runtime',
      header: 'Runtime',
      width: '132px',
      sortValue: (run) => run.runtimeId,
      render: (run) =>
        isSimulatedRuntime(run.runtimeId) ? (
          <Chip tone="simulated">Simulated</Chip>
        ) : (
          <span className="iz-mono">{run.runtimeId}</span>
        ),
    },
    {
      key: 'status',
      header: 'Status',
      width: '120px',
      sortValue: (run) => run.status,
      render: (run) => <StatusPill status={run.status} size="sm" />,
    },
    {
      key: 'tokens',
      header: 'Tokens',
      width: '120px',
      align: 'right',
      sortValue: (run) => run.tokensIn + run.tokensOut,
      render: (run) => (
        <span className="iz-num" title={`${run.tokensIn} in, ${run.tokensOut} out`}>
          {formatTokenCount(run.tokensIn + run.tokensOut)}
        </span>
      ),
    },
    {
      key: 'cost',
      header: 'Cost',
      width: '80px',
      align: 'right',
      sortValue: (run) => (run.costUsd === null ? null : Number.parseFloat(run.costUsd)),
      render: (run) => <span className="iz-num">{formatCost(run.costUsd)}</span>,
    },
    {
      key: 'started',
      header: 'Started',
      width: '88px',
      align: 'right',
      sortValue: (run) => (run.startedAt === null ? null : Date.parse(run.startedAt)),
      render: (run) =>
        run.startedAt === null ? (
          <span aria-label="Not reported">—</span>
        ) : (
          <span className="iz-num">{formatRelative(run.startedAt, snapshot.fetchedAt)}</span>
        ),
    },
  ];

  return (
    <Panel
      title="Agent activity"
      meta={<Chip tone="derived">Derived</Chip>}
      note={
        <>
          Latest run per task, for the {Math.min(DETAIL_BUDGET, snapshot.detailsAttempted)} most
          recently updated task{snapshot.detailsAttempted === 1 ? '' : 's'}.{' '}
          <span className="iz-mono">AgentRun</span> has no list endpoint, so this is read from task
          detail, not from a run index.
          {snapshot.detailFailures > 0
            ? ` ${snapshot.detailFailures} task detail read${snapshot.detailFailures === 1 ? '' : 's'} failed, so rows may be missing.`
            : ''}
        </>
      }
      flush
    >
      {agentRuns.value.length === 0 ? (
        <EmptyState
          title="No agent runs recorded"
          description="No task read on this page has an execution yet. A run appears after a workflow starts, and only the latest run of each task is visible here."
        />
      ) : (
        <DataTable
          caption="Agent runs, newest first"
          ariaLabel="Agent activity table, scrollable"
          columns={columns}
          rows={agentRuns.value}
          getRowId={(run) => run.id}
          initialSort={{ key: 'started', direction: 'desc' }}
          density="compact"
          maxHeight={360}
          renderExpanded={(run) => <RunDetail run={run} now={snapshot.fetchedAt} />}
          expandLabel={(run) => `Show details for run ${run.id.slice(0, 8)}`}
        />
      )}
    </Panel>
  );
}

function RunDetail({ run, now }: { readonly run: AgentRunRow; readonly now: number }) {
  return (
    <dl
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))',
        gap: 'var(--iz-space-12)',
        margin: 0,
      }}
    >
      <div>
        <dt className="iz-metric__label">Agent run</dt>
        <dd className="iz-mono" style={{ margin: 0 }}>
          {run.id}
        </dd>
      </div>
      <div>
        <dt className="iz-metric__label">Task</dt>
        <dd style={{ margin: 0 }}>{run.taskTitle}</dd>
      </div>
      <div>
        <dt className="iz-metric__label">Project</dt>
        <dd style={{ margin: 0 }}>{run.projectKey}</dd>
      </div>
      <div>
        <dt className="iz-metric__label">Runtime id</dt>
        <dd className="iz-mono" style={{ margin: 0 }}>
          {run.runtimeId}
        </dd>
      </div>
      <div>
        <dt className="iz-metric__label">Model</dt>
        <dd className="iz-mono" style={{ margin: 0 }}>
          {run.model}
        </dd>
      </div>
      <div>
        <dt className="iz-metric__label">Duration</dt>
        <dd className="iz-num" style={{ margin: 0 }}>
          {formatDuration(
            run.startedAt !== null && run.finishedAt !== null
              ? Date.parse(run.finishedAt) - Date.parse(run.startedAt)
              : null,
          )}
        </dd>
      </div>
      <div>
        <dt className="iz-metric__label">Finished</dt>
        <dd style={{ margin: 0 }}>
          {run.finishedAt === null ? (
            <span aria-label="Not reported">—</span>
          ) : (
            formatRelative(run.finishedAt, now)
          )}
        </dd>
      </div>
      {isSimulatedRuntime(run.runtimeId) ? (
        <div style={{ gridColumn: '1 / -1' }}>
          <p className="iz-field__hint">
            This run was produced by the local simulated runtime. No external coding agent ran and
            no tokens were billed to a provider.
          </p>
        </div>
      ) : null}
    </dl>
  );
}
