import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  isOpenProgrammeStatus,
  isTerminalProgrammeStatus,
  openTaskIds,
  validateProgrammeState,
  type ProgrammeState,
} from './programme';

/**
 * The programme state rejects malformed state — and the shipped file is one of the inputs.
 *
 * A schema that only ever sees a valid document proves nothing: every one of these cases
 * was reachable by hand-editing `EXECUTION-STATE.json`, and the document would still have
 * parsed as JSON and still have looked like a plan. So the cases below are the drifts that
 * actually happen — a renamed dependency, a task moved to `completed` without moving its
 * id, a `updatedAt` that predates `createdAt` because the date was retyped — and the last
 * test parses the committed file with the same schema, which is what makes the file
 * "validated" rather than "checked in".
 */

type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;
interface JsonObject {
  [key: string]: JsonValue;
}

const EVIDENCE = 'apps/worker/test/execution-enforcement.test.ts';

function fixtureTask(id: string, status: string, dependsOn: readonly string[] = []): JsonObject {
  return {
    id,
    title: `Task ${id} with a title long enough to pass`,
    phase: '8.3',
    dependsOn: [...dependsOn],
    riskClass: 'moderate',
    executionPolicy: {
      enforcement: 'fail-closed',
      gate: 'EXECUTION_ENFORCEMENT_UNAVAILABLE',
      rationale: 'A rationale that is comfortably over the minimum length.',
    },
    acceptanceCriteria: ['An acceptance criterion that is long enough to pass'],
    evidenceRequirement: { kind: 'test', artifact: EVIDENCE },
    owner: 'node-developer',
    status,
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T00:10:00.000Z',
  };
}

/** A minimal valid document: one completed task, one open task that depends on it. */
function fixture(): JsonObject {
  return {
    schemaVersion: 1,
    programme: 'INTELLIGENZ',
    branch: 'phase-6/trust-boundary-closure',
    head: 'a'.repeat(40),
    phase: '8.3',
    createdAt: '2026-11-16T00:00:00.000Z',
    updatedAt: '2026-11-16T02:00:00.000Z',
    tasks: [
      fixtureTask('P83-001', 'completed'),
      fixtureTask('P83-002', 'ready', ['P83-001']),
    ],
    pendingTasks: ['P83-002'],
    completedTasks: ['P83-001'],
    history: [
      {
        at: '2026-11-16T01:30:00.000Z',
        summary: 'seeded fixture for the schema rejection tests',
        evidence: [EVIDENCE],
      },
    ],
  };
}

function clone(): JsonObject {
  return structuredClone(fixture());
}

/** Dot-path assignment, so a case reads as the drift it describes. */
function set(root: JsonObject, path: string, value: JsonValue): JsonObject {
  const keys = path.split('.');
  let cursor: JsonValue = root;

  for (const key of keys.slice(0, -1)) {
    const container = cursor as JsonObject | JsonValue[];
    cursor = Array.isArray(container) ? container[Number(key)]! : container[key]!;
  }

  const last = keys.at(-1)!;
  const container = cursor as JsonObject | JsonValue[];

  if (Array.isArray(container)) container[Number(last)] = value;
  else container[last] = value;

  return root;
}

function expectRejected(state: JsonObject, expected: RegExp): void {
  const result = validateProgrammeState(state);

  expect(result.ok, 'the document was accepted but should have been rejected').toBe(false);
  expect(result.issues.join('\n')).toMatch(expected);
  // A rejection must say where, not only that. A validator whose output is one sentence
  // sends the reader back to the file to find the line themselves.
  expect(result.issues.every((issue) => issue.includes(':'))).toBe(true);
}

