'use client';

import { Fragment, useId, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

import { Icon } from './icon';
import { ariaSort, nextSortState, sortBy } from '../lib/sort';
import type { SortDirection, SortState, SortValue } from '../lib/sort';

/**
 * The ledger table.
 *
 * Semantics that are not optional in this product:
 * - `<caption>` always present (visually hidden by default) and `<th scope="col">`
 *   on every header (DESIGN.md §12.2 "Name, role, value").
 * - `aria-sort` is emitted from the same state that produces the order, so the
 *   announcement can never disagree with the rows.
 * - Sticky header is a 1px rule, not a shadow (§8).
 * - Expandable rows use `aria-expanded` + `aria-controls` on the toggle and a
 *   real following `<tr>` for the detail (§12.3).
 * - The scroll container is a labelled, focusable region so a keyboard user can
 *   scroll a wide table (WCAG 2.1.1, DESIGN.md §12.2 "Reflow").
 */

export type ColumnHideBelow = 'sm' | 'md' | 'lg';

export interface DataTableColumn<T> {
  readonly key: string;
  readonly header: string;
  readonly align?: 'left' | 'right' | 'center';
  readonly width?: string;
  /** Sorting is offered only when a comparator exists. */
  readonly sortValue?: (row: T) => SortValue;
  readonly defaultDirection?: SortDirection;
  /** Drops the column below this viewport width; the value stays in the detail. */
  readonly hideBelow?: ColumnHideBelow;
  readonly render: (row: T) => ReactNode;
}

export interface DataTableProps<T> {
  /** Announced caption. Describe the set, not the widget. */
  readonly caption: string;
  readonly columns: readonly DataTableColumn<T>[];
  readonly rows: readonly T[];
  readonly getRowId: (row: T) => string;
  readonly initialSort?: SortState | null;
  readonly renderExpanded?: (row: T) => ReactNode;
  readonly expandLabel?: (row: T) => string;
  readonly density?: 'default' | 'compact';
  /** Rendered in place of the table when there are no rows. */
  readonly empty?: ReactNode;
  /** Enables a bounded scroll area so the sticky header actually sticks. */
  readonly maxHeight?: number;
  readonly footer?: ReactNode;
  readonly ariaLabel?: string;
}

export function DataTable<T>({
  caption,
  columns,
  rows,
  getRowId,
  initialSort = null,
  renderExpanded,
  expandLabel,
  density = 'default',
  empty,
  maxHeight,
  footer,
  ariaLabel,
}: DataTableProps<T>) {
  const tableId = useId();
  const [sort, setSort] = useState<SortState | null>(initialSort);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set<string>());

  const sortedRows = useMemo(() => {
    if (sort === null) {
      return [...rows];
    }
    const column = columns.find((candidate) => candidate.key === sort.key);
    if (column === undefined || column.sortValue === undefined) {
      return [...rows];
    }
    return sortBy(rows, column.sortValue, sort.direction);
  }, [rows, sort, columns]);

  if (rows.length === 0 && empty !== undefined) {
    return <>{empty}</>;
  }

  const hasExpander = renderExpanded !== undefined;
  const totalColumns = columns.length + (hasExpander ? 1 : 0);

  return (
    <>
      <div
        className="iz-table-scroll"
        role="region"
        tabIndex={0}
        aria-label={ariaLabel ?? `${caption}, scrollable`}
        style={maxHeight !== undefined ? { maxHeight: `${maxHeight}px` } : undefined}
      >
        <table className="iz-table" data-density={density}>
        <caption className="iz-sr-only">{caption}</caption>
        <thead>
          <tr>
            {hasExpander ? (
              <th scope="col" style={{ width: '32px' }}>
                <span className="iz-sr-only">Details</span>
              </th>
            ) : null}
            {columns.map((column) => {
              const sortable = column.sortValue !== undefined;
              const active = sort?.key === column.key ? sort.direction : null;
              return (
                <th
                  key={column.key}
                  scope="col"
                  aria-sort={sortable ? ariaSort(active) : undefined}
                  data-align={column.align === 'right' ? 'right' : column.align === 'center' ? 'center' : undefined}
                  style={column.width !== undefined ? { width: column.width } : undefined}
                  className={
                    column.hideBelow !== undefined ? `iz-col-${column.hideBelow}` : undefined
                  }
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
          {sortedRows.map((row, rowIndex) => {
            const rowId = getRowId(row);
            const open = expanded.has(rowId);
            const detailId = `${tableId}-detail-${rowIndex}`;
            return (
              <Fragment key={rowId}>
                <tr data-expanded={open ? 'true' : undefined}>
                  {hasExpander ? (
                    <td>
                      <button
                        type="button"
                        className="iz-table__toggle"
                        aria-expanded={open}
                        aria-controls={detailId}
                        aria-label={
                          expandLabel !== undefined
                            ? expandLabel(row)
                            : open
                              ? 'Collapse row'
                              : 'Expand row'
                        }
                        onClick={() =>
                          setExpanded((current) => {
                            const next = new Set(current);
                            if (next.has(rowId)) {
                              next.delete(rowId);
                            } else {
                              next.add(rowId);
                            }
                            return next;
                          })
                        }
                      >
                        <Icon name={open ? 'chevron-down' : 'chevron-right'} size={12} />
                      </button>
                    </td>
                  ) : null}
                  {columns.map((column) => (
                    <td
                      key={column.key}
                      data-align={
                        column.align === 'right' ? 'right' : column.align === 'center' ? 'center' : undefined
                      }
                      className={
                        column.hideBelow !== undefined ? `iz-col-${column.hideBelow}` : undefined
                      }
                    >
                      {column.render(row)}
                    </td>
                  ))}
                </tr>
                {hasExpander && open ? (
                  <tr className="iz-table__detail">
                    <td colSpan={totalColumns} id={detailId}>
                      {renderExpanded(row)}
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      </div>
      {footer !== undefined ? <div className="iz-panel__foot">{footer}</div> : null}
    </>
  );
}
