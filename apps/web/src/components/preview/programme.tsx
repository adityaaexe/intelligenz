import type { RiskLevel, StatusTone } from '@intelligenz/design-system';
import { RiskBadge, StatusPill, MetricTile, Panel, riskFromWire } from '@intelligenz/design-system';

import type { PreviewFilter, PreviewTask, ProgrammeSummary } from '../../lib/preview-data';
import { filterTasks, formatUtc } from '../../lib/preview-data';

/**
 * The programme half of `/preview`: summary, board, blockers, next task.
 *
 * Pure presentation over the allowlisted ledger. No client directive, no state,
 * no effect — these components render on the server and are never hydrated.
 * Every status carries a word; the pill's colour is a second channel.
 */

export function statusLabel(status: string): string {
  if (status === 'completed') return 'Completed';
  if (status === 'blocked') return 'Blocked';
  if (status === 'planned') return 'Planned';
  if (status.length === 0) return 'Not recorded';
  const spaced = status.replace(/[_-]+/g, ' ').trim();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

export function statusTone(status: string): StatusTone {
  if (status === 'completed') return 'completed';
  if (status === 'blocked') return 'awaiting';
  if (status === 'planned') return 'queued';
  return 'neutral';
}

/** The ledger says `moderate`; `RiskBadge` speaks `MEDIUM`. Nothing else maps. */
function riskLevelOf(riskClass: string): RiskLevel | null {
  if (riskClass === 'moderate') return 'MEDIUM';
  return riskFromWire(riskClass);
}

function riskLabelOf(riskClass: string): string {
  const level = riskLevelOf(riskClass);
  if (level === null) return '—';
  return level.charAt(0) + level.slice(1).toLowerCase();
}

const FILTERS: readonly { readonly value: PreviewFilter; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'planned', label: 'Planned' },
];

/* ---------------------------------------------------------------------------
 * B. Programme summary
 * ------------------------------------------------------------------------- */

