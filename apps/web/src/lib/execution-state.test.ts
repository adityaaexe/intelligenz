import { describe, expect, it } from 'vitest';

import {
  artifactFilename,
  clockUtc,
  describeAttemptError,
  describeDuration,
  elapsedMs,
  formatBytes,
  formatProviderCost,
  integrityDescriptor,
  isCommandSummary,
  isSimulatedRuntimeId,
  provenanceDescriptor,
  provenanceMismatch,
  provenanceOf,
  runStateDescriptor,
  shortCommit,
  splitArtifactUri,
  taskGateState,
  workspaceStateLabel,
} from './execution-state';
import type { ArtifactIntegrity, ExecutionAttempt, RunStatus } from './types';

/**
 * The execution state vocabulary, tested as behaviour rather than as strings.
 *
 * The three tests that matter most:
 *
 * 1. `provenanceOf` reads `simulated` and nothing else — a real runtime id with
 *    `simulated: true` is Simulated, and the simulated adapter with
 *    `simulated: false` is Live. If someone "improves" this by sniffing the
 *    runtime id, these fail.
 * 2. Cost is the provider's figure or `—`. Null is not zero, and a malformed
 *    string is not `$NaN`.
 * 3. `unknown` integrity is never a pass.
 */

function attempt(overrides: Partial<ExecutionAttempt> = {}): ExecutionAttempt {
  return {
    id: 'a-1',
    taskId: 't-1',
    workflowRunId: 'w-1',
    attemptNumber: 1,
    runtimeId: 'opencode-cli',
    runtimeVersion: '2.2.7',
    simulated: false,
    status: 'succeeded',
    startedAt: '2026-11-13T10:00:00.000Z',
    finishedAt: '2026-11-13T10:00:42.000Z',
    durationMs: 42_000,
    tokensIn: 43_598,
    tokensOut: 120,
    costUsd: '0.0005',
    error: null,
    workspace: null,
    ...overrides,
  };
}

describe('provenanceOf — the one place provenance is decided', () => {
  it('labels a real runtime reporting simulated:false as Live', () => {
    expect(provenanceOf(attempt({ runtimeId: 'opencode-cli', simulated: false }))).toBe('live');
  });

  it('labels the simulated adapter reporting simulated:true as Simulated', () => {
    expect(provenanceOf(attempt({ runtimeId: 'local-simulated', simulated: true }))).toBe(
      'simulated',
    );
  });

  it('does not infer from the runtime id: a real runtime with simulated:true is Simulated', () => {
    // The data bug the requirement names. The label follows the field, and the
    // mismatch warning reports the contradiction separately.
    expect(provenanceOf(attempt({ runtimeId: 'opencode-cli', simulated: true }))).toBe('simulated');
  });

  it('does not infer from the runtime id: the simulated adapter with simulated:false is Live', () => {
    expect(provenanceOf(attempt({ runtimeId: 'local-simulated', simulated: false }))).toBe('live');
  });

  it('renders two different words, glyphs and spoken prefixes', () => {
    const live = provenanceDescriptor('live');
    const simulated = provenanceDescriptor('simulated');
    expect(live.label).toBe('Live');
    expect(simulated.label).toBe('Simulated');
    expect(live.glyph).not.toBe(simulated.glyph);
    expect(live.srPrefix).toBe('Provenance: ');
    expect(simulated.srPrefix).toBe('Provenance: ');
  });
});

describe('provenanceMismatch', () => {
  it('warns quietly when a real runtime reported simulation', () => {
    const mismatch = provenanceMismatch(attempt({ runtimeId: 'opencode-cli', simulated: true }));
    expect(mismatch?.code).toBe('REPORTED_SIMULATION');
    expect(mismatch?.loud).toBe(false);
  });

  it('warns loudly when the simulated adapter is labelled Live', () => {
    const mismatch = provenanceMismatch(attempt({ runtimeId: 'local-simulated', simulated: false }));
    expect(mismatch?.code).toBe('SIMULATED_RUNTIME_LABELLED_LIVE');
    expect(mismatch?.loud).toBe(true);
  });

  it('says nothing when the field and the adapter agree', () => {
    expect(provenanceMismatch(attempt({ runtimeId: 'opencode-cli', simulated: false }))).toBeNull();
    expect(provenanceMismatch(attempt({ runtimeId: 'local-simulated', simulated: true }))).toBeNull();
  });
});

