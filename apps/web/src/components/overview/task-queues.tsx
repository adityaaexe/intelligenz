import {
  Chip,
  DataTable,
  EmptyState,
  Panel,
  RiskBadge,
  StatusPill,
  formatCount,
  formatRelative,
  riskFromWire,
} from '@intelligenz/design-system';
import type { DataTableColumn } from '@intelligenz/design-system';
import Link from 'next/link';

import type { OverviewSnapshot } from '../../lib/overview';
import { queueCounts } from '../../lib/overview';
import type { Task } from '../../lib/types';
import { RegionError } from './region-error';

/**
 * Task queues — source: `Task` grouped by status (contract §15 A6).
 *
 * Counts are computed from the task lists of every project in the workspace.
 * The table shows tasks, not workflow runs, and the panel says so: a `queued`
 * task is not a queued workflow run, and letting the ledger imply otherwise
 * would be exactly the kind of borrowed credibility contract §15 A6 forbids.
 */
export function TaskQueues({
  snapshot,
  workspace,
  onRetry,
}: {
  readonly snapshot: OverviewSnapshot;
  readonly workspace: string;
  readonly onRetry: () => void;
}) {
  const { tasks, projects } = snapshot;

  if (!tasks.ok) {
    return (
      <Panel title="Task queues" meta="Task grouped by status">
        <RegionError headline="Tasks could not be read." error={tasks.error} onRetry={onRetry} />
      </Panel>
    );
  }

  const projectKey = new Map<string, string>();
  if (projects.ok) {
    for (const project of projects.value) {
      projectKey.set(project.id, project.key);
    }
  }

  const buckets = queueCounts(tasks.value).filter((bucket) => bucket.count > 0);
  const columns: DataTableColumn<Task>[] = [
    {
      key: 'status',
      header: 'Status',
      width: '132px',
      sortValue: (task) => task.status,
      render: (task) => <StatusPill status={task.status} size="sm" />,
    },
    {
      key: 'title',
      header: 'Task',
      sortValue: (task) => task.title,
      render: (task) => (
        <Link
          className="iz-link iz-truncate"
          href={`/${workspace}/tasks/${task.id}`}
          title={`Open execution history for ${task.title}`}
        >
          {task.title}
        </Link>
      ),
    },
    {
      key: 'project',
      header: 'Project',
      width: '96px',
      hideBelow: 'sm',
      sortValue: (task) => projectKey.get(task.projectId) ?? null,
      render: (task) => (
        <span className="iz-mono">{projectKey.get(task.projectId) ?? '—'}</span>
      ),
    },
    {
      key: 'updated',
      header: 'Updated',
      width: '104px',
      align: 'right',
      sortValue: (task) => Date.parse(task.updatedAt),
      render: (task) => (
        <span className="iz-num" title={task.updatedAt}>
          {formatRelative(task.updatedAt, snapshot.fetchedAt)}
        </span>
      ),
    },
  ];

  return (
    <Panel
      title="Task queues"
      meta={<Chip tone="derived">Derived</Chip>}
      note={
        <>
          {formatCount(tasks.value.length)} task{tasks.value.length === 1 ? '' : 's'} across{' '}
          {projects.ok ? projects.value.length : 0} project
          {projects.ok && projects.value.length === 1 ? '' : 's'} in this workspace, newest first.
          A task title opens its execution history, where each attempt is a row.
          Workflow runs are not listed here — <span className="iz-mono">WorkflowRun</span> has no
          read endpoint.
          {snapshot.taskListFailures > 0
            ? ` ${snapshot.taskListFailures} project${
                snapshot.taskListFailures === 1 ? '' : 's'
              } could not be read, so the counts are partial.`
            : ''}
        </>
      }
      flush
    >
      {tasks.value.length === 0 ? (
        <EmptyState
          title="No tasks in this workspace"
          description="Tasks appear when one is created through the API or by a workflow. This workspace currently has none, so every queue is empty."
        />
      ) : (
        <>
          <div className="ov-queue-row" role="group" aria-label="Counts by status">
            {buckets.map((bucket) => (
              <span className="ov-queue-count" key={bucket.status}>
                <span className="ov-queue-count__value">{formatCount(bucket.count)}</span>
                {bucket.label}
              </span>
            ))}
          </div>
          <DataTable
            caption="Tasks in this workspace, newest first"
            ariaLabel="Task queues table, scrollable"
            columns={columns}
            rows={tasks.value}
            getRowId={(task) => task.id}
            initialSort={{ key: 'updated', direction: 'desc' }}
            density="compact"
            maxHeight={420}
            renderExpanded={(task) => <TaskDetailPanel task={task} projectKey={projectKey.get(task.projectId)} />}
            expandLabel={(task) => `Show details for ${task.title}`}
          />
        </>
      )}
    </Panel>
  );
}

function TaskDetailPanel({ task, projectKey }: { readonly task: Task; readonly projectKey: string | undefined }) {
  const risk = riskFromWire(task.riskClass);
  return (
    <dl style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--iz-space-12)', margin: 0 }}>
      <div>
        <dt className="iz-metric__label">Task id</dt>
        <dd className="iz-mono" style={{ margin: 0 }}>
          {task.id}
        </dd>
      </div>
      <div>
        <dt className="iz-metric__label">Risk class</dt>
        <dd style={{ margin: 0 }}>{risk !== null ? <RiskBadge level={risk} /> : task.riskClass}</dd>
      </div>
      <div>
        <dt className="iz-metric__label">Priority</dt>
        <dd style={{ margin: 0 }}>{task.priority}</dd>
      </div>
      <div>
        <dt className="iz-metric__label">Project</dt>
        <dd style={{ margin: 0 }}>{projectKey ?? '—'}</dd>
      </div>
      <div style={{ gridColumn: '1 / -1' }}>
        <dt className="iz-metric__label">Goal</dt>
        <dd style={{ margin: 0, maxWidth: '72ch' }}>{task.goal}</dd>
      </div>
      <div>
        <dt className="iz-metric__label">Acceptance criteria</dt>
        <dd style={{ margin: 0 }}>{task.acceptanceCriteria.length}</dd>
      </div>
    </dl>
  );
}
