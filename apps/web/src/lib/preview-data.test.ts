import { describe, expect, it } from 'vitest';

import {
  blockerFacts,
  blockedTasks,
  capNote,
  comparePhaseThenId,
  filterTasks,
  formatUtc,
  nextEligible,
  parseFilter,
  parseLedger,
  parseReadiness,
  safeRepoPath,
  shortCommit,
  sortTasks,
  summarise,
} from './preview-data';
import type { PreviewLedger, PreviewTask } from './preview-data';

/**
 * The preview's derivations. No filesystem, no network, no fixtures read from
 * the repo: every input here is constructed, so the suite states the rule rather
 * than re-asserting today's ledger contents.
 */

function task(overrides: Partial<PreviewTask> & { readonly id: string }): PreviewTask {
  return {
    title: `Task ${overrides.id}`,
    status: 'planned',
    phase: '8.4',
    riskClass: 'high',
    dependsOn: [],
    owner: 'owner',
    updatedAt: '2026-11-16T06:00:00.000Z',
    evidenceArtifact: null,
    gate: null,
    evidenceNote: null,
    ...overrides,
  };
}

function ledgerOf(tasks: readonly PreviewTask[]): PreviewLedger {
  return {
    branch: 'phase-6/trust-boundary-closure',
    head: 'd7a817d61a06847eb14dbae628972af4bb8a4c79',
    phase: '8.8',
    updatedAt: '2026-11-16T12:50:00.000Z',
    tasks: sortTasks(tasks),
    droppedTasks: 0,
  };
}

/** 32 tasks: 15 completed, 6 blocked, 11 planned — the shape the page renders. */
function programme(): PreviewLedger {
  const tasks: PreviewTask[] = [];
  for (let index = 0; index < 15; index += 1) {
    tasks.push(task({ id: `P83-0${String(index + 1).padStart(2, '0')}`, status: 'completed' }));
  }
  for (let index = 0; index < 6; index += 1) {
    tasks.push(task({ id: `P84-1${index}`, status: 'blocked', phase: '8.4' }));
  }
  for (let index = 0; index < 11; index += 1) {
    tasks.push(task({ id: `P88-0${String(index + 1).padStart(2, '0')}`, status: 'planned' }));
  }
  return ledgerOf(tasks);
}

describe('summarise', () => {
  it('counts each status and computes completed / total', () => {
    const summary = summarise(programme());

    expect(summary.total).toBe(32);
    expect(summary.completed).toBe(15);
    expect(summary.blocked).toBe(6);
    expect(summary.planned).toBe(11);
    expect(summary.other).toBe(0);
    expect(summary.percentage).toBe(46.9);
  });

  it('does not count blocked or planned as complete', () => {
    const onlyBlockedAndPlanned = summarise(
      ledgerOf([
        task({ id: 'A-1', status: 'blocked' }),
        task({ id: 'A-2', status: 'planned' }),
      ]),
    );

    expect(onlyBlockedAndPlanned.completed).toBe(0);
    expect(onlyBlockedAndPlanned.percentage).toBe(0);
  });

  it('returns 0 rather than NaN when the ledger has no tasks', () => {
    const empty = summarise(ledgerOf([]));

    expect(empty.total).toBe(0);
    expect(empty.percentage).toBe(0);
    expect(Number.isNaN(empty.percentage)).toBe(false);
  });

  it('keeps a status outside the three counted values out of every bucket but total', () => {
    const summary = summarise(
      ledgerOf([task({ id: 'X-1', status: 'cancelled' }), task({ id: 'X-2', status: 'completed' })]),
    );

    expect(summary.total).toBe(2);
    expect(summary.completed).toBe(1);
    expect(summary.other).toBe(1);
    expect(summary.percentage).toBe(50);
  });
});

describe('blockedTasks', () => {
  it('returns only blocked tasks, in phase then id order', () => {
    const blocked = blockedTasks(
      ledgerOf([
        task({ id: 'P88-002', status: 'blocked', phase: '8.8' }),
        task({ id: 'P84-010', status: 'completed', phase: '8.4' }),
        task({ id: 'P84-002', status: 'blocked', phase: '8.4' }),
        task({ id: 'P83-002', status: 'blocked', phase: '8.3' }),
      ]),
    );

    expect(blocked.map((entry) => entry.id)).toEqual(['P83-002', 'P84-002', 'P88-002']);
  });

  it('returns an empty list when nothing is blocked', () => {
    expect(blockedTasks(ledgerOf([task({ id: 'A-1', status: 'planned' })]))).toEqual([]);
  });
});

