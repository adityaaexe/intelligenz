import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  WORKSPACE_STATES,
  WORKSPACE_TRANSITIONS,
  canTransition,
  isAbandonable,
  isReclaimable,
  isTerminal,
  type WorkspaceState,
} from '../src/state';

/**
 * The Phase 4 lifecycle, checked against the database enum rather than against a copy.
 *
 * `state.ts` says "matching `WorkspaceState` in schema.prisma exactly". Two lists of the
 * same names is a migration waiting to happen, so this file reads the schema and asserts
 * the sets are equal in both directions. A label added to the enum without an edge here
 * fails; an edge here without a label fails.
 */

const SCHEMA_PATH = join(__dirname, '../../database/prisma/schema.prisma');

async function schemaWorkspaceStates(): Promise<string[]> {
  const schema = await readFile(SCHEMA_PATH, 'utf8');
  const block = /enum WorkspaceState \{([\s\S]*?)\}/.exec(schema);

  if (block === null) throw new Error('enum WorkspaceState not found in schema.prisma');

  return (block[1] ?? '')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line.length > 0 && !line.startsWith('///'));
}

describe('workspace state machine (Phase 4)', () => {
  it('matches the Prisma enum exactly, in both directions', async () => {
    const fromSchema = (await schemaWorkspaceStates()).sort();

    expect([...WORKSPACE_STATES].sort()).toEqual(fromSchema);
  });

  it('has an edge list for every state and no edge to an unknown state', () => {
    expect(Object.keys(WORKSPACE_TRANSITIONS).sort()).toEqual([...WORKSPACE_STATES].sort());

    for (const [from, targets] of Object.entries(WORKSPACE_TRANSITIONS)) {
      for (const to of targets) {
        expect(WORKSPACE_STATES, `${from} -> ${String(to)} names an unknown state`).toContain(to);
      }
    }
  });

  it('treats exactly the six terminal states as terminal', () => {
    const terminal = WORKSPACE_STATES.filter((state) => isTerminal(state));

    expect(terminal.sort()).toEqual(
      ['cleaned', 'cleanup_failed', 'quarantined', 'completed', 'failed', 'cancelled'].sort(),
    );
  });

  it('does not treat the in-flight states as terminal', () => {
    for (const state of ['allocated', 'executing', 'finalizing', 'cleanup_pending'] as const) {
      expect(isTerminal(state), `${state} must not be terminal`).toBe(false);
    }
  });

  it('lets every other non-terminal state reach cleanup_pending, which is what a reaper needs', () => {
    // `cleanup_pending` is excluded because it does not transition to itself: a retry
    // inside the reaper keeps the row where it is and increments `cleanupAttempts`, so a
    // crash mid-cleanup leaves a row that still says "reclaimable".
    const inFlight = WORKSPACE_STATES.filter(
      (state) => !isTerminal(state) && state !== 'cleanup_pending',
    );

    for (const state of inFlight) {
      expect(canTransition(state, 'cleanup_pending'), `${state} cannot be queued for cleanup`).toBe(
        true,
      );
    }
  });

  it('keeps cleanup_failed terminal so the reaper cannot loop on an undeletable directory', () => {
    expect(WORKSPACE_TRANSITIONS.cleanup_failed).toEqual([]);
    expect(canTransition('cleanup_failed', 'cleanup_pending')).toBe(false);
  });

  it('never leaves a terminal state', () => {
    for (const state of WORKSPACE_STATES) {
      if (!isTerminal(state)) continue;

      expect(WORKSPACE_TRANSITIONS[state]).toEqual([]);
    }
  });

  it('classifies reclaimable and abandonable states without overlap', () => {
    const reclaimable = WORKSPACE_STATES.filter((state) => isReclaimable(state));
    const abandonable = WORKSPACE_STATES.filter((state) => isAbandonable(state));

    expect(reclaimable).toEqual(['cleanup_pending']);
    expect(abandonable).not.toContain('cleanup_pending');
    expect(abandonable.filter((state) => isTerminal(state))).toEqual([]);
    expect(abandonable).toEqual([
      'requested',
      'provisioning',
      'ready',
      'executing',
      'preserving',
      'allocated',
      'finalizing',
    ]);
  });

  it('has no edge that moves a terminal state, checked exhaustively', () => {
    const terminalish: WorkspaceState[] = [
      'completed',
      'failed',
      'cancelled',
      'cleaned',
      'cleanup_failed',
      'quarantined',
    ];

    for (const from of terminalish) {
      for (const to of WORKSPACE_STATES) {
        expect(canTransition(from, to), `${from} -> ${to} must not exist`).toBe(false);
      }
    }
  });
});
