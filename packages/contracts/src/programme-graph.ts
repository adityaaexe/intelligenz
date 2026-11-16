/**
 * Programme graph validation — the one function that decides whether a set of tasks may
 * be scheduled as a programme.
 *
 * ## Why this is shared, pure and zod-free
 *
 * Two callers must agree: `POST /programmes` (which refuses a bad graph before persisting
 * anything) and `runProgrammeWorkflow` (which refuses a bad graph before dispatching
 * anything — a workflow can be started directly, and the parent must not rely on the API
 * having been the caller).
 *
 * The function therefore has no I/O, no clock and no dependency beyond the language. It
 * takes nodes and returns issues. That is also what makes it unit-testable without a
 * database, a Temporal server or a model: the question "is this graph schedulable" has an
 * answer that does not depend on who wrote the graph. A planner — human today, LLM later —
 * is validated by the same rules, which is why the contract can be built before the
 * planner exists.
 *
 * ## What it rejects, and why each one is a refusal rather than a repair
 *
 *   - **no tasks** — a programme with nothing to do would report `succeeded` having done
 *     nothing, which is the most misleading outcome available.
 *   - **duplicate task id** — one task cannot occupy two nodes; the second dependency edge
 *     would silently decide which node runs.
 *   - **self-dependency** — `A → A` is unsatisfiable. Reported separately from `cycle`
 *     because the fix is different (delete one field vs. rethink the graph).
 *   - **dependency on a task outside the programme** — a missing edge means the node would
 *     either run too early (if the dep was meant to exist) or never run (if not).
 *   - **cycle** — a plan that can never start and never finishes. Invisible in a JSON
 *     read-through, so it is checked.
 *   - **no acceptance criteria** — the task workflow will run it, and nothing will define
 *     what "done" means. `Task.acceptanceCriteria` is a `text[]` that the API already
 *     accepts empty, so this is a real state a submission can arrive in.
 *
 * Duplicate entries *inside* `dependsOn` are tolerated: `["A", "A"]` is the same edge twice
 * and changes no schedule. Rejecting it would be taste, not safety.
 */

/** The facts about one node that the scheduler cares about. */
export interface ProgrammeGraphNode {
  /** The `Task.id`. Dependencies are expressed in this same id space. */
  readonly taskId: string;
  /** Task ids this node waits for. */
  readonly dependsOn: readonly string[];
  /** The task's acceptance criteria, read from the row at submission time. */
  readonly acceptanceCriteria: readonly string[];
}

export type ProgrammeGraphIssueCode =
  | 'empty'
  | 'duplicate_task'
  | 'self_dependency'
  | 'unknown_dependency'
  | 'cycle'
  | 'missing_acceptance_criteria';

export interface ProgrammeGraphIssue {
  readonly code: ProgrammeGraphIssueCode;
  /** The node the issue belongs to; `null` only for an issue about the graph itself. */
  readonly taskId: string | null;
  /** One sentence, addressed to whoever authored the graph. */
  readonly message: string;
}

export interface ProgrammeGraphValidation {
  /** True exactly when `issues` is empty. */
  readonly ok: boolean;
  readonly issues: readonly ProgrammeGraphIssue[];
}

/**
 * Validate a graph. Returns every issue rather than the first, because a client fixing a
 * submitted plan wants the whole list — and because a short-circuiting validator makes the
 * second problem invisible until the first is fixed.
 */
export function validateProgrammeGraph(
  nodes: readonly ProgrammeGraphNode[],
): ProgrammeGraphValidation {
  const issues: ProgrammeGraphIssue[] = [];

  if (nodes.length === 0) {
    return {
      ok: false,
      issues: [
        { code: 'empty', taskId: null, message: 'A programme must contain at least one task.' },
      ],
    };
  }

  const byId = new Map<string, ProgrammeGraphNode>();

  for (const node of nodes) {
    if (byId.has(node.taskId)) {
      issues.push({
        code: 'duplicate_task',
        taskId: node.taskId,
        message: `Task ${node.taskId} appears more than once in this programme.`,
      });
      continue;
    }

    byId.set(node.taskId, node);
  }

  for (const node of nodes) {
    for (const dependency of new Set(node.dependsOn)) {
      if (dependency === node.taskId) {
        issues.push({
          code: 'self_dependency',
          taskId: node.taskId,
          message: `Task ${node.taskId} depends on itself.`,
        });
        continue;
      }

      if (!byId.has(dependency)) {
        issues.push({
          code: 'unknown_dependency',
          taskId: node.taskId,
          message:
            `Task ${node.taskId} depends on ${dependency}, which is not a task in this ` +
            'programme.',
        });
      }
    }
  }

  for (const cycle of findCycles(byId)) {
    issues.push({
      code: 'cycle',
      taskId: cycle[0] ?? null,
      message: `Dependency cycle: ${cycle.join(' → ')}. A programme cannot start from a cycle.`,
    });
  }

  // Only for nodes that exist once: a duplicate id's criteria were already checked on its
  // first occurrence, and repeating the complaint adds noise, not information.
  for (const node of byId.values()) {
    if (node.acceptanceCriteria.length === 0) {
      issues.push({
        code: 'missing_acceptance_criteria',
        taskId: node.taskId,
        message:
          `Task ${node.taskId} has no acceptance criteria. A task with nothing to check ` +
          'cannot be judged succeeded.',
      });
    }
  }

  return { ok: issues.length === 0, issues };
}

/**
 * Cycle detection by depth-first search, one entry per cycle found.
 *
 * Iteration order is the submission order, so the message a client sees is stable across
 * runs — a validation error that reorders itself is hard to talk about.
 */
function findCycles(byId: ReadonlyMap<string, ProgrammeGraphNode>): readonly (readonly string[])[] {
  const cycles: (readonly string[])[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (taskId: string, stack: readonly string[]): void => {
    if (state.get(taskId) === 'done') return;

    if (state.get(taskId) === 'visiting') {
      const start = stack.indexOf(taskId);
      cycles.push([...stack.slice(start), taskId]);
      return;
    }

    state.set(taskId, 'visiting');

    for (const dependency of byId.get(taskId)?.dependsOn ?? []) {
      // A self-dependency is unsatisfiable but it is not a *cycle between nodes*: it is
      // reported by its own check, and walking it here would report one fault twice.
      if (dependency === taskId) continue;

      // A dependency on a task outside the programme has its own issue; walking it here
      // would only duplicate the message.
      if (byId.has(dependency)) visit(dependency, [...stack, taskId]);
    }

    state.set(taskId, 'done');
  };

  for (const taskId of byId.keys()) {
    if (state.get(taskId) === undefined) visit(taskId, []);
  }

  return cycles;
}
