'use client';

import { useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon, ariaSort, formatDuration, formatTokenCount, nextSortState, sortBy } from '@intelligenz/design-system';
import type { SortState, SortValue } from '@intelligenz/design-system';

import {
  describeDuration,
  elapsedMs,
  formatProviderCost,
  provenanceOf,
  runStateDescriptor,
  workspaceStateLabel,
} from '../../lib/execution-state';
import type { ExecutionAttempt } from '../../lib/types';
import { ProvenanceBadge, RunStateBadge } from './execution-badges';
import { NotReported, SpokenValue } from './a11y-values';

/**
 * One row per attempt (`api-contract.md` §Executions: an attempt is the unit, not
 * the task, so a retry is addressable).
 *
 * Default order is the API's — newest first, untouched. The sortable headers are
 * an operator convenience on top of it, and `aria-sort` is produced by the same
 * state that produces the order (`lib/sort.ts`), so the announcement cannot
 * disagree with the rows.
 *
 * Selection is a disclosure, not a second navigation: the button carries
 * `aria-expanded` and `aria-controls` pointing at the detail region below, and
 * the selected row is marked with `data-selected` **and** a 2px ink inset bar so
 * the state is not colour-only.
 */

export interface AttemptTableProps {
  readonly attempts: readonly ExecutionAttempt[];
  readonly selectedId: string | null;
  readonly onSelect: (attemptId: string) => void;
  /** Reference instant for an open attempt's elapsed time. */
  readonly now: number;
  /** Id of the element the select buttons disclose. */
  readonly detailId: string;
}

type SortKey =
  | 'attempt'
  | 'provenance'
  | 'state'
  | 'runtime'
  | 'duration'
  | 'tokensIn'
  | 'tokensOut'
  | 'cost'
  | 'workspace';

interface Column {
  readonly key: SortKey;
  readonly header: string;
  readonly align?: 'left' | 'right';
  readonly width?: string;
  readonly hideBelow?: 'sm' | 'md' | 'lg';
  readonly sortValue?: (attempt: ExecutionAttempt) => SortValue;
  readonly defaultDirection?: 'asc' | 'desc';
  readonly render: (attempt: ExecutionAttempt) => ReactNode;
}

function sortValueFor(attempt: ExecutionAttempt, key: SortKey, now: number): SortValue {
  switch (key) {
    case 'attempt':
      return attempt.attemptNumber;
    case 'provenance':
      return provenanceOf(attempt);
    case 'state':
      return runStateDescriptor(attempt.status).label;
    case 'runtime':
      return attempt.runtimeVersion === null
        ? attempt.runtimeId
        : `${attempt.runtimeId} ${attempt.runtimeVersion}`;
    case 'duration':
      return elapsedMs(attempt, now);
    case 'tokensIn':
      return attempt.tokensIn;
    case 'tokensOut':
      return attempt.tokensOut;
    case 'cost': {
      if (attempt.costUsd === null) {
        return null;
      }
      const parsed = Number.parseFloat(attempt.costUsd);
      return Number.isFinite(parsed) ? parsed : null;
    }
    case 'workspace':
      return attempt.workspace === null ? null : workspaceStateLabel(attempt.workspace.state);
  }
}

