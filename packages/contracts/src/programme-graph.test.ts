import { describe, expect, it } from 'vitest';

import { validateProgrammeGraph, type ProgrammeGraphNode } from './programme-graph';

/**
 * The graph rules, as a table.
 *
 * These are the tests that make the scheduler's safety independent of who authored the
 * graph: the same function rejects a human's typo and a planner's cycle, and it needs no
 * database, no Temporal server and no model to do it.
 */

const criteria = ['The test suite passes.'];

function node(taskId: string, dependsOn: readonly string[] = []): ProgrammeGraphNode {
  return { taskId, dependsOn, acceptanceCriteria: criteria };
}

describe('validateProgrammeGraph', () => {
  it('accepts a linear chain and a diamond', () => {
    expect(validateProgrammeGraph([node('a'), node('b', ['a']), node('c', ['b'])]).ok).toBe(true);

    const diamond = validateProgrammeGraph([
      node('a'),
      node('b', ['a']),
      node('c', ['a']),
      node('d', ['b', 'c']),
    ]);

    expect(diamond.ok).toBe(true);
    expect(diamond.issues).toEqual([]);
  });

  it('rejects an empty programme', () => {
    const result = validateProgrammeGraph([]);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['empty']);
  });

  it('rejects a duplicate task id, once', () => {
    const result = validateProgrammeGraph([node('a'), node('a')]);

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]).toMatchObject({ code: 'duplicate_task', taskId: 'a' });
  });

  it('rejects a self-dependency separately from a cycle', () => {
    const result = validateProgrammeGraph([node('a', ['a'])]);

    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(['self_dependency']);
  });

  it('rejects a dependency on a task outside the programme', () => {
    const result = validateProgrammeGraph([node('a'), node('b', ['missing'])]);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'unknown_dependency', taskId: 'b' }),
    ]);
  });

  it('rejects a cycle and names the path', () => {
    const result = validateProgrammeGraph([node('a', ['c']), node('b', ['a']), node('c', ['b'])]);

    expect(result.ok).toBe(false);
    const cycle = result.issues.find((issue) => issue.code === 'cycle');

    expect(cycle?.message).toContain('a → c → b → a');
  });

  it('rejects a node with no acceptance criteria', () => {
    const result = validateProgrammeGraph([
      node('a'),
      { taskId: 'b', dependsOn: ['a'], acceptanceCriteria: [] },
    ]);

    expect(result.ok).toBe(false);
    expect(result.issues).toEqual([
      expect.objectContaining({ code: 'missing_acceptance_criteria', taskId: 'b' }),
    ]);
  });

  it('tolerates a dependency listed twice — the same edge, not a second one', () => {
    expect(validateProgrammeGraph([node('a'), node('b', ['a', 'a'])]).ok).toBe(true);
  });

  it('reports every issue in one pass instead of stopping at the first', () => {
    const result = validateProgrammeGraph([
      node('a', ['a']),
      { taskId: 'b', dependsOn: ['ghost'], acceptanceCriteria: [] },
    ]);

    expect(result.ok).toBe(false);
    expect(new Set(result.issues.map((issue) => issue.code))).toEqual(
      new Set(['self_dependency', 'unknown_dependency', 'missing_acceptance_criteria']),
    );
  });
});