describe('the fixture and the shipped document are accepted', () => {
  it('accepts a well-formed state', () => {
    const result = validateProgrammeState(fixture());

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.state?.tasks).toHaveLength(2);
  });

  it('accepts docs/engineering/programme/EXECUTION-STATE.json', async () => {
    // The committed file is an input to the schema, not a comment beside it. If the two
    // drift, this test fails before a cold session reads a plan that cannot be trusted.
    const path = fileURLToPath(
      new URL('../../../docs/engineering/programme/EXECUTION-STATE.json', import.meta.url),
    );
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    const result = validateProgrammeState(parsed);

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);

    const state = result.state as ProgrammeState;
    expect(state.head).toMatch(/^[0-9a-f]{40}$/);
    expect(state.completedTasks.length).toBeGreaterThan(0);
    expect(state.pendingTasks.length).toBeGreaterThan(0);
  });
});

describe('status is a closed set', () => {
  it('rejects an unknown status', () => {
    expectRejected(set(clone(), 'tasks.1.status', 'in-progress-ish'), /status:/);
  });

  it('rejects a typo in the list name as an unknown key, not as silence', () => {
    // `.strict()` matters here: a misspelled `pendingTasks` would otherwise be stripped and
    // the open tasks would simply disappear from every derived count.
    const state = clone();
    state['pendingTask'] = state['pendingTasks']!;
    delete state['pendingTasks'];

    expectRejected(state, /pendingTasks/);
  });

  it('classifies every status as open or terminal, and never both', () => {
    for (const status of [
      'planned',
      'ready',
      'in-progress',
      'blocked',
      'completed',
      'abandoned',
      'superseded',
    ] as const) {
      expect(isOpenProgrammeStatus(status)).toBe(!isTerminalProgrammeStatus(status));
    }
  });
});

describe('dependencies must resolve and must terminate', () => {
  it('rejects a dependency on a task that does not exist', () => {
    expectRejected(
      set(clone(), 'tasks.1.dependsOn', ['P83-999']),
      /tasks\.1\.dependsOn\.0: depends on "P83-999", which is not a task in this file/,
    );
  });

  it('rejects a task that depends on itself', () => {
    expectRejected(set(clone(), 'tasks.0.dependsOn', ['P83-001']), /depends on itself/);
  });

  it('rejects a two-task cycle, which is a plan that can never start', () => {
    const state = set(clone(), 'tasks.0.dependsOn', ['P83-002']);

    expectRejected(state, /dependency cycle/);
  });

  it('rejects a duplicate task id', () => {
    const state = clone();
    (state['tasks'] as JsonValue[]).push(fixtureTask('P83-001', 'planned'));

    expectRejected(state, /duplicate task id "P83-001"/);
  });
});

describe('pendingTasks and completedTasks must agree with the statuses', () => {
  it('rejects a completed task that is missing from completedTasks and present in pendingTasks', () => {
    // The exact drift the directive names: the status says done, the lists say not done.
    const state = clone();
    state['completedTasks'] = [];
    state['pendingTasks'] = ['P83-001', 'P83-002'];

    const result = validateProgrammeState(state);

    expect(result.ok).toBe(false);
    expect(result.issues.join('\n')).toMatch(/missing from completedTasks and is present in pendingTasks/);
    expect(result.issues.join('\n')).toMatch(/present in pendingTasks; a finished task/);
  });

  it('rejects an open task listed as completed', () => {
    expectRejected(
      set(clone(), 'completedTasks', ['P83-001', 'P83-002']),
      /"P83-002" has status "ready" but is present in completedTasks/,
    );
  });

  it('rejects an open task that is missing from pendingTasks', () => {
    expectRejected(
      set(clone(), 'pendingTasks', []),
      /"P83-002" has status "ready" but is missing from pendingTasks/,
    );
  });

  it('rejects a completed task missing from completedTasks', () => {
    expectRejected(
      set(clone(), 'completedTasks', []),
      /"P83-001" has status "completed" but is missing from completedTasks/,
    );
  });

  it('rejects an id in either list that is not a task', () => {
    expectRejected(
      set(clone(), 'pendingTasks', ['P83-002', 'P83-404']),
      /"P83-404" is listed in pendingTasks but is not a task in this file/,
    );
  });

  it('rejects the same id twice in one list', () => {
    expectRejected(
      set(clone(), 'pendingTasks', ['P83-002', 'P83-002']),
      /appears twice in pendingTasks/,
    );
  });

  it('rejects abandoned work listed as pending or completed', () => {
    // Terminal is not the same as completed. If "gave up" could sit in `pendingTasks`, the
    // open count would never reach zero and nobody would notice; if it could sit in
    // `completedTasks`, giving up would read as finishing.
    const state = set(clone(), 'tasks.1.status', 'abandoned');

    expectRejected(state, /must appear in neither list/);
  });
});