export function AttemptTable({ attempts, selectedId, onSelect, now, detailId }: AttemptTableProps) {
  const [sort, setSort] = useState<SortState | null>(null);

  const columns: readonly Column[] = useMemo(
    () => [
      {
        key: 'attempt',
        header: 'Attempt',
        width: '84px',
        sortValue: (attempt) => sortValueFor(attempt, 'attempt', now),
        render: (attempt) => (
          <button
            type="button"
            className="ex-attempt-select"
            aria-expanded={attempt.id === selectedId}
            aria-controls={detailId}
            aria-label={`Attempt ${attempt.attemptNumber} details`}
            onClick={() => onSelect(attempt.id)}
          >
            <Icon name={attempt.id === selectedId ? 'chevron-down' : 'chevron-right'} size={12} />
            <span className="iz-mono">#{attempt.attemptNumber}</span>
          </button>
        ),
      },
      {
        key: 'provenance',
        header: 'Provenance',
        width: '104px',
        sortValue: (attempt) => sortValueFor(attempt, 'provenance', now),
        render: (attempt) => <ProvenanceBadge provenance={provenanceOf(attempt)} size="sm" />,
      },
      {
        key: 'state',
        header: 'State',
        width: '112px',
        sortValue: (attempt) => sortValueFor(attempt, 'state', now),
        render: (attempt) => <RunStateBadge status={attempt.status} size="sm" />,
      },
      {
        key: 'runtime',
        header: 'Runtime',
        width: '168px',
        hideBelow: 'sm',
        sortValue: (attempt) => sortValueFor(attempt, 'runtime', now),
        render: (attempt) => {
          const full =
            attempt.runtimeVersion === null
              ? attempt.runtimeId
              : `${attempt.runtimeId} ${attempt.runtimeVersion}`;
          return (
            <span className="iz-mono iz-truncate ex-runtime" title={full}>
              {attempt.runtimeId}
              {attempt.runtimeVersion !== null ? (
                <span className="ex-muted"> {attempt.runtimeVersion}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        key: 'duration',
        header: 'Duration',
        align: 'right',
        width: '88px',
        hideBelow: 'sm',
        defaultDirection: 'desc',
        sortValue: (attempt) => sortValueFor(attempt, 'duration', now),
        render: (attempt) => {
          const ms = elapsedMs(attempt, now);
          return (
            <span className="iz-num">
              <SpokenValue spoken={describeDuration(ms)}>{formatDuration(ms)}</SpokenValue>
            </span>
          );
        },
      },
      {
        key: 'tokensIn',
        header: 'Tok in',
        align: 'right',
        width: '76px',
        hideBelow: 'md',
        defaultDirection: 'desc',
        sortValue: (attempt) => sortValueFor(attempt, 'tokensIn', now),
        render: (attempt) => <span className="iz-num">{formatTokenCount(attempt.tokensIn)}</span>,
      },
      {
        key: 'tokensOut',
        header: 'Tok out',
        align: 'right',
        width: '76px',
        hideBelow: 'md',
        defaultDirection: 'desc',
        sortValue: (attempt) => sortValueFor(attempt, 'tokensOut', now),
        render: (attempt) => <span className="iz-num">{formatTokenCount(attempt.tokensOut)}</span>,
      },
      {
        key: 'cost',
        header: 'Cost',
        align: 'right',
        width: '84px',
        defaultDirection: 'desc',
        sortValue: (attempt) => sortValueFor(attempt, 'cost', now),
        render: (attempt) => {
          const formatted = formatProviderCost(attempt.costUsd);
          return (
            <span className="iz-num">
              {formatted === '—' ? <NotReported /> : formatted}
            </span>
          );
        },
      },
      {
        key: 'workspace',
        header: 'Workspace',
        width: '112px',
        hideBelow: 'lg',
        sortValue: (attempt) => sortValueFor(attempt, 'workspace', now),
        render: (attempt) =>
          attempt.workspace === null ? (
            <NotReported label="No workspace provisioned" />
          ) : (
            <span className="ex-workspace-state">{workspaceStateLabel(attempt.workspace.state)}</span>
          ),
      },
    ],
    [detailId, now, onSelect, selectedId],
  );

  const rows = useMemo(() => {
    if (sort === null) {
      return [...attempts];
    }
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (column?.sortValue === undefined) {
      return [...attempts];
    }
    const getValue = column.sortValue;
    return sortBy(attempts, (attempt) => getValue(attempt), sort.direction);
  }, [attempts, columns, sort]);

  return (
    <div
      className="iz-table-scroll"
      role="region"
      tabIndex={0}
      aria-label="Execution attempts, scrollable"
    >
      <table className="iz-table ex-attempts" data-density="compact">
        <caption className="iz-sr-only">
          Execution attempts for this task, newest first. Selecting an attempt opens its detail.
        </caption>
        <thead>
          <tr>
            {columns.map((column) => {
              const active = sort?.key === column.key ? sort.direction : null;
              const sortable = column.sortValue !== undefined;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sortable ? ariaSort(active) : undefined}
                  data-align={column.align}
                  style={column.width !== undefined ? { width: column.width } : undefined}
                  className={column.hideBelow !== undefined ? `iz-col-${column.hideBelow}` : undefined}
                >
                  {sortable ? (
                    <button
                      type="button"
                      className="iz-table__sort"
                      aria-label={`Sort by ${column.header}`}
                      onClick={() =>
                        setSort((current) =>
                          nextSortState(current, column.key, column.defaultDirection ?? 'asc'),
                        )
                      }
                    >
                      <span>{column.header}</span>
                      <Icon
                        className="iz-table__sort-icon"
                        name={active === 'desc' ? 'chevron-down' : 'chevron-up'}
                        size={12}
                      />
                    </button>
                  ) : (
                    column.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.map((attempt) => {
            const selected = attempt.id === selectedId;
            return (
              <tr key={attempt.id} data-selected={selected ? 'true' : undefined}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    data-align={column.align}
                    className={column.hideBelow !== undefined ? `iz-col-${column.hideBelow}` : undefined}
                  >
                    {column.render(attempt)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
