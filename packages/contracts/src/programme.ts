import { z } from 'zod';

/**
 * The programme execution state: a schema, and a validator that rejects malformed state.
 *
 * ## Why this is code and not a table in a markdown file
 *
 * Phase 7 and Phase 8 both lost time to the same failure: a document claimed something
 * the repository did not contain. `PHASE7-GATE-MATRIX.md` R-21 cited `GATE-M-SUMMARY.md`
 * and `EVIDENCE-INDEX-PHASE7.md`; neither was ever written. A hand-maintained status
 * document drifts in exactly the directions that are convenient — a task marked done while
 * its dependency is still open, a "pending" list that keeps a completed task alive, a task
 * referencing an ID that was renamed. None of those are visible on a read-through.
 *
 * So the state is JSON with a schema that is **checkable**, and the checks are the ones the
 * drift takes: unknown status, a dependency on a task that does not exist, a task listed in
 * both `pendingTasks` and `completedTasks`, a status that contradicts the list it is in,
 * and timestamps that move backwards. `validateProgrammeState` returns every violation with
 * a path, and the JSON is not "valid because it is committed" — it is valid because the test
 * suite parses the shipped file with this schema.
 *
 * ## What the schema does *not* claim
 *
 * It cannot tell whether a task's status is *true* — an honest `completed` and a dishonest
 * one are the same four fields. Evidence is the separate column, and each task names the
 * artefact that would have to exist. The schema's job is to make the structure impossible
 * to lie in, and to leave the substance in the evidence requirement.
 */

/** A stable task id: `P<2-digit phase>-<3-digit sequence>`, e.g. `P83-001`. */
export const PROGRAMME_TASK_ID = /^P\d{2}-\d{3}$/;

/**
 * Statuses. Terminal ones end a task's life; `completed` is the only one that belongs in
 * `completedTasks`. `abandoned` and `superseded` are terminal but not completed: they
 * appear in neither list, which is what keeps "done" from silently including "gave up".
 */
export const PROGRAMME_TASK_STATUSES = [
  'planned',
  'ready',
  'in-progress',
  'blocked',
  'completed',
  'abandoned',
  'superseded',
] as const;

export type ProgrammeTaskStatus = (typeof PROGRAMME_TASK_STATUSES)[number];

const OPEN_STATUSES: readonly ProgrammeTaskStatus[] = ['planned', 'ready', 'in-progress', 'blocked'];

export function isOpenProgrammeStatus(status: ProgrammeTaskStatus): boolean {
  return OPEN_STATUSES.includes(status);
}

export function isTerminalProgrammeStatus(status: ProgrammeTaskStatus): boolean {
  return !isOpenProgrammeStatus(status);
}

/** Risk class drives how much evidence a task needs, not how urgent it is. */
export const PROGRAMME_RISK_CLASSES = ['critical', 'high', 'moderate', 'low'] as const;

export type ProgrammeRiskClass = (typeof PROGRAMME_RISK_CLASSES)[number];

export const EVIDENCE_KINDS = ['test', 'measurement', 'document', 'review', 'attestation'] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/**
 * ISO-8601 with a timezone. Parsed, not merely matched: `2026-13-45T99:99:99Z` matches a
 * loose regex and is not a timestamp, and a document whose dates cannot be ordered cannot
 * be checked for moving backwards.
 */
const isoDateTime = z.string().refine(
  (value) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value)),
  { message: 'must be an ISO-8601 timestamp with a timezone, e.g. 2026-11-16T06:00:00.000Z' },
);

/**
 * Credential shapes. The state file is committed, so a token pasted into a rationale is a
 * disclosure, not a formatting issue. The patterns are deliberately narrow: a false
 * positive costs a reworded sentence, a false negative costs a credential.
 */
const CREDENTIAL_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'OpenAI-style key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'Slack token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'AWS access key id', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'private key block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'bearer token', pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/ },
  {
    name: 'database URL with a password',
    pattern: /\b(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^:\s/]+:[^@\s]+@/,
  },
];

const taskId = z.string().regex(PROGRAMME_TASK_ID, {
  message: 'must match P<2-digit phase>-<3-digit sequence>, e.g. P83-001',
});

const executionPolicy = z.strictObject({
  /** `fail-closed` means the gate refuses to run; `advisory` means it reports only. */
  enforcement: z.enum(['fail-closed', 'advisory']),
  /** The gate or check that carries the policy, by name. `none` when there is no code gate. */
  gate: z.string().min(3),
  /** Why this enforcement level, in one sentence. */
  rationale: z.string().min(20),
});

const evidenceRequirement = z.strictObject({
  kind: z.enum(EVIDENCE_KINDS),
  /**
   * The artefact that must exist for a `completed` status to be believable: a test file, a
   * document, a measurement record. A path, not a description of a path.
   */
  artifact: z.string().min(3),
  note: z.string().min(8).optional(),
});