describe('timestamps must not move backwards', () => {
  it('rejects a task updated before it was created', () => {
    expectRejected(
      set(clone(), 'tasks.0.updatedAt', '2026-11-15T23:00:00.000Z'),
      /updatedAt .* precedes createdAt/,
    );
  });

  it('rejects a document older than one of its tasks', () => {
    expectRejected(
      set(clone(), 'updatedAt', '2026-11-16T00:05:00.000Z'),
      /older than a task updated at/,
    );
  });

  it('rejects history that goes backwards', () => {
    const state = clone();
    (state['history'] as JsonValue[]).push({
      at: '2026-11-16T00:20:00.000Z',
      summary: 'an entry that was inserted before an earlier one',
      evidence: [EVIDENCE],
    });

    expectRejected(state, /history entry .* precedes the previous entry/);
  });

  it('rejects updatedAt before createdAt', () => {
    expectRejected(set(clone(), 'createdAt', '2026-11-16T03:00:00.000Z'), /precedes createdAt/);
  });

  it('rejects a date that matches the regex but is not a date', () => {
    expectRejected(
      set(clone(), 'tasks.0.createdAt', '2026-13-45T99:99:99Z'),
      /ISO-8601 timestamp/,
    );
  });
});

describe('no credential values', () => {
  it('rejects a provider key in a rationale', () => {
    expectRejected(
      set(
        clone(),
        'tasks.0.executionPolicy.rationale',
        'Leaked by accident: sk-abcdefghijklmnopqrstuvwxyz0123',
      ),
      /looks like a OpenAI-style key|looks like a .*key/,
    );
  });

  it('rejects a database URL with a password', () => {
    expectRejected(
      set(
        clone(),
        'tasks.0.acceptanceCriteria',
        ['It connects using postgresql://intelligenz:hunter2@localhost:5432/db'],
      ),
      /database URL with a password/,
    );
  });

  it('rejects a private key block', () => {
    expectRejected(
      set(clone(), 'tasks.0.owner', '-----BEGIN RSA PRIVATE KEY-----'),
      /private key block/,
    );
  });

  it('does not reject ordinary prose that mentions a credential by name', () => {
    // The patterns are shapes, not words. A sentence about credentials is the normal case
    // in this document and must not be flagged.
    const state = set(
      clone(),
      'tasks.0.executionPolicy.rationale',
      'The broker holds the credential; the worker never reads a token or a private key.',
    );

    expect(validateProgrammeState(state).ok).toBe(true);
  });
});

describe('document identity', () => {
  it('rejects a short or non-hex commit sha', () => {
    expectRejected(set(clone(), 'head', '1cf3c58'), /40-character commit sha/);
    expectRejected(set(clone(), 'head', 'z'.repeat(40)), /40-character commit sha/);
  });

  it('rejects an unknown schema version rather than guessing', () => {
    expectRejected(set(clone(), 'schemaVersion', 2), /schemaVersion/);
  });

  it('rejects a task id that is not stable-format', () => {
    expectRejected(
      set(clone(), 'tasks.0.id', 'task-1'),
      /P<2-digit phase>-<3-digit sequence>/,
    );
  });
});

describe('derived helpers', () => {
  it('lists open tasks from statuses, not from the hand-maintained list', () => {
    const result = validateProgrammeState(fixture());
    const state = result.state as ProgrammeState;

    expect(openTaskIds(state)).toEqual(['P83-002']);
  });
});