describe('nextEligible', () => {
  it('returns the first planned task whose dependencies are all completed', () => {
    const next = nextEligible(
      ledgerOf([
        task({ id: 'P83-001', status: 'completed', phase: '8.3' }),
        task({ id: 'P83-002', status: 'completed', phase: '8.3' }),
        task({ id: 'P83-007', status: 'planned', phase: '8.4', dependsOn: ['P83-001'] }),
        task({ id: 'P83-008', status: 'planned', phase: '8.4', dependsOn: ['P83-001', 'P83-002'] }),
      ]),
    );

    expect(next?.id).toBe('P83-007');
  });

  it('never returns a task with an unmet dependency, even when it sorts first', () => {
    const next = nextEligible(
      ledgerOf([
        task({ id: 'P83-001', status: 'blocked', phase: '8.3' }),
        task({ id: 'P83-002', status: 'planned', phase: '8.3', dependsOn: ['P83-001'] }),
        task({ id: 'P83-003', status: 'planned', phase: '8.3', dependsOn: ['P83-001'] }),
        task({ id: 'P83-004', status: 'planned', phase: '8.3' }),
      ]),
    );

    expect(next?.id).toBe('P83-004');
  });

  it('treats a missing dependency as unmet', () => {
    const next = nextEligible(
      ledgerOf([task({ id: 'P88-001', status: 'planned', dependsOn: ['P87-010'] })]),
    );

    expect(next).toBeNull();
  });

  it('returns null when no planned task is eligible', () => {
    const next = nextEligible(
      ledgerOf([
        task({ id: 'P83-001', status: 'completed' }),
        task({ id: 'P83-002', status: 'planned', dependsOn: ['P83-002'] }),
        task({ id: 'P83-003', status: 'blocked' }),
      ]),
    );

    expect(next).toBeNull();
  });

  it('orders by phase, not by insertion order', () => {
    const next = nextEligible(
      ledgerOf([
        task({ id: 'P88-001', status: 'planned', phase: '8.8' }),
        task({ id: 'P83-007', status: 'planned', phase: '8.4' }),
        task({ id: 'P86-001', status: 'planned', phase: '8.6' }),
      ]),
    );

    expect(next?.id).toBe('P83-007');
  });
});

describe('ordering', () => {
  it('sorts phase segments numerically, then id', () => {
    const ordered = sortTasks([
      task({ id: 'P83-010', phase: '8.10' }),
      task({ id: 'P83-002', phase: '8.4' }),
      task({ id: 'P83-010b', phase: '8.4' }),
      task({ id: 'P83-009', phase: '8.4' }),
    ]);

    expect(ordered.map((entry) => entry.id)).toEqual(['P83-002', 'P83-009', 'P83-010b', 'P83-010']);
  });

  it('sorts a non-numeric phase last rather than crashing', () => {
    expect(comparePhaseThenId({ phase: '8.4', id: 'A' }, { phase: 'later', id: 'A' })).toBe(-1);
  });
});

