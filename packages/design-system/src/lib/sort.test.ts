import { describe, expect, it } from 'vitest';

import { ariaSort, compareValues, nextSortState, sortBy } from './sort';

/**
 * Sorting and `aria-sort` come from the same state object, so these cases cover
 * both the order and the announcement (DESIGN.md §12.3, Overview §10).
 *
 * No DOM assertions: `@testing-library/react` is not in the lockfile, so the
 * DataTable's `aria-sort` attribute is not rendered in a test. What is tested is
 * the function that produces the value the attribute is set from — a wrong
 * mapping there is the bug that would ship.
 */
interface Row {
  readonly id: string;
  readonly cost: number | null;
  readonly name: string;
}

const rows: readonly Row[] = [
  { id: 'a', cost: 2.14, name: 'Rotate refresh tokens' },
  { id: 'b', cost: null, name: 'Audit contrast' },
  { id: 'c', cost: 0.44, name: 'Generate Q4 report' },
];

describe('ariaSort', () => {
  it('maps direction to the ARIA vocabulary', () => {
    expect(ariaSort('asc')).toBe('ascending');
    expect(ariaSort('desc')).toBe('descending');
  });

  it('reports none for an unsorted or non-sortable column', () => {
    expect(ariaSort(null)).toBe('none');
  });
});

describe('nextSortState', () => {
  it('starts ascending on a new column', () => {
    expect(nextSortState(null, 'name')).toEqual({ key: 'name', direction: 'asc' });
  });

  it('honours a column default direction', () => {
    expect(nextSortState(null, 'updated', 'desc')).toEqual({ key: 'updated', direction: 'desc' });
  });

  it('toggles the active column', () => {
    expect(nextSortState({ key: 'name', direction: 'asc' }, 'name')).toEqual({
      key: 'name',
      direction: 'desc',
    });
    expect(nextSortState({ key: 'name', direction: 'desc' }, 'name')).toEqual({
      key: 'name',
      direction: 'asc',
    });
  });

  it('resets to the default when the column changes', () => {
    expect(nextSortState({ key: 'name', direction: 'desc' }, 'cost')).toEqual({
      key: 'cost',
      direction: 'asc',
    });
  });
});

describe('compareValues', () => {
  it('sorts numeric values numerically, not lexically', () => {
    // 10 < 9 as strings; this is the bug being prevented.
    expect(compareValues(9, 10)).toBeLessThan(0);
  });

  it('sorts strings case-insensitively', () => {
    expect(compareValues('alpha', 'Beta')).toBeLessThan(0);
  });

  it('puts null last in both directions', () => {
    expect(compareValues(null, 1)).toBeGreaterThan(0);
    expect(compareValues(1, null)).toBeLessThan(0);
    expect(compareValues(null, null)).toBe(0);
  });
});

describe('sortBy', () => {
  it('keeps not-reported values last ascending', () => {
    const sorted = sortBy(rows, (row) => row.cost, 'asc');
    expect(sorted.map((row) => row.id)).toEqual(['c', 'a', 'b']);
  });

  it('keeps not-reported values last descending too', () => {
    const sorted = sortBy(rows, (row) => row.cost, 'desc');
    expect(sorted.map((row) => row.id)).toEqual(['a', 'c', 'b']);
  });

  it('is stable for equal keys', () => {
    const equal: readonly Row[] = [
      { id: 'x', cost: 1, name: 'same' },
      { id: 'y', cost: 1, name: 'same' },
      { id: 'z', cost: 1, name: 'same' },
    ];
    expect(sortBy(equal, (row) => row.cost, 'asc').map((row) => row.id)).toEqual(['x', 'y', 'z']);
  });

  it('does not mutate the input array', () => {
    const input: readonly Row[] = [...rows];
    sortBy(input, (row) => row.name, 'asc');
    expect(input.map((row) => row.id)).toEqual(['a', 'b', 'c']);
  });
});
