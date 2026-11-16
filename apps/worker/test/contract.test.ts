import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { activities } from '../src/activities';
import { TASK_QUEUE, WORKFLOW_ID_PREFIX, WORKFLOW_TYPE } from '../src/config';

/**
 * Contract §16 drift guard.
 *
 * The API and the worker agree on four literals and **ten** activity names. Nothing in the
 * type system connects them — the API holds its own copy on purpose, so that neither
 * package drags the other's dependencies in. The failure mode of a typo is a task stuck
 * in the queue with no activity to pick it up, discovered at runtime, once.
 *
 * Six of the ten are the original task lifecycle. The other four are the **Phase 8.6
 * extension**: `loadProgrammeActivity`, `reserveProgrammeTaskActivity`,
 * `recordProgrammeCheckpointActivity` and `finishProgrammeActivity`, which let a parent
 * `runProgrammeWorkflow` dispatch child task workflows and record what it observed
 * (`docs/engineering/PHASE-2-CONTRACT.md` §16, "Phase 8.6 extension").
 *
 * Adding an activity **is** a contract change. That is precisely why the assertion below
 * is exact-match: a name registered in the worker without a corresponding contract update
 * fails here, instead of drifting into production where the only symptom is a workflow
 * task that is scheduled and never picked up.
 *
 * These are cheap assertions on purpose. They are not a substitute for the end-to-end
 * run; they are the thing that fails first when someone renames a function.
 */

const WORKFLOW_SOURCE = fileURLToPath(new URL('../src/workflows/run-task.ts', import.meta.url));

const PROGRAMME_WORKFLOW_SOURCE = fileURLToPath(
  new URL('../src/workflows/run-programme.ts', import.meta.url),
);

const CONTRACT_ACTIVITIES = [
  // §16, the task lifecycle.
  'validateTaskActivity',
  'recordStartActivity',
  'executeAgentActivity',
  'persistResultActivity',
  'emitEventActivity',
  'completeTaskActivity',
  // §16 Phase 8.6 extension — the programme parent's four.
  'loadProgrammeActivity',
  'reserveProgrammeTaskActivity',
  'recordProgrammeCheckpointActivity',
  'finishProgrammeActivity',
] as const;

describe('workflow interface contract (§16)', () => {
  it('uses the exact literals the API starts runs with', () => {
    expect(WORKFLOW_TYPE).toBe('runTaskWorkflow');
    expect(TASK_QUEUE).toBe('intelligenz-tasks');
    expect(WORKFLOW_ID_PREFIX).toBe('task-');
  });

  it('registers exactly the ten contract activities, all callable', () => {
    expect(Object.keys(activities).sort()).toEqual([...CONTRACT_ACTIVITIES].sort());

    for (const name of CONTRACT_ACTIVITIES) {
      expect(activities[name], `${name} must be registered`).toBeTypeOf('function');
      // Every activity takes exactly one input object and returns a promise.
      expect(activities[name].length, `${name} must take one input object`).toBe(1);
    }
  });
});

describe('workflow determinism (ADR-003 sandbox rules)', () => {
  it('imports only the workflow SDK and type-only modules', async () => {
    // Both workflows are bundled together (`workflows/index.ts`), so the sandbox rules
    // apply to both: a value import of Prisma or `node:fs` in either one is a replay
    // failure, not a compile error.
    const workflows = [
      { file: 'run-task.ts', path: WORKFLOW_SOURCE },
      { file: 'run-programme.ts', path: PROGRAMME_WORKFLOW_SOURCE },
    ] as const;

    const forbiddenValueImports = [
      "from '@intelligenz/database'",
      "from '@intelligenz/agent-runtime'",
      "from 'node:",
      "from '@prisma/",
      "from '../activities'",
      "from '../runtime'",
      "from './activities'",
      "from './runtime'",
      'require(',
    ];

    for (const workflow of workflows) {
      const source = await readFile(workflow.path, 'utf8');
      const importLines = source
        .split('\n')
        .filter((line) => line.startsWith('import ') || line.startsWith("} from '"));

      for (const line of importLines) {
        // `import type` is erased by the compiler; a value import of these would be a
        // sandbox failure at replay time, not a compile error.
        if (line.startsWith('import type')) continue;

        for (const forbidden of forbiddenValueImports) {
          expect(
            line.includes(forbidden),
            `${workflow.file} must not value-import ${forbidden}: ${line}`,
          ).toBe(false);
        }
      }
    }
  });

  it('never reads the clock or the random source directly', async () => {
    const source = await readFile(WORKFLOW_SOURCE, 'utf8');
    // Comments may quote the rule ("there is no `Date.now()`"); only code counts.
    const code = stripComments(source);

    expect(code.includes('Date.now(')).toBe(false);
    expect(code.includes('Math.random(')).toBe(false);

    // Exactly one date construction, and it is the replay-safe one.
    const dateConstructions = code.match(/new Date\(/g) ?? [];
    expect(dateConstructions).toHaveLength(1);
    expect(code.includes('new Date(workflowInfo().unsafe.now())')).toBe(true);
  });

  it('the programme workflow reads time only through workflowInfo()', async () => {
    const code = stripComments(await readFile(PROGRAMME_WORKFLOW_SOURCE, 'utf8'));

    expect(code.includes('Date.now(')).toBe(false);
    expect(code.includes('Math.random(')).toBe(false);

    // No date is constructed at all: the deadline arrives as an ISO string in the input
    // (so Continue-As-New keeps the same budget) and `Date.parse` reads it.
    expect(code.match(/new Date\(/g) ?? []).toHaveLength(0);
    expect(code.includes('Date.parse(input.deadlineAt)')).toBe(true);
    expect(code.includes('workflowInfo().unsafe.now()')).toBe(true);
  });

  it('uses the corrected cancel signature, not an execution handle', async () => {
    const activitiesSource = await readFile(
      fileURLToPath(new URL('../src/activities/execute-agent.ts', import.meta.url)),
      'utf8',
    );

    // Contract §15 A4: `cancel(taskId)`. `execute()` never returns a handle.
    expect(activitiesSource.includes('runtime.cancel(task.id)')).toBe(true);
  });
});

/** Removes block and line comments so a rule quoted in prose is not a false positive. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}
