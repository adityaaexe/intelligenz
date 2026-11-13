import { RiskBadge, StatusPill, Timestamp, riskFromWire } from '@intelligenz/design-system';

import { taskGateState } from '../../lib/execution-state';
import type { TaskDetail } from '../../lib/types';
import { TaskGateBadge } from './execution-badges';

/**
 * The task this execution history belongs to, as a five-cell ledger strip.
 *
 * This is where the two task-level words in the vocabulary appear: `Blocked` and
 * `Waiting for approval`. They are computed from the task status and its approval
 * rows (`lib/execution-state.ts#taskGateState`), never inferred from a run.
 *
 * A blocked task is named once — the gate badge carries both the word and the
 * reason — because rendering "Blocked" twice side by side reads as two different
 * facts about the same object.
 *
 * `aria-label` makes the strip a named region without a heading it does not need:
 * the page's heading hierarchy is task (h1) → region titles (h2).
 */
export function TaskStrip({
  task,
  readAt,
}: {
  readonly task: TaskDetail;
  /** Reference instant for the relative timestamp, so hydration cannot disagree. */
  readonly readAt: number;
}) {
  const gate = taskGateState(task);
  const risk = riskFromWire(task.riskClass);

  return (
    <section aria-label="Task state">
      <dl className="iz-hairlines ex-taskstrip">
        <div className="ex-taskstrip__cell">
          <dt className="iz-metric__label">Task status</dt>
          <dd className="ex-taskstrip__value">
            {gate?.word === 'Blocked' ? null : <StatusPill status={task.status} size="sm" />}
            {gate !== null ? <TaskGateBadge gate={gate} /> : null}
          </dd>
        </div>
        <div className="ex-taskstrip__cell">
          <dt className="iz-metric__label">Risk class</dt>
          <dd className="ex-taskstrip__value">
            {risk !== null ? <RiskBadge level={risk} /> : task.riskClass}
          </dd>
        </div>
        <div className="ex-taskstrip__cell">
          <dt className="iz-metric__label">Project</dt>
          <dd className="ex-taskstrip__value">
            <span className="iz-mono">{task.project.key}</span>
          </dd>
        </div>
        <div className="ex-taskstrip__cell">
          <dt className="iz-metric__label">Priority</dt>
          <dd className="ex-taskstrip__value">{task.priority}</dd>
        </div>
        <div className="ex-taskstrip__cell">
          <dt className="iz-metric__label">Updated</dt>
          <dd className="ex-taskstrip__value iz-num">
            <Timestamp iso={task.updatedAt} now={readAt} />
          </dd>
        </div>
      </dl>
    </section>
  );
}