export const programmeTask = z.strictObject({
  id: taskId,
  title: z.string().min(8).max(180),
  phase: z.string().regex(/^\d+(?:\.\d+)?$/, { message: 'must be 8 or 8.3, not "Phase 8"' }),
  dependsOn: z.array(taskId),
  riskClass: z.enum(PROGRAMME_RISK_CLASSES),
  executionPolicy,
  acceptanceCriteria: z.array(z.string().min(12)).min(1),
  evidenceRequirement,
  /** The role or agent accountable. A name, never "the team". */
  owner: z.string().min(2).max(60),
  status: z.enum(PROGRAMME_TASK_STATUSES),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export type ProgrammeTask = z.infer<typeof programmeTask>;

const historyEntry = z.strictObject({
  at: isoDateTime,
  summary: z.string().min(10),
  evidence: z.array(z.string().min(3)).min(1),
});

export const programmeState = z
  .strictObject({
    schemaVersion: z.literal(1),
    programme: z.literal('INTELLIGENZ'),
    branch: z.string().min(1),
    head: z.string().regex(/^[0-9a-f]{40}$/, { message: 'must be a full 40-character commit sha' }),
    phase: z.string().regex(/^\d+(?:\.\d+)?$/),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
    tasks: z.array(programmeTask).min(1),
    pendingTasks: z.array(taskId),
    completedTasks: z.array(taskId),
    history: z.array(historyEntry).min(1),
  })
  .superRefine((state, ctx) => {
    const ids = new Set<string>();
    const byId = new Map<string, ProgrammeTask>();

    // ── Ids: unique, and a dependency must point at one of them ────────────────
    state.tasks.forEach((task, index) => {
      if (ids.has(task.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', index, 'id'],
          message: `duplicate task id "${task.id}"`,
        });
        return;
      }

      ids.add(task.id);
      byId.set(task.id, task);
    });

    state.tasks.forEach((task, index) => {
      task.dependsOn.forEach((dependency, dependencyIndex) => {
        if (dependency === task.id) {
          ctx.addIssue({
            code: 'custom',
            path: ['tasks', index, 'dependsOn', dependencyIndex],
            message: `task "${task.id}" depends on itself`,
          });
          return;
        }

        if (!ids.has(dependency)) {
          ctx.addIssue({
            code: 'custom',
            path: ['tasks', index, 'dependsOn', dependencyIndex],
            message: `depends on "${dependency}", which is not a task in this file`,
          });
        }
      });
    });

    for (const [taskIdValue, cycle] of findDependencyCycles(byId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['tasks', state.tasks.findIndex((task) => task.id === taskIdValue), 'dependsOn'],
        message: `dependency cycle: ${cycle.join(' -> ')}`,
      });
    }

    // ── The two lists must agree with the statuses ─────────────────────────────
    //
    // This is the drift the directive names: a task that is `completed` but still sits in
    // `pendingTasks` reads as work remaining, and a task that is `in-progress` but listed
    // as completed reads as finished. Both are rejected, with both lists in the message so
    // the fix is obvious.
    for (const listName of ['pendingTasks', 'completedTasks'] as const) {
      const seen = new Set<string>();

      state[listName].forEach((id, index) => {
        if (seen.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: [listName, index],
            message: `"${id}" appears twice in ${listName}`,
          });
        }
        seen.add(id);

        if (!ids.has(id)) {
          ctx.addIssue({
            code: 'custom',
            path: [listName, index],
            message: `"${id}" is listed in ${listName} but is not a task in this file`,
          });
        }
      });
    }

    const pending = new Set(state.pendingTasks);
    const completed = new Set(state.completedTasks);

    for (const id of pending) {
      if (completed.has(id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pendingTasks'],
          message: `"${id}" is in both pendingTasks and completedTasks; a task is one or the other`,
        });
      }
    }

    state.tasks.forEach((task, index) => {
      const isCompleted = task.status === 'completed';
      const isOpen = isOpenProgrammeStatus(task.status);

      if (isCompleted && !completed.has(task.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', index, 'status'],
          message:
            `"${task.id}" has status "completed" but is missing from completedTasks` +
            (pending.has(task.id) ? ' and is present in pendingTasks' : ''),
        });
      }

      if (isCompleted && pending.has(task.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['pendingTasks'],
          message:
            `"${task.id}" has status "completed" but is present in pendingTasks; ` +
            'a finished task is missing from completedTasks and listed as outstanding',
        });
      }

      if (isOpen && completed.has(task.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['completedTasks'],
          message: `"${task.id}" has status "${task.status}" but is present in completedTasks`,
        });
      }

      if (isOpen && !pending.has(task.id)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', index, 'status'],
          message: `"${task.id}" has status "${task.status}" but is missing from pendingTasks`,
        });
      }

      if (isTerminalProgrammeStatus(task.status) && !isCompleted && (pending.has(task.id) || completed.has(task.id))) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', index, 'status'],
          message:
            `"${task.id}" is terminal ("${task.status}") and must appear in neither list; ` +
            'abandoned and superseded work is not completed work',
        });
      }
    });

    // ── Timestamps must not move backwards ────────────────────────────────────
    state.tasks.forEach((task, index) => {
      if (Date.parse(task.updatedAt) < Date.parse(task.createdAt)) {
        ctx.addIssue({
          code: 'custom',
          path: ['tasks', index, 'updatedAt'],
          message: `updatedAt ${task.updatedAt} precedes createdAt ${task.createdAt}`,
        });
      }
    });

    state.history.forEach((entry, index) => {
      const previous = state.history[index - 1];

      if (previous !== undefined && Date.parse(entry.at) < Date.parse(previous.at)) {
        ctx.addIssue({
          code: 'custom',
          path: ['history', index, 'at'],
          message: `history entry ${entry.at} precedes the previous entry ${previous.at}`,
        });
      }
    });

    if (Date.parse(state.updatedAt) < Date.parse(state.createdAt)) {
      ctx.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: `updatedAt ${state.updatedAt} precedes createdAt ${state.createdAt}`,
      });
    }

    const newestTask = state.tasks.reduce(
      (newest, task) => Math.max(newest, Date.parse(task.updatedAt)),
      Number.NEGATIVE_INFINITY,
    );

    if (Date.parse(state.updatedAt) < newestTask) {
      ctx.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message:
          `updatedAt ${state.updatedAt} is older than a task updated at ` +
          `${new Date(newestTask).toISOString()}; the document claims to predate its own contents`,
      });
    }

    const lastHistory = state.history.at(-1);

    if (lastHistory !== undefined && Date.parse(state.updatedAt) < Date.parse(lastHistory.at)) {
      ctx.addIssue({
        code: 'custom',
        path: ['updatedAt'],
        message: `updatedAt ${state.updatedAt} precedes the last history entry ${lastHistory.at}`,
      });
    }

    // ── No credentials in a committed document ────────────────────────────────
    for (const [path, value] of walkStrings(state)) {
      for (const { name, pattern } of CREDENTIAL_PATTERNS) {
        if (pattern.test(value)) {
          ctx.addIssue({
            code: 'custom',
            path: [...path],
            message: `looks like a ${name}; the state file is committed and must carry no credential values`,
          });
        }
      }
    }
  });