describe('parseLedger', () => {
  it('reports a missing tasks array as an error instead of throwing', () => {
    expect(() => parseLedger(JSON.stringify({ branch: 'x', head: 'y' }))).not.toThrow();

    const result = parseLedger(JSON.stringify({ branch: 'x', head: 'y' }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('tasks array');
  });

  it('reports invalid JSON as an error', () => {
    const result = parseLedger('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('The programme ledger is not valid JSON.');
  });

  it('reports a non-object root as an error', () => {
    const result = parseLedger('[]');
    expect(result.ok).toBe(false);
  });

  it('keeps only the allowlisted fields and truncates the evidence note', () => {
    const longNote = 'x'.repeat(400);
    const result = parseLedger(
      JSON.stringify({
        branch: 'main',
        head: 'abc1234',
        phase: '8.8',
        updatedAt: '2026-11-16T12:50:00.000Z',
        secret: 'do-not-render',
        history: [{ summary: 'do-not-render' }],
        tasks: [
          {
            id: 'P83-003',
            title: 'Remove passwordless sudo',
            status: 'BLOCKED',
            phase: '8.4',
            riskClass: 'critical',
            dependsOn: ['P83-001', 7],
            owner: 'host-operator',
            updatedAt: '2026-11-16T07:00:00.000Z',
            acceptanceCriteria: ['not rendered'],
            executionPolicy: { gate: 'broker-peer-credential', rationale: 'not rendered' },
            evidenceRequirement: {
              artifact: 'docs/engineering/phase8-host-boundary/HOST-PRIVILEGE-INVENTORY.md',
              note: longNote,
            },
          },
        ],
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const parsed = result.ledger.tasks[0];
    expect(parsed?.status).toBe('blocked');
    expect(parsed?.dependsOn).toEqual(['P83-001']);
    expect(parsed?.gate).toBe('broker-peer-credential');
    expect(parsed?.evidenceArtifact).toBe(
      'docs/engineering/phase8-host-boundary/HOST-PRIVILEGE-INVENTORY.md',
    );
    expect(parsed?.evidenceNote?.length).toBe(240);
    expect(parsed?.evidenceNote?.endsWith('…')).toBe(true);
    expect(Object.keys(parsed ?? {})).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('do-not-render');
  });

  it('drops entries without an id and reports the count', () => {
    const result = parseLedger(
      JSON.stringify({ branch: 'main', head: 'abc', phase: '8.8', tasks: [{ title: 'no id' }, { id: 'A-1' }] }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.ledger.tasks).toHaveLength(1);
    expect(result.ledger.droppedTasks).toBe(1);
  });
});

describe('path and note guards', () => {
  it('refuses absolute, home-relative and parent-traversing artifact paths', () => {
    expect(safeRepoPath('/etc/passwd')).toBeNull();
    expect(safeRepoPath('~/secrets.txt')).toBeNull();
    expect(safeRepoPath('C:\\Users\\op\\file.txt')).toBeNull();
    expect(safeRepoPath('../../outside/file.md')).toBeNull();
    expect(safeRepoPath('docs/engineering/phase8-host-boundary/PHASE8-BASELINE.md')).toBe(
      'docs/engineering/phase8-host-boundary/PHASE8-BASELINE.md',
    );
  });

  it('caps a note at 240 characters including the ellipsis', () => {
    expect(capNote('short')).toBe('short');
    expect(capNote('   ')).toBeNull();
    expect(capNote(null)).toBeNull();
    expect(capNote('y'.repeat(241))?.length).toBe(240);
  });
});

describe('blockerFacts', () => {
  it('restates recorded gates and dependency edges only', () => {
    const facts = blockerFacts(
      ledgerOf([
        task({
          id: 'P83-003',
          status: 'blocked',
          phase: '8.4',
          gate: 'broker-peer-credential',
        }),
        task({ id: 'P83-004', status: 'blocked', phase: '8.4', dependsOn: ['P83-003'] }),
        task({ id: 'P88-001', status: 'planned', phase: '8.8', dependsOn: ['P83-003'] }),
      ]),
    );

    expect(facts).toEqual([
      'P83-003 registers the execution gate “broker-peer-credential”.',
      'P83-004 depends on P83-003, which is blocked.',
      'P88-001 depends on P83-003, which is blocked.',
    ]);
  });

  it('returns nothing when the ledger records nothing to derive', () => {
    expect(blockerFacts(ledgerOf([task({ id: 'A-1', status: 'completed' })]))).toEqual([]);
  });
});

describe('filters and formatting', () => {
  it('parses only the three known filter values', () => {
    expect(parseFilter('blocked')).toBe('blocked');
    expect(parseFilter('completed')).toBe('completed');
    expect(parseFilter('planned')).toBe('planned');
    expect(parseFilter('nonsense')).toBe('all');
    expect(parseFilter(undefined)).toBe('all');
    expect(parseFilter(['blocked', 'planned'])).toBe('blocked');
  });

  it('filters by status and keeps all tasks for `all`', () => {
    const tasks = [
      task({ id: 'A-1', status: 'completed' }),
      task({ id: 'A-2', status: 'blocked' }),
      task({ id: 'A-3', status: 'planned' }),
    ];

    expect(filterTasks(tasks, 'all')).toHaveLength(3);
    expect(filterTasks(tasks, 'blocked').map((entry) => entry.id)).toEqual(['A-2']);
    expect(filterTasks(tasks, 'completed').map((entry) => entry.id)).toEqual(['A-1']);
  });

  it('formats UTC without a locale, and degrades to a dash', () => {
    expect(formatUtc('2026-11-16T12:50:00.000Z')).toBe('2026-11-16 12:50:00Z');
    expect(formatUtc('')).toBe('—');
    expect(formatUtc('not a date')).toBe('—');
  });

  it('abbreviates a commit to seven characters without mutating short values', () => {
    expect(shortCommit('d7a817d61a06847eb14dbae628972af4bb8a4c79')).toBe('d7a817d');
    expect(shortCommit('abc')).toBe('abc');
  });
});

describe('parseReadiness', () => {
  it('reads the documented document', () => {
    const health = parseReadiness({
      status: 'ready',
      service: 'intelligenz-api',
      checks: {
        postgres: { status: 'up', latencyMs: 16 },
        temporal: { status: 'up', latencyMs: 13 },
      },
    });

    expect(health.api).toBe('ready');
    expect(health.note).toBeNull();
    expect(health.dependencies).toEqual([
      { name: 'postgres', status: 'up', latencyMs: 16 },
      { name: 'temporal', status: 'up', latencyMs: 13 },
    ]);
  });

  it('reports a missing check as not reported rather than healthy', () => {
    const health = parseReadiness({ status: 'ready', checks: { postgres: { status: 'up', latencyMs: 4 } } });

    expect(health.dependencies).toEqual([
      { name: 'postgres', status: 'up', latencyMs: 4 },
      { name: 'temporal', status: 'not reported', latencyMs: null },
    ]);
  });

  it('is unavailable for a payload that does not match the contract', () => {
    const health = parseReadiness({ hello: 'world' });

    expect(health.api).toBe('unavailable');
    expect(health.dependencies.every((entry) => entry.status === 'unavailable')).toBe(true);
    expect(health.note).not.toBeNull();
  });

  it('is unavailable for a non-JSON value', () => {
    expect(parseReadiness(null).api).toBe('unavailable');
    expect(parseReadiness('ready').api).toBe('unavailable');
  });
});
