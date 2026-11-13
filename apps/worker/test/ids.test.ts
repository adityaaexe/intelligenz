import { describe, expect, it } from 'vitest';

import {
  agentRunIdFor,
  artifactIdFor,
  deterministicId,
  evidenceIdFor,
  workflowRunIdFor,
} from '../src/activities/ids';

/**
 * Deterministic ids are how the persistence activities are idempotent without the
 * schema constraints this unit may not add. A regression here would silently start
 * duplicating `Artifact` and `Evidence` rows on every retry, which no other test in this
 * suite would notice.
 */
describe('deterministic ids', () => {
  it('produces a stable, valid UUID for the same name', () => {
    const first = deterministicId('artifact:task-1:report:abc');
    const second = deterministicId('artifact:task-1:report:abc');

    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('produces different ids for different names', () => {
    const ids = new Set([
      deterministicId('a'),
      deterministicId('b'),
      deterministicId('a '),
      deterministicId('A'),
    ]);

    expect(ids.size).toBe(4);
  });

  it('namespaces agent runs per workflow run and runtime', () => {
    expect(agentRunIdFor('run-1', 'local-simulated')).toBe(
      agentRunIdFor('run-1', 'local-simulated'),
    );
    expect(agentRunIdFor('run-1', 'local-simulated')).not.toBe(
      agentRunIdFor('run-2', 'local-simulated'),
    );
    expect(agentRunIdFor('run-1', 'local-simulated')).not.toBe(agentRunIdFor('run-1', 'other'));
  });

  it('keys artifacts by task, kind and checksum', () => {
    const checksum = 'a'.repeat(64);

    expect(artifactIdFor('task-1', 'report', checksum)).toBe(
      artifactIdFor('task-1', 'report', checksum),
    );
    expect(artifactIdFor('task-1', 'report', checksum)).not.toBe(
      artifactIdFor('task-1', 'report', 'b'.repeat(64)),
    );
    expect(artifactIdFor('task-1', 'report', checksum)).not.toBe(
      artifactIdFor('task-2', 'report', checksum),
    );
  });

  it('keeps evidence and artifact ids distinct even for the same content', () => {
    const checksum = 'c'.repeat(64);

    expect(artifactIdFor('task-1', 'report', checksum)).not.toBe(
      evidenceIdFor('task-1', 'report', checksum),
    );
  });

  it('keys a workflow run by its Temporal run id', () => {
    expect(workflowRunIdFor('temporal-run-1')).toBe(workflowRunIdFor('temporal-run-1'));
    expect(workflowRunIdFor('temporal-run-1')).not.toBe(workflowRunIdFor('temporal-run-2'));
  });
});