export function SummarySection({
  summary,
  phase,
  head,
  dropped,
}: {
  readonly summary: ProgrammeSummary;
  readonly phase: string;
  readonly head: string;
  readonly dropped: number;
}) {
  return (
    <Panel
      title="Programme summary"
      meta={`Phase ${phase || 'not recorded'} · head ${head || 'not recorded'}`}
      footer={
        <p className="pv-footnote">
          Completion is <code>completed / total</code> = {summary.completed} / {summary.total}. A{' '}
          <strong>blocked</strong> task is stopped, a <strong>planned</strong> task has not started;
          neither counts as complete.
        </p>
      }
    >
      <div className="iz-hairlines pv-summary">
        <MetricTile
          label="Total tasks"
          value={summary.total}
          hint="Every task recorded in the ledger"
        />
        <MetricTile
          label="Completed"
          value={summary.completed}
          hint="status: completed"
          tone="active"
        />
        <MetricTile label="Blocked" value={summary.blocked} hint="status: blocked" tone="awaiting" />
        <MetricTile label="Planned" value={summary.planned} hint="status: planned" />
        <MetricTile
          label="Complete"
          value={summary.percentage}
          unit="%"
          hint={`completed / total = ${summary.completed} / ${summary.total}`}
        />
      </div>
      {summary.other > 0 ? (
        <p className="pv-note">
          {summary.other} task{summary.other === 1 ? '' : 's'} carry a status outside
          completed/blocked/planned and are counted in the total only.
        </p>
      ) : null}
      {dropped > 0 ? (
        <p className="pv-note">
          {dropped} ledger entr{dropped === 1 ? 'y' : 'ies'} carried no usable id and{' '}
          {dropped === 1 ? 'is' : 'are'} not shown.
        </p>
      ) : null}
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
 * C. Task board
 * ------------------------------------------------------------------------- */

function TaskRow({ task }: { readonly task: PreviewTask }) {
  const level = riskLevelOf(task.riskClass);
  return (
    <tr>
      <td data-label="ID">
        <code className="pv-id">{task.id}</code>
      </td>
      <td data-label="Task" className="pv-task">
        {task.title}
      </td>
      <td data-label="Status">
        <StatusPill
          status={task.status}
          label={statusLabel(task.status)}
          tone={statusTone(task.status)}
          size="sm"
        />
      </td>
      <td data-label="Phase" className="pv-figure">
        {task.phase || '—'}
      </td>
      <td data-label="Risk">
        {level === null ? (
          <span className="pv-absent">
            —<span className="iz-sr-only"> risk not recorded</span>
          </span>
        ) : (
          <RiskBadge level={level} />
        )}
      </td>
      <td data-label="Depends on" className="pv-figure">
        {task.dependsOn.length === 0 ? (
          <span className="pv-absent">none</span>
        ) : (
          task.dependsOn.join(', ')
        )}
      </td>
      <td data-label="Owner" className="pv-owner">
        {task.owner || '—'}
      </td>
      <td data-label="Updated">
        <time dateTime={task.updatedAt || undefined}>{formatUtc(task.updatedAt)}</time>
      </td>
    </tr>
  );
}

export function BoardSection({
  tasks,
  filter,
  summary,
}: {
  readonly tasks: readonly PreviewTask[];
  readonly filter: PreviewFilter;
  readonly summary: ProgrammeSummary;
}) {
  const filtered = filterTasks(tasks, filter);
  const counts: Readonly<Record<PreviewFilter, number>> = {
    all: summary.total,
    completed: summary.completed,
    blocked: summary.blocked,
    planned: summary.planned,
  };

  return (
    <Panel
      title="Task board"
      meta={`${filtered.length} of ${summary.total} shown · sorted by phase, then id`}
      flush
    >
      <nav className="pv-toolbar" aria-label="Filter tasks by status">
        <ul className="pv-filters">
          {FILTERS.map((entry) => {
            const href = entry.value === 'all' ? '/preview' : `/preview?status=${entry.value}`;
            const active = entry.value === filter;
            return (
              <li key={entry.value}>
                <a
                  className="pv-filter"
                  href={href}
                  aria-current={active ? 'page' : undefined}
                  data-active={active ? 'true' : undefined}
                >
                  {entry.label}
                  <span className="pv-filter__count">{counts[entry.value]}</span>
                </a>
              </li>
            );
          })}
        </ul>
        <p className="pv-toolbar__hint">
          These are links, not buttons: the server applies the filter, so the view works with
          JavaScript disabled.
        </p>
      </nav>

      {filtered.length === 0 ? (
        <p className="pv-empty">
          No task in the ledger has status <code>{filter}</code>.
        </p>
      ) : (
        <div className="iz-table-scroll">
          <table className="iz-table pv-table">
            <caption className="iz-table__caption">
              {filtered.length} task{filtered.length === 1 ? '' : 's'}. Status is text first; colour,
              where present, is a second channel.
            </caption>
            <thead>
              <tr>
                <th scope="col">ID</th>
                <th scope="col">Task</th>
                <th scope="col">Status</th>
                <th scope="col">Phase</th>
                <th scope="col">Risk</th>
                <th scope="col">Depends on</th>
                <th scope="col">Owner</th>
                <th scope="col">Updated (UTC)</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((task) => (
                <TaskRow key={task.id} task={task} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
 * D. Blockers
 * ------------------------------------------------------------------------- */

export function BlockersSection({
  tasks,
  facts,
}: {
  readonly tasks: readonly PreviewTask[];
  readonly facts: readonly string[];
}) {
  return (
    <Panel title="Blockers" meta={`${tasks.length} blocked in the ledger`} flush>
      <div className="pv-blockers">
        <p className="pv-label">Blocked in the ledger — reason recorded in the evidence artifact.</p>
        <p className="pv-note">
          The ledger records no dedicated blocker-reason field, so none is invented here. Each task
          is shown with the artifact its evidence requirement names; the reason lives there.
        </p>

        {tasks.length === 0 ? (
          <p className="pv-empty">No task is blocked in the ledger.</p>
        ) : (
          <ul className="pv-blocker-list">
            {tasks.map((task) => (
              <li key={task.id} className="pv-blocker">
                <div className="pv-blocker__head">
                  <code className="pv-id">{task.id}</code>
                  <StatusPill status="blocked" label="Blocked" tone="awaiting" size="sm" />
                  <span className="pv-blocker__phase">Phase {task.phase || '—'}</span>
                </div>
                <p className="pv-blocker__title">{task.title}</p>
                <p className="pv-blocker__artifact">
                  Evidence artifact:{' '}
                  <code className="pv-path">
                    {task.evidenceArtifact ?? 'not recorded in the ledger'}
                  </code>
                </p>
                <dl className="pv-blocker__meta">
                  <div>
                    <dt>Owner</dt>
                    <dd>{task.owner || '—'}</dd>
                  </div>
                  <div>
                    <dt>Updated</dt>
                    <dd>
                      <time dateTime={task.updatedAt || undefined}>
                        {formatUtc(task.updatedAt)}
                      </time>
                    </dd>
                  </div>
                  <div>
                    <dt>Depends on</dt>
                    <dd>{task.dependsOn.length === 0 ? 'none' : task.dependsOn.join(', ')}</dd>
                  </div>
                </dl>
              </li>
            ))}
          </ul>
        )}

        <div className="pv-derived">
          <h3 className="pv-h3">Derived from the ledger</h3>
          {facts.length === 0 ? (
            <p className="pv-note">
              The ledger records no execution gate and no dependency edge for these tasks.
            </p>
          ) : (
            <ul className="pv-fact-list">
              {facts.map((fact) => (
                <li key={fact}>{fact}</li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* ---------------------------------------------------------------------------
 * E. Next eligible task
 * ------------------------------------------------------------------------- */

export function NextEligibleSection({ task }: { readonly task: PreviewTask | null }) {
  return (
    <Panel
      title="Next eligible task"
      meta="first planned task whose dependencies are all completed"
      flush
    >
      <div className="pv-next">
        {task === null ? (
          <p className="pv-next__none">
            None eligible — every planned task has at least one dependency that is not{' '}
            <code>completed</code>.
          </p>
        ) : (
          <>
            <div className="pv-next__head">
              <code className="pv-id">{task.id}</code>
              <StatusPill status="planned" label="Planned" tone="queued" size="sm" />
              <span className="pv-blocker__phase">Phase {task.phase || '—'}</span>
            </div>
            <p className="pv-next__title">{task.title}</p>
            <dl className="pv-blocker__meta">
              <div>
                <dt>Owner</dt>
                <dd>{task.owner || '—'}</dd>
              </div>
              <div>
                <dt>Risk</dt>
                <dd>{riskLabelOf(task.riskClass)}</dd>
              </div>
              <div>
                <dt>Dependencies</dt>
                <dd>{task.dependsOn.length === 0 ? 'none' : task.dependsOn.join(', ')}</dd>
              </div>
            </dl>
          </>
        )}
        <p className="pv-note">
          Eligibility is computed from two ledger fields only: <code>status: planned</code> and every{' '}
          <code>dependsOn</code> entry at <code>completed</code>. A planned task whose evidence note
          records an external obstacle still appears here — a note is not a status.
        </p>
      </div>
    </Panel>
  );
}