describe('runStateDescriptor — every RunStatus maps to a distinct word', () => {
  const statuses: readonly RunStatus[] = [
    'queued',
    'running',
    'succeeded',
    'failed',
    'cancelled',
    'timed_out',
  ];

  it('uses the required vocabulary', () => {
    expect(runStateDescriptor('running').label).toBe('Executing');
    expect(runStateDescriptor('succeeded').label).toBe('Completed');
    expect(runStateDescriptor('failed').label).toBe('Failed');
    expect(runStateDescriptor('cancelled').label).toBe('Cancelled');
    expect(runStateDescriptor('queued').label).toBe('Queued');
  });

  it('qualifies a timeout without hiding the failure', () => {
    const timedOut = runStateDescriptor('timed_out');
    expect(timedOut.label).toBe('Failed');
    expect(timedOut.qualifier).toBe('Timed out');
    expect(timedOut.tone).toBe('failed');
  });

  it('gives every state a glyph and a spoken prefix', () => {
    for (const status of statuses) {
      const descriptor = runStateDescriptor(status);
      expect(descriptor.glyph.length).toBeGreaterThan(0);
      expect(descriptor.srPrefix).toBe('Status: ');
    }
  });

  it('treats only queued and running as open', () => {
    expect(runStateDescriptor('running').open).toBe(true);
    expect(runStateDescriptor('queued').open).toBe(true);
    expect(runStateDescriptor('succeeded').open).toBe(false);
    expect(runStateDescriptor('failed').open).toBe(false);
  });
});

describe('integrityDescriptor', () => {
  const states: readonly ArtifactIntegrity[] = ['verified', 'failed', 'unknown'];

  it('never renders unknown as a pass', () => {
    const descriptor = integrityDescriptor('unknown');
    expect(descriptor.label).toBe('Unverified');
    expect(descriptor.label).not.toBe('Verified');
    expect(descriptor.loud).toBe(false);
  });

  it('makes a checksum mismatch loud', () => {
    const descriptor = integrityDescriptor('failed');
    expect(descriptor.label).toBe('Failed');
    expect(descriptor.loud).toBe(true);
    expect(descriptor.tone).toBe('failed');
  });

  it('gives all three states a distinct label and glyph', () => {
    const labels = states.map((state) => integrityDescriptor(state).label);
    const glyphs = states.map((state) => integrityDescriptor(state).glyph);
    expect(new Set(labels).size).toBe(3);
    expect(new Set(glyphs).size).toBe(3);
  });
});

describe('formatProviderCost — the provider figure or a dash', () => {
  it('renders the provider decimal, not a rounded or estimated value', () => {
    expect(formatProviderCost('0.0005')).toBe('$0.0005');
    expect(formatProviderCost('0.1985')).toBe('$0.20');
    expect(formatProviderCost('2.1400')).toBe('$2.14');
  });

  it('renders a reported zero as zero, not as missing', () => {
    // A simulated run spends nothing; that is a measurement, not an absence.
    expect(formatProviderCost('0.0000')).toBe('$0.00');
  });

  it('renders null and undefined as an em dash, never as $0.00', () => {
    expect(formatProviderCost(null)).toBe('—');
    expect(formatProviderCost(undefined)).toBe('—');
    expect(formatProviderCost('')).toBe('—');
    expect(formatProviderCost('   ')).toBe('—');
  });

  it('refuses to turn a malformed value into $NaN', () => {
    expect(formatProviderCost('not-a-number')).toBe('—');
  });
});

describe('taskGateState', () => {
  const base = {
    status: 'ready' as const,
    approvals: [],
  };

  it('reports Waiting for approval when a pending request exists', () => {
    const gate = taskGateState({
      ...base,
      approvals: [
        {
          id: 'ap-1',
          status: 'PENDING',
          riskClass: 'HIGH',
          requestedById: 'u-1',
          decidedById: null,
          decisionNote: null,
          createdAt: '2026-11-13T09:00:00.000Z',
          decidedAt: null,
        },
      ],
    });
    expect(gate?.word).toBe('Waiting for approval');
    expect(gate?.glyph).toBe('approvals');
    expect(gate?.tone).toBe('awaiting');
  });

  it('reports Blocked for a blocked task with no pending request', () => {
    const gate = taskGateState({ status: 'blocked', approvals: [] });
    expect(gate?.word).toBe('Blocked');
    expect(gate?.glyph).toBe('status-awaiting');
  });

  it('keeps Blocked dominant when a blocked task also has a pending request', () => {
    // Approving would not unblock it: the task needs blocked → ready with a reason.
    const gate = taskGateState({
      status: 'blocked',
      approvals: [
        {
          id: 'ap-2',
          status: 'PENDING',
          riskClass: 'HIGH',
          requestedById: 'u-1',
          decidedById: null,
          decisionNote: null,
          createdAt: '2026-11-13T09:00:00.000Z',
          decidedAt: null,
        },
      ],
    });
    expect(gate?.word).toBe('Blocked');
  });

  it('separates the two states by glyph, not only by word', () => {
    const waiting = taskGateState({
      status: 'ready',
      approvals: [
        {
          id: 'ap-1',
          status: 'PENDING',
          riskClass: 'CRITICAL',
          requestedById: 'u-1',
          decidedById: null,
          decisionNote: null,
          createdAt: '2026-11-13T09:00:00.000Z',
          decidedAt: null,
        },
      ],
    });
    const blocked = taskGateState({ status: 'blocked', approvals: [] });
    expect(waiting?.glyph).not.toBe(blocked?.glyph);
  });

  it('reports nothing for a running task, even with a stale pending request', () => {
    expect(taskGateState({ status: 'running', approvals: [] })).toBeNull();
    expect(taskGateState({ status: 'succeeded', approvals: [] })).toBeNull();
  });
});