export type ProgrammeState = z.infer<typeof programmeState>;

export interface ProgrammeValidation {
  readonly ok: boolean;
  /** One line per violation, prefixed with its path. Empty exactly when `ok` is true. */
  readonly issues: readonly string[];
  /** Present only when `ok` is true. */
  readonly state?: ProgrammeState;
}

/**
 * Validate an already-parsed value. Returns issues rather than throwing, because a
 * validator's output is a report an operator reads — a thrown `ZodError` is a stack trace.
 */
export function validateProgrammeState(input: unknown): ProgrammeValidation {
  const result = programmeState.safeParse(input);

  if (result.success) {
    return { ok: true, issues: [], state: result.data };
  }

  return {
    ok: false,
    issues: result.error.issues.map((issue) => {
      const path = issue.path.length === 0 ? '(root)' : issue.path.join('.');
      return `${path}: ${issue.message}`;
    }),
  };
}

/** Ids that are open, derived — never hand-maintained. Used by the handoff generator. */
export function openTaskIds(state: ProgrammeState): readonly string[] {
  return state.tasks.filter((task) => isOpenProgrammeStatus(task.status)).map((task) => task.id);
}

function walkStrings(
  value: unknown,
  path: readonly (string | number)[] = [],
): readonly (readonly [readonly (string | number)[], string])[] {
  if (typeof value === 'string') return [[path, value]];
  if (Array.isArray(value)) {
    return value.flatMap((entry, index) => walkStrings(entry, [...path, index]));
  }
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([key, entry]) => walkStrings(entry, [...path, key]));
  }

  return [];
}

/**
 * Depth-first cycle detection over the `dependsOn` graph.
 *
 * A dependency cycle is not a crash — it is a plan that can never start, and it is
 * invisible in a JSON read-through. Returns one entry per task that closes a cycle.
 */
function findDependencyCycles(
  byId: ReadonlyMap<string, ProgrammeTask>,
): readonly (readonly [string, readonly string[]])[] {
  const cycles: (readonly [string, readonly string[]])[] = [];
  const state = new Map<string, 'visiting' | 'done'>();

  const visit = (id: string, stack: readonly string[]): void => {
    if (state.get(id) === 'done') return;

    if (state.get(id) === 'visiting') {
      const start = stack.indexOf(id);
      cycles.push([id, [...stack.slice(start), id]]);
      return;
    }

    state.set(id, 'visiting');

    for (const dependency of byId.get(id)?.dependsOn ?? []) {
      // A dependency on a missing task is reported by its own check; walking it here would
      // only duplicate the message.
      if (byId.has(dependency)) visit(dependency, [...stack, id]);
    }

    state.set(id, 'done');
  };

  for (const id of byId.keys()) {
    if (state.get(id) === undefined) visit(id, []);
  }

  return cycles;
}
