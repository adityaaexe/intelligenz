import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '@intelligenz/database';

import { loadWorkerConfig, resetWorkerConfig, type WorkerConfig } from '../src/config';
import {
  leaseWorkspace,
  markExecuting,
  markPreserving,
  releaseWorkspace,
  workspaceArtifactsDirectory,
} from '../src/activities/workspace';
import { executionWorkspaceIdFor } from '../src/activities/ids';
import {
  createTask,
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * The workspace lifecycle, measured on disk and in the row.
 *
 * The properties this file exists for:
 *
 *   - `requested → provisioning → ready` is written as it happens, not reconstructed;
 *   - a failed provision ends in `failed` with a code, never in `ready`;
 *   - `completed` removes the checkout and **keeps** `artifacts/`;
 *   - `cancelled` keeps the workspace whole and says `cancelled`, never `executing`.
 *
 * The last one is the difference between "the run stopped" and "the run is still
 * going": an operator looking at an `executing` row after a cancellation would
 * reasonably assume a process is alive.
 */

const databaseUrl = testDatabaseUrl();
const enabled = databaseUrl !== undefined;

let client: PrismaClient;
let workspaceRoot: string;
const tenants: TenantFixture[] = [];

async function tenant(label: string): Promise<TenantFixture> {
  const created = await createTenant(client, label);
  tenants.push(created);
  return created;
}

function configFor(sourceRepo?: string): WorkerConfig {
  return loadWorkerConfig({
    DATABASE_URL: databaseUrl ?? 'postgresql://unused/unused',
    WORKSPACE_ROOT: workspaceRoot,
    ...(sourceRepo === undefined ? {} : { WORKSPACE_SOURCE_REPO: sourceRepo }),
    ARTIFACT_ROOT: join(workspaceRoot, 'artifacts'),
  });
}

beforeAll(async () => {
  if (!enabled) return;

  const database = useTestDatabase();
  client = database.client;
  workspaceRoot = await mkdtemp(join(tmpdir(), 'intelligenz-workspace-test-'));
  process.env['DATABASE_URL'] = database.url;
  process.env['WORKSPACE_ROOT'] = workspaceRoot;
  resetWorkerConfig();
});

afterAll(async () => {
  if (!enabled) return;

  for (const fixture of tenants) await dropTenant(client, fixture);
  await client.$disconnect();
});

describe.skipIf(!enabled)('workspace lifecycle', () => {
  it('provisions an empty workspace and records every state it passes through', async () => {
    const fixture = await tenant('workspace-ready');
    const task = await createTask(client, fixture, { title: 'Lease an empty workspace' });
    const workspaceId = executionWorkspaceIdFor(task.workflowRunId, 1);

    const leased = await leaseWorkspace({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
      attemptNumber: 1,
      workspaceId,
      config: configFor(),
    });

    expect(leased.ok).toBe(true);
    if (!leased.ok) return;

    const row = await client.executionWorkspace.findUniqueOrThrow({ where: { id: workspaceId } });

    expect(row.state).toBe('ready');
    expect(row.sourceKind).toBe('empty');
    expect(row.baseCommit).toBeNull();
    expect(row.readyAt).not.toBeNull();
    expect(row.rootPath).toBe(leased.lease.handle.rootPath);

    const directory = await stat(row.rootPath);
    expect(directory.isDirectory()).toBe(true);
  });

  it('records a provisioning failure as failed, with the stage and code', async () => {
    const fixture = await tenant('workspace-failed');
    const task = await createTask(client, fixture, { title: 'Fail to provision' });
    const workspaceId = executionWorkspaceIdFor(task.workflowRunId, 1);

    const leased = await leaseWorkspace({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
      attemptNumber: 1,
      workspaceId,
      // A repository that does not exist: `git clone` fails deterministically.
      config: configFor(join(workspaceRoot, 'absent-repo')),
    });

    expect(leased.ok).toBe(false);

    const row = await client.executionWorkspace.findUniqueOrThrow({ where: { id: workspaceId } });

    expect(row.state).toBe('failed');
    expect(row.error).toMatchObject({ code: 'WORKSPACE_PROVISION_FAILED', stage: 'source' });
  });

  it('keeps artifacts and deletes the checkout when it completes', async () => {
    const fixture = await tenant('workspace-complete');
    const task = await createTask(client, fixture, { title: 'Complete a workspace' });
    const workspaceId = executionWorkspaceIdFor(task.workflowRunId, 1);

    const leased = await leaseWorkspace({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
      attemptNumber: 1,
      workspaceId,
      config: configFor(),
    });

    if (!leased.ok) throw new Error('expected a workspace');

    await markExecuting(leased.lease, fixture.orgId);
    await markPreserving(leased.lease, fixture.orgId);

    const artifactsDirectory = workspaceArtifactsDirectory(leased.lease.handle);
    await mkdir(artifactsDirectory, { recursive: true });
    await writeFile(join(artifactsDirectory, 'transcript.ndjson'), '{"type":"step_start"}\n');

    await releaseWorkspace({ lease: leased.lease, orgId: fixture.orgId, outcome: 'completed' });

    const row = await client.executionWorkspace.findUniqueOrThrow({ where: { id: workspaceId } });

    expect(row.state).toBe('completed');
    expect(row.cleanedAt).not.toBeNull();

    // The checkout is gone; the evidence is not.
    await expect(stat(join(leased.lease.handle.rootPath, 'repo'))).rejects.toThrow();
    const transcript = await stat(join(artifactsDirectory, 'transcript.ndjson'));
    expect(transcript.isFile()).toBe(true);
  });

  it('leaves a cancelled workspace cancelled, not executing', async () => {
    const fixture = await tenant('workspace-cancelled');
    const task = await createTask(client, fixture, { title: 'Cancel a workspace' });
    const workspaceId = executionWorkspaceIdFor(task.workflowRunId, 1);

    const leased = await leaseWorkspace({
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
      attemptNumber: 1,
      workspaceId,
      config: configFor(),
    });

    if (!leased.ok) throw new Error('expected a workspace');

    await markExecuting(leased.lease, fixture.orgId);
    await releaseWorkspace({ lease: leased.lease, orgId: fixture.orgId, outcome: 'cancelled' });

    const row = await client.executionWorkspace.findUniqueOrThrow({ where: { id: workspaceId } });

    expect(row.state).toBe('cancelled');
    // A cancelled workspace is kept whole: the bytes are the evidence of what was
    // interrupted, and a sweep that deleted them would make the interruption
    // unreproducible.
    const directory = await stat(row.rootPath);
    expect(directory.isDirectory()).toBe(true);
  });
});