describe('elapsedMs', () => {
  it('prefers the API duration', () => {
    expect(elapsedMs(attempt({ durationMs: 42_000 }), 0)).toBe(42_000);
  });

  it('measures to now while the attempt is open', () => {
    const now = Date.parse('2026-11-13T10:00:10.000Z');
    expect(
      elapsedMs(attempt({ durationMs: null, finishedAt: null, startedAt: '2026-11-13T10:00:00.000Z' }), now),
    ).toBe(10_000);
  });

  it('returns null — not zero — when the start is unknown', () => {
    expect(elapsedMs(attempt({ durationMs: null, startedAt: null }), 0)).toBeNull();
  });

  it('never returns a negative duration from clock skew', () => {
    const now = Date.parse('2026-11-13T09:59:00.000Z');
    expect(
      elapsedMs(attempt({ durationMs: null, finishedAt: null, startedAt: '2026-11-13T10:00:00.000Z' }), now),
    ).toBe(0);
  });
});

describe('describeAttemptError', () => {
  it('renders a structured runtime error', () => {
    expect(describeAttemptError({ code: 'RUNTIME_FAILED', message: 'exit 1' })).toBe(
      'RUNTIME_FAILED: exit 1',
    );
  });

  it('renders a bare string', () => {
    expect(describeAttemptError('sandbox unavailable')).toBe('sandbox unavailable');
  });

  it('admits an unrenderable shape instead of inventing one', () => {
    expect(describeAttemptError({ retryable: true })).toContain('cannot render');
    expect(describeAttemptError(null)).toBeNull();
    expect(describeAttemptError(undefined)).toBeNull();
  });
});

describe('display helpers', () => {
  it('shortens a commit and keeps the full value for the title', () => {
    const commit = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
    expect(shortCommit(commit)).toBe('a1b2c3d4e5f6…');
    expect(shortCommit('abc1234')).toBe('abc1234');
    expect(shortCommit(null)).toBeNull();
  });

  it('formats artifact sizes without rounding a real file to zero', () => {
    expect(formatBytes(284)).toBe('284 B');
    expect(formatBytes(13_545)).toBe('13.5 kB');
    expect(formatBytes(1_400_000)).toBe('1.4 MB');
    expect(formatBytes(null)).toBe('—');
  });

  it('derives a download filename from the logical uri', () => {
    expect(artifactFilename('org/task/ws/artifacts/transcript.ndjson', 'transcript')).toBe(
      'transcript.ndjson',
    );
    expect(artifactFilename('', 'diff')).toBe('diff.bin');
  });

  it('splits a logical uri so the file name survives truncation', () => {
    expect(splitArtifactUri('org/task/ws/artifacts/transcript.ndjson')).toEqual({
      dir: 'org/task/ws/artifacts/',
      name: 'transcript.ndjson',
    });
    expect(splitArtifactUri('transcript.ndjson')).toEqual({ dir: '', name: 'transcript.ndjson' });
    expect(splitArtifactUri('/abs/path/diff.patch')).toEqual({ dir: 'abs/path/', name: 'diff.patch' });
  });

  it('treats command tools as monospace and the rest as prose', () => {
    expect(isCommandSummary('shell')).toBe(true);
    expect(isCommandSummary('Bash')).toBe(true);
    expect(isCommandSummary('read')).toBe(false);
    expect(isCommandSummary('edit')).toBe(false);
  });

  it('renders a UTC clock time from an ISO timestamp', () => {
    expect(clockUtc('2026-11-13T14:02:48.342Z')).toBe('14:02:48');
    expect(clockUtc('not-a-date')).toBe('—');
  });

  it('expands a duration for screen readers', () => {
    expect(describeDuration(42_000)).toBe('42 seconds');
    expect(describeDuration(86_400)).toBe('1 minute 26 seconds');
    expect(describeDuration(412)).toBe('412 milliseconds');
    expect(describeDuration(null)).toBe('Not reported');
  });

  it('humanises every workspace state', () => {
    expect(workspaceStateLabel('preserving')).toBe('Preserving artifacts');
    expect(workspaceStateLabel('completed')).toBe('Completed');
  });

  it('recognises the simulated adapter ids without guessing at others', () => {
    expect(isSimulatedRuntimeId('local-simulated')).toBe(true);
    expect(isSimulatedRuntimeId(' Simulated ')).toBe(true);
    expect(isSimulatedRuntimeId('opencode-cli')).toBe(false);
    expect(isSimulatedRuntimeId(null)).toBe(false);
  });
});
