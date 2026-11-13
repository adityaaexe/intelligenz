import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ContainmentError,
  IllegalTransitionError,
  UnsafeSegmentError,
  WORKSPACE_STATES,
  WORKSPACE_TRANSITIONS,
  assertContained,
  createWorkspaceManager,
  safeSegment,
  type WorkspaceHandle,
  type WorkspaceManager,
} from '../src';

/**
 * The escape tests. Every one of them is an attack that has to fail in a specific
 * way, not merely "not crash": a rejection that happens after `mkdir` is not a
 * rejection, and a cleanup that deletes the wrong directory has already lost.
 */

const FIXTURE = resolve(fileURLToPath(new URL('../../../infra/fixtures/sample-repo', import.meta.url)));

const IDS = { orgId: 'org-1', taskId: 'task-1', workspaceId: 'ws-1' } as const;

describe('safeSegment — route-supplied ids are hostile input', () => {
  it.each(['..', '.', 'a/b', 'a\\b', '', 'a\u0000b', 'C:', 'x'.repeat(65), 'a b', 'ünicode'])(
    'rejects %j',
    (value) => {
      expect(() => safeSegment(value)).toThrow(UnsafeSegmentError);
    },
  );

  it.each(['org-1', 'A_b-9', 'x'.repeat(64)])('accepts %j', (value) => {
    expect(safeSegment(value)).toBe(value);
  });

  it('a null byte never reaches a syscall', () => {
    expect(() => safeSegment('a\u0000b')).toThrow(/expected/);
  });
});

