/**
 * Table sorting primitives. Pure, DOM-free, unit-tested.
 *
 * The table is the product (DESIGN.md §2: "a run is a row in a ledger"), so its
 * ordering rules are library code rather than inline handlers: nulls sort last
 * in both directions, the sort is stable, and the aria vocabulary is produced
 * from the same state that produces the order.
 */

export type SortDirection = 'asc' | 'desc';
export type AriaSort = 'ascending' | 'descending' | 'none';

export type SortValue = string | number | null;

export interface SortState {
  readonly key: string;
  readonly direction: SortDirection;
}

/** Longest visible label wins, so `aria-sort` is never guessed at the call site. */
export function ariaSort(direction: SortDirection | null): AriaSort {
  if (direction === 'asc') {
    return 'ascending';
  }
  if (direction === 'desc') {
    return 'descending';
  }
  return 'none';
}

/**
 * Null is "not reported", not zero. `compareValues` treats it as larger than any
 * value; `sortBy` additionally pins it last in *both* directions, so an empty
 * cell never heads a descending cost column.
 */
export function compareValues(a: SortValue, b: SortValue): number {
  if (a === null && b === null) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  if (typeof a === 'number' && typeof b === 'number') {
    return a === b ? 0 : a < b ? -1 : 1;
  }
  const left = String(a).toLowerCase();
  const right = String(b).toLowerCase();
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

/** Stable sort: equal keys keep their incoming order, nulls always last. */
export function sortBy<T>(
  rows: readonly T[],
  getValue: (row: T) => SortValue,
  direction: SortDirection,
): T[] {
  const indexed = rows.map((row, index) => ({ row, index }));
  indexed.sort((left, right) => {
    const leftValue = getValue(left.row);
    const rightValue = getValue(right.row);
    // Direction is applied to values only: a missing value is not "smallest".
    if (leftValue === null || rightValue === null) {
      if (leftValue === null && rightValue === null) {
        return left.index - right.index;
      }
      return leftValue === null ? 1 : -1;
    }
    const compared = compareValues(leftValue, rightValue);
    if (compared !== 0) {
      return direction === 'asc' ? compared : -compared;
    }
    return left.index - right.index;
  });
  return indexed.map((entry) => entry.row);
}

/**
 * Clicking a new column starts at `defaultDirection` (descriptions of severity
 * read worst-first); clicking the active column toggles.
 */
export function nextSortState(
  current: SortState | null,
  key: string,
  defaultDirection: SortDirection = 'asc',
): SortState {
  if (current !== null && current.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' };
  }
  return { key, direction: defaultDirection };
}
