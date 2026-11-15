import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildSandboxCommand,
  createWorkspaceManager,
  execSandboxed,
  takeWorkspaceSnapshot,
  type ChangeManifest,
  type WorkspaceHandle,
} from '@intelligenz/workspace-manager';

import { captureFinalEvidence, captureInitialEvidence } from '../src/activities/evidence';

/**
 * Where the baseline is taken, and why "early" is not good enough.
 *
 * Two proofs, because one of them alone is weak:
 *
 *   1. **Structural** — the call site is first in the leased block, before the cgroup is
 *      created, before `markExecuting`, before the broker and before `runtime.execute`.
 *      This is a source-order assertion, which is exactly the kind of test that rots; it
 *      is paired with (2) so a change in either dimension fails.
 *   2. **Behavioural** — a real sandboxed process writes into `/workspace`, and the
 *      manifest reports that write as an addition against the baseline. If the baseline
 *      were taken after the process, the file would be pre-existing and invisible, which
 *      is the failure mode this whole gate exists to prevent.
 *
 * A baseline taken after anything the agent can touch is not a baseline: it silently
 * launders the agent's first write into "pre-existing state".
 */

let scratch: string;
let handle: WorkspaceHandle;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'intelligenz-capture-order-'));
  const manager = createWorkspaceManager({ root: scratch });

  handle = await manager.provision({
    orgId: 'org-1',
    taskId: 'task-order',
    workspaceId: 'ws-order',
    source: { kind: 'empty' },
  });

  await writeFile(join(handle.repoPath, 'pre-existing.txt'), 'from the previous attempt\n');
}, 120_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('the baseline precedes every agent-reachable side effect', () => {
  it('is the first thing after the lease, before the cgroup, the state write and the runtime call', async () => {
    const source = await readFile(
      fileURLToPath(new URL('../src/activities/execute-agent.ts', import.meta.url)),
      'utf8',
    );

    const positions = {
      leaseAcquired: source.indexOf('lease = leased.lease;'),
      // The call site that takes the baseline. It was renamed from `captureInitialEvidence`
      // to `captureInitialEvidenceOutcome` when the failure began travelling beside the
      // evidence (F-G19); the ordering invariant is the same one, so this anchor moves with
      // it rather than being pinned to a name the production path no longer calls.
      baseline: source.indexOf('captureInitialEvidenceOutcome(lease.handle)'),
      cgroup: source.indexOf('createCgroup(config.resources.cgroupRoot, workspaceId)'),
      markExecuting: source.indexOf('await markExecuting(lease, input.orgId)'),
      execute: source.indexOf('await runtime.execute(request, controller.signal)'),
    };

    // Every anchor must exist; a rename would otherwise make an index `-1` and silently
    // satisfy a `<` comparison.
    for (const [name, position] of Object.entries(positions)) {
      expect(position, `${name} must exist in execute-agent.ts`).toBeGreaterThan(-1);
    }

    expect(positions.baseline).toBeGreaterThan(positions.leaseAcquired);
    expect(positions.baseline).toBeLessThan(positions.cgroup);
    expect(positions.baseline).toBeLessThan(positions.markExecuting);
    expect(positions.baseline).toBeLessThan(positions.execute);

    // One launch site. A second `runtime.execute` call would be a second place to forget
    // the baseline, and the ordering assertion above would say nothing about it.
    const executeSites = source.match(/runtime\.execute\(/g) ?? [];
    expect(executeSites).toHaveLength(1);
  });

  it('reports a sandboxed write as an addition, so the run cannot launder it as pre-existing', async () => {
    const initial = await captureInitialEvidence(handle);
    expect(initial).not.toBeNull();

    // The agent's first possible write, through the same mount profile the run uses:
    // one read-write bind, `<rootPath>/repo` at `/workspace`.
    const command = buildSandboxCommand(
      handle,
      ['/bin/sh', '-c', 'printf "written by the run\\n" > /workspace/agent-was-here.txt'],
      { env: {} },
    );
    await execSandboxed(command, { timeoutMs: 15_000, maxBuffer: 1024 * 1024 });

    const summary = await captureFinalEvidence({ handle, initial });
    expect(summary).not.toBeNull();
    if (summary === null) return;

    const manifest = JSON.parse(
      await readFile(summary.artifact.uri, 'utf8'),
    ) as ChangeManifest;

    const added = manifest.changes.find((change) => change.path === 'agent-was-here.txt');

    expect(added?.status).toBe('added');
    expect(added?.before).toBeNull();
    expect(added?.after?.sizeBytes).toBe('written by the run\n'.length);

    // The pre-existing file is not a change: it was there before the baseline. Reused
    // workspaces are expected, and this is the per-attempt semantics that makes them safe.
    expect(manifest.changes.map((change) => change.path)).not.toContain('pre-existing.txt');
    expect(manifest.complete).toBe(true);

    // And the baseline really is a different tree from the final one.
    const now = await takeWorkspaceSnapshot(handle.repoPath);
    expect(now.digest).toBe(summary.finalManifestDigest);
    expect(summary.initialManifestDigest).not.toBe(summary.finalManifestDigest);
  });

  it('records the pre-existing tree in the baseline, including a file the agent never touches', async () => {
    const snapshot = await takeWorkspaceSnapshot(handle.repoPath);
    const entry = snapshot.entries.find((candidate) => candidate.path === 'pre-existing.txt');

    expect(entry?.kind).toBe('file');
    expect(snapshot.entries.some((candidate) => candidate.path === 'agent-was-here.txt')).toBe(
      true,
    );
  });
});