describe('workspace manager', () => {
  let root: string;
  let manager: WorkspaceManager;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'intelligenz-ws-'));
    manager = createWorkspaceManager({ root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('provisions by cloning the fixture, and records the base commit', async () => {
    const handle = await manager.provision({ ...IDS, source: { kind: 'clone', repoPath: FIXTURE } });

    expect(handle.state).toBe('ready');
    expect(handle.sourceKind).toBe('clone');
    expect(handle.rootPath).toBe(join(root, IDS.orgId, IDS.taskId, IDS.workspaceId));
    expect(handle.repoPath).toBe(join(handle.rootPath, 'repo'));
    expect(handle.baseCommit).toMatch(/^[a-f0-9]{40}$/);
    expect(handle.branch === null || typeof handle.branch === 'string').toBe(true);

    const entries = await readdir(handle.rootPath);
    expect(entries).toContain('repo');
  });

  it('is idempotent: a second provision of the same ids returns the same directory', async () => {
    const request = { orgId: 'org-1', taskId: 'task-idem', workspaceId: 'ws-idem' } as const;
    const first = await manager.provision({ ...request, source: { kind: 'clone', repoPath: FIXTURE } });
    const second = await manager.provision({ ...request, source: { kind: 'clone', repoPath: FIXTURE } });

    expect(second.rootPath).toBe(first.rootPath);
    expect(second.state).toBe('ready');

    // The adopt path reads HEAD **inside the sandbox** (the directory may carry an
    // agent-written `.git`). A null here would mean the sandboxed query silently failed
    // and the handle lost its provenance.
    expect(second.baseCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(second.baseCommit).toBe(first.baseCommit);
  });

  it('a symlink pointing at /etc/passwd is refused once resolved', async () => {
    const handle = await manager.provision({
      orgId: 'org-1',
      taskId: 'task-symlink',
      workspaceId: 'ws-symlink',
      source: { kind: 'empty' },
    });

    const link = join(handle.rootPath, 'passwd-link');
    await symlink('/etc/passwd', link);

    await expect(assertContained(handle.rootPath, link)).rejects.toBeInstanceOf(ContainmentError);

    // A relative escape that stays inside the string is also refused.
    await expect(assertContained(handle.rootPath, join(handle.rootPath, '..', '..'))).rejects.toBeInstanceOf(
      ContainmentError,
    );

    // The unmodified path is accepted: the check rejects escapes, not everything.
    await expect(assertContained(handle.rootPath, handle.rootPath)).resolves.toBe(handle.rootPath);
  });

  it('refuses a traversal id before creating anything outside the root', async () => {
    const before = await readdir(root);

    await expect(
      manager.provision({
        orgId: 'org-1',
        taskId: '../escape',
        workspaceId: 'ws-escape',
        source: { kind: 'empty' },
      }),
    ).rejects.toBeInstanceOf(UnsafeSegmentError);

    // Nothing was created: no `escape` directory above or inside the root.
    expect(await readdir(root)).toEqual(before);
    await expect(readdir(join(root, '..'))).resolves.not.toContain('escape');
  });

  it('cleanup cannot delete a sibling workspace, even with a forged handle', async () => {
    const a = await manager.provision({
      orgId: 'org-1',
      taskId: 'task-sibling',
      workspaceId: 'ws-a',
      source: { kind: 'clone', repoPath: FIXTURE },
    });
    const b = await manager.provision({
      orgId: 'org-1',
      taskId: 'task-sibling',
      workspaceId: 'ws-b',
      source: { kind: 'clone', repoPath: FIXTURE },
    });

    // The attack: claim b's directory while naming a's ids.
    const forged: WorkspaceHandle = { ...a, rootPath: b.rootPath, repoPath: b.repoPath };

    await expect(manager.cleanup(forged)).rejects.toBeInstanceOf(ContainmentError);

    expect(await readdir(b.repoPath)).toContain('package.json');
  });

  it('cleanup keeps artifacts and removes the checkout', async () => {
    const handle = await manager.provision({
      orgId: 'org-1',
      taskId: 'task-clean',
      workspaceId: 'ws-clean',
      source: { kind: 'clone', repoPath: FIXTURE },
    });

    await mkdir(join(handle.rootPath, 'artifacts'), { recursive: true });
    await writeFile(join(handle.rootPath, 'artifacts', 'transcript.ndjson'), '{"ok":true}\n');

    const result = await manager.cleanup(handle, { keepArtifacts: true });

    expect(result.artifactsKept).toBe(true);
    expect(await readdir(handle.rootPath)).toEqual(['artifacts']);
    expect(manager.get(handle.id)?.state).toBe('completed');
  });

  it('cleanup removes everything when artifacts are not wanted', async () => {
    const handle = await manager.provision({
      orgId: 'org-1',
      taskId: 'task-nuke',
      workspaceId: 'ws-nuke',
      source: { kind: 'empty' },
    });

    const result = await manager.cleanup(handle, { keepArtifacts: false });

    expect(result.artifactsKept).toBe(false);
    await expect(readdir(handle.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('exposes a state table whose edges are validated', () => {
    expect(Object.keys(WORKSPACE_TRANSITIONS).sort()).toEqual([...WORKSPACE_STATES].sort());

    const handle = manager.get('ws-1');
    expect(handle).toBeDefined();

    // A terminal state accepts nothing.
    expect(WORKSPACE_TRANSITIONS.completed).toEqual([]);
    expect(WORKSPACE_TRANSITIONS.cancelled).toEqual([]);

    expect(() => manager.transition('ws-1', 'completed')).toThrow(IllegalTransitionError);
  });

  it('recover requeues a provisioning run that never touched the disk', async () => {
    const ghost: WorkspaceHandle = {
      id: 'ws-ghost',
      orgId: 'org-1',
      taskId: 'task-ghost',
      rootPath: join(root, 'org-1', 'task-ghost', 'ws-ghost'),
      sourceKind: 'clone',
      baseCommit: null,
      branch: null,
      state: 'provisioning',
      repoPath: join(root, 'org-1', 'task-ghost', 'ws-ghost', 'repo'),
      createdAt: new Date().toISOString(),
    };

    manager.adopt(ghost);

    const recovered = await manager.recover('ws-ghost');
    expect(recovered.state).toBe('requested');
  });

  it('recovers a provisioning run that was killed after mkdir', async () => {
    // A gate that never resolves is the crash: the directory exists, the clone never
    // ran, and the process that owned the handle is gone.
    let released: (() => void) | undefined;
    const gate = new Promise<void>((resolveGate) => {
      released = resolveGate;
    });

    const crashable = createWorkspaceManager({ root, provisionGate: () => gate });
    const inFlight = crashable.provision({
      orgId: 'org-1',
      taskId: 'task-killed',
      workspaceId: 'ws-killed',
      source: { kind: 'clone', repoPath: FIXTURE },
    });

    await new Promise((resolveTick) => setTimeout(resolveTick, 50));

    const stuck = crashable.get('ws-killed');
    expect(stuck?.state).toBe('provisioning');
    expect(await readdir(join(root, 'org-1', 'task-killed', 'ws-killed'))).toEqual([]);

    // A different manager, as after a worker restart: only the persisted row survives.
    const survivor = createWorkspaceManager({ root });
    survivor.adopt(stuck as WorkspaceHandle);

    const recovered = await survivor.recover('ws-killed');
    expect(recovered.state).toBe('failed');
    expect(recovered.error?.message).toContain('no .git');

    released?.();
    await inFlight;
  });
});
