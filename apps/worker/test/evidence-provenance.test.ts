import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ExecutionResult } from '@intelligenz/agent-runtime';
import type { PrismaClient } from '@intelligenz/database';
import { createWorkspaceManager, evidencePath, manifestDigest, serialiseManifest } from '@intelligenz/workspace-manager';
import type { WorkspaceHandle } from '@intelligenz/workspace-manager';

import { persistResult } from '../src/activities/persist-result';
import {
  CHANGE_MANIFEST_FILE,
  captureFinalEvidence,
  captureInitialEvidence,
} from '../src/activities/evidence';
import { executionWorkspaceIdFor } from '../src/activities/ids';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime } from '../src/runtime';
import {
  createTask,
  createTenant,
  dropTenant,
  testDatabaseUrl,
  useTestDatabase,
  type TaskFixture,
  type TenantFixture,
} from './helpers/database';

/**
 * Artifact provenance, against a real Postgres.
 *
 * The question these tests answer is not "was the bytes' checksum recorded" — Phase 3 did
 * that. It is "**who decided what those bytes mean**". A `diff.patch` produced by `git diff`
 * inside the workspace is a claim by a program the agent can configure; a `change-manifest`
 * produced by a host walk is not. Both are artifacts; only one is authority, and the schema
 * has to say so without being asked.
 *
 * Every assertion here is about provenance, not content:
 *
 *   - the manifest is bound to the attempt and workspace the **worker** opened;
 *   - the `diff` is stored, served, and demoted;
 *   - an adapter cannot produce the reserved kind at all;
 *   - a manifest whose bytes do not match its digest is refused, not stored;
 *   - a content-addressed row is never re-attributed to a later attempt.
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

beforeAll(async () => {
  if (!enabled) return;

  const database = useTestDatabase();
  client = database.client;
  workspaceRoot = await mkdtemp(join(tmpdir(), 'intelligenz-evidence-db-'));

  process.env['DATABASE_URL'] = database.url;
  process.env['WORKSPACE_ROOT'] = workspaceRoot;

  resetWorkerConfig();
  resetAgentRuntime();
});

afterAll(async () => {
  if (!enabled) return;

  for (const fixture of tenants) await dropTenant(client, fixture);
  await client.$disconnect();
});

interface Arrangement {
  readonly tenant: TenantFixture;
  readonly task: TaskFixture;
  readonly attemptId: string;
  readonly workspaceId: string;
  readonly rootPath: string;
  readonly summary: Awaited<ReturnType<typeof captureFinalEvidence>>;
  readonly diffPath: string;
}

/**
 * A real workspace, a real snapshot pair, a real attempt row.
 *
 * The evidence comes from the production writer rather than a hand-built object: a test
 * that manufactures the summary would prove the test's idea of the manifest, not the
 * worker's.
 */
async function arrange(label: string): Promise<Arrangement> {
  const fixture = await tenant(label);
  const task = await createTask(client, fixture, { title: `${label} task` });

  const workspaceId = executionWorkspaceIdFor(task.workflowRunId, 1);
  const manager = createWorkspaceManager({ root: workspaceRoot });
  const handle = await manager.provision({
    orgId: fixture.orgId,
    taskId: task.taskId,
    workspaceId,
    source: { kind: 'empty' },
  });

  await client.executionWorkspace.create({
    data: {
      id: workspaceId,
      orgId: fixture.orgId,
      taskId: task.taskId,
      state: 'ready',
      rootPath: handle.rootPath,
      sourceKind: 'empty',
      readyAt: new Date(),
    },
  });

  const attempt = await client.executionAttempt.create({
    data: {
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
      attemptNumber: 1,
      runtimeId: 'local-simulated',
      simulated: true,
      status: 'running',
      startedAt: new Date(),
    },
    select: { id: true },
  });

  const initial = await captureInitialEvidence(handle);
  if (initial === null) throw new Error('baseline capture failed in the fixture');

  // One changed byte, so the manifest has something true to say.
  await writeFile(join(handle.repoPath, 'answer.txt'), 'COMPROMISED\n', { mode: 0o600 });

  const summary = await captureFinalEvidence({ handle, initial });
  if (summary === null) throw new Error('final capture failed in the fixture');

  const diffPath = join(handle.rootPath, 'artifacts', 'diff.patch');
  await mkdir(join(handle.rootPath, 'artifacts'), { recursive: true });
  await writeFile(diffPath, '# git status --porcelain\n M answer.txt\n# git diff\n');

  return {
    tenant: fixture,
    task,
    attemptId: attempt.id,
    workspaceId,
    rootPath: handle.rootPath,
    summary,
    diffPath,
  };
}

function resultFor(arrangement: Arrangement): ExecutionResult {
  return {
    status: 'succeeded',
    summary: 'ran',
    artifacts: [
      {
        kind: 'diff',
        uri: arrangement.diffPath,
        checksum: 'a'.repeat(64),
        sizeBytes: 42,
        mediaType: 'text/x-diff',
      },
    ],
    events: [],
    usage: { tokensIn: 1, tokensOut: 1, usd: 0 },
    runtimeId: 'local-simulated',
    simulated: true,
    providerMeta: { workspaceId: arrangement.workspaceId, model: 'simulated' },
  };
}

/**
 * A second directory for the same task, under the id attempt `attemptNumber` leases.
 *
 * `agentRunId` is left null deliberately: `persistResult` is what writes that link, so it is
 * empty at the moment the row is resolved — which is why the resolution cannot read it and
 * must use the attempt's own identity instead.
 */
async function provisionAttemptWorkspace(
  fixture: TenantFixture,
  task: TaskFixture,
  attemptNumber: number,
): Promise<{ readonly workspaceId: string; readonly handle: WorkspaceHandle }> {
  const workspaceId = executionWorkspaceIdFor(task.workflowRunId, attemptNumber);
  const manager = createWorkspaceManager({ root: workspaceRoot });
  const handle = await manager.provision({
    orgId: fixture.orgId,
    taskId: task.taskId,
    workspaceId,
    source: { kind: 'empty' },
  });

  await client.executionWorkspace.create({
    data: {
      id: workspaceId,
      orgId: fixture.orgId,
      taskId: task.taskId,
      state: 'ready',
      rootPath: handle.rootPath,
      sourceKind: 'empty',
      readyAt: new Date(),
    },
  });

  return { workspaceId, handle };
}

/** One attempt row. `persistResult` binds to the newest, so the order of calls is the order of attempts. */
async function addAttempt(
  fixture: TenantFixture,
  task: TaskFixture,
  attemptNumber: number,
): Promise<{ readonly id: string }> {
  return client.executionAttempt.create({
    data: {
      orgId: fixture.orgId,
      taskId: task.taskId,
      workflowRunId: task.workflowRunId,
      attemptNumber,
      runtimeId: 'local-simulated',
      simulated: true,
      status: 'running',
      startedAt: new Date(),
    },
    select: { id: true },
  });
}

describe.runIf(enabled)('artifact provenance — the manifest is authority, the diff is a report', () => {
  it('binds the change manifest to the attempt and workspace the worker opened', async () => {
    const arrangement = await arrange('evidence-bound');
    const summary = arrangement.summary;
    if (summary === null) throw new Error('unreachable');

    await persistResult({
      orgId: arrangement.tenant.orgId,
      taskId: arrangement.task.taskId,
      result: { ...resultFor(arrangement), evidence: summary },
    });

    const rows = await client.artifact.findMany({
      where: { orgId: arrangement.tenant.orgId, taskId: arrangement.task.taskId },
    });

    const manifest = rows.find((row) => row.kind === 'change-manifest');
    const diff = rows.find((row) => row.kind === 'diff');

    expect(manifest).toMatchObject({
      evidenceSource: 'host-snapshot',
      authoritative: true,
      attemptId: arrangement.attemptId,
      workspaceId: arrangement.workspaceId,
      manifestDigest: summary.manifestDigest,
      initialManifestDigest: summary.initialManifestDigest,
      finalManifestDigest: summary.finalManifestDigest,
      checksum: summary.manifestDigest,
    });

    // The file the row points at is the file the digest describes.
    expect(await readFile(manifest?.uri ?? '', 'utf8')).toBe(
      await readFile(join(evidencePath(arrangement.rootPath), CHANGE_MANIFEST_FILE), 'utf8'),
    );

    // The diff is kept — it is the most readable view of a change — and demoted. Both
    // facts matter: deleting it would lose information, and keeping it undemoted would
    // let a program the agent controls answer the question the manifest exists to answer.
    expect(diff).toMatchObject({
      evidenceSource: 'git-in-sandbox',
      authoritative: false,
      manifestDigest: null,
    });

    // The trail says who produced the claim, and it is not an adapter name.
    const evidence = await client.evidence.findFirst({
      where: { orgId: arrangement.tenant.orgId, kind: 'change_manifest' },
    });
    expect(evidence?.producedBy).toBe('host-snapshot');
  });

  it('refuses a `change-manifest` that arrived through the adapter artifact list', async () => {
    const arrangement = await arrange('evidence-forged-kind');
    const summary = arrangement.summary;
    if (summary === null) throw new Error('unreachable');

    const forged: ExecutionResult = {
      ...resultFor(arrangement),
      artifacts: [
        {
          kind: 'change-manifest',
          uri: join(arrangement.rootPath, 'forged.json'),
          checksum: 'b'.repeat(64),
          sizeBytes: 10,
        },
      ],
    };

    await expect(
      persistResult({
        orgId: arrangement.tenant.orgId,
        taskId: arrangement.task.taskId,
        result: forged,
      }),
    ).rejects.toThrow(/EVIDENCE_KIND_RESERVED|only be produced by the worker/);

    // The transaction rolled back: no artifact row, and no AgentRun either.
    expect(
      await client.artifact.count({ where: { orgId: arrangement.tenant.orgId } }),
    ).toBe(0);

    // And an adapter cannot smuggle one *alongside* a legitimate evidence summary.
    await expect(
      persistResult({
        orgId: arrangement.tenant.orgId,
        taskId: arrangement.task.taskId,
        result: { ...forged, evidence: summary },
      }),
    ).rejects.toThrow(/EVIDENCE_KIND_RESERVED|only be produced by the worker/);
  });

  it('refuses a manifest whose bytes do not match the digest it claims', async () => {
    const arrangement = await arrange('evidence-tampered');
    const summary = arrangement.summary;
    if (summary === null) throw new Error('unreachable');

    // One byte after the digest was recorded. This is the "content and provenance cannot
    // be changed independently" property: editing the body breaks the checksum, and
    // editing the summary breaks the body.
    const path = join(evidencePath(arrangement.rootPath), CHANGE_MANIFEST_FILE);
    const original = await readFile(path, 'utf8');
    await writeFile(path, original.replace('"added"', '"deleted"'));

    await expect(
      persistResult({
        orgId: arrangement.tenant.orgId,
        taskId: arrangement.task.taskId,
        result: { ...resultFor(arrangement), evidence: summary },
      }),
    ).rejects.toThrow(/EVIDENCE_INTEGRITY_FAILED|does not describe its own bytes/);

    expect(await client.artifact.count({ where: { orgId: arrangement.tenant.orgId } })).toBe(0);
  });

  /**
   * F-G6 — the body must agree with the record, not only with itself.
   *
   * The pre-fix check was: `checksum === manifestDigest`, the file's length, and the file's
   * hash. Every one of those is satisfied by a body rewritten to `complete: false,
   * changeCount: 0, changes: []` and presented with a re-hashed envelope, because all the
   * values agree with each other and none of them agrees with the run. The record they have
   * to agree with is `ExecutionWorkspace`, written by the worker before the agent existed.
   */
  it('refuses an internally consistent body that claims a different final tree than the workspace recorded', async () => {
    // The positive control first, or "refused" below proves only that something is broken.
    const control = await arrange('evidence-workspace-binding-control');
    const controlSummary = control.summary;
    if (controlSummary === null) throw new Error('unreachable');

    // The record production writes: both digests, before the summary is returned.
    await client.executionWorkspace.update({
      where: { id: control.workspaceId },
      data: {
        initialManifestDigest: controlSummary.initialManifestDigest,
        finalManifestDigest: controlSummary.finalManifestDigest,
      },
    });

    await persistResult({
      orgId: control.tenant.orgId,
      taskId: control.task.taskId,
      result: { ...resultFor(control), evidence: controlSummary },
    });

    const persisted = await client.artifact.findFirst({
      where: { orgId: control.tenant.orgId, kind: 'change-manifest' },
    });
    expect(persisted?.authoritative).toBe(true);

    // ── The forgery ─────────────────────────────────────────────────────────
    const arrangement = await arrange('evidence-workspace-binding-forged');
    const summary = arrangement.summary;
    if (summary === null) throw new Error('unreachable');

    await client.executionWorkspace.update({
      where: { id: arrangement.workspaceId },
      data: {
        initialManifestDigest: summary.initialManifestDigest,
        finalManifestDigest: summary.finalManifestDigest,
      },
    });

    const path = join(evidencePath(arrangement.rootPath), CHANGE_MANIFEST_FILE);
    const body = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    const forgedFinal = 'b'.repeat(64);

    // Self-consistent in every way the old check looked at: the body is re-serialised
    // canonically, its digest is recomputed, and the envelope is rewritten to match.
    (body['final'] as Record<string, unknown>)['digest'] = forgedFinal;
    const bytes = Buffer.from(serialiseManifest(body as never), 'utf8');
    const digest = manifestDigest(body as never);

    await writeFile(path, bytes);

    await expect(
      persistResult({
        orgId: arrangement.tenant.orgId,
        taskId: arrangement.task.taskId,
        result: {
          ...resultFor(arrangement),
          evidence: {
            ...summary,
            manifestDigest: digest,
            finalManifestDigest: forgedFinal,
            artifact: { ...summary.artifact, checksum: digest, sizeBytes: bytes.byteLength },
          },
        },
      }),
    ).rejects.toThrow(/EVIDENCE_INTEGRITY_FAILED|workspace recorded final/);

    expect(
      await client.artifact.count({ where: { orgId: arrangement.tenant.orgId, authoritative: true } }),
    ).toBe(0);
  });

  it('refuses an authoritative claim whose own body says the walk was incomplete', async () => {
    const arrangement = await arrange('evidence-body-incomplete');
    const summary = arrangement.summary;
    if (summary === null) throw new Error('unreachable');

    const path = join(evidencePath(arrangement.rootPath), CHANGE_MANIFEST_FILE);
    const body = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;

    // The reviewer's probe: a body that no longer claims to have seen the whole tree,
    // re-hashed and presented with an envelope that agrees with it — except that the
    // envelope still calls itself authority.
    body['complete'] = false;
    body['stopReason'] = 'final-incomplete';
    body['changes'] = [];
    body['changeCount'] = 0;

    const bytes = Buffer.from(serialiseManifest(body as never), 'utf8');
    const digest = manifestDigest(body as never);

    await writeFile(path, bytes);

    await expect(
      persistResult({
        orgId: arrangement.tenant.orgId,
        taskId: arrangement.task.taskId,
        result: {
          ...resultFor(arrangement),
          evidence: {
            ...summary,
            manifestDigest: digest,
            complete: false,
            authoritative: true,
            changeCount: 0,
            artifact: { ...summary.artifact, checksum: digest, sizeBytes: bytes.byteLength },
          },
        },
      }),
    ).rejects.toThrow(/authoritative manifest cannot describe an incomplete walk/);
  });

  it('refuses a manifest body that is not JSON, rather than crashing', async () => {
    const arrangement = await arrange('evidence-body-garbage');
    const summary = arrangement.summary;
    if (summary === null) throw new Error('unreachable');

    const path = join(evidencePath(arrangement.rootPath), CHANGE_MANIFEST_FILE);
    const bytes = Buffer.from('this is not a manifest\n', 'utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');

    await writeFile(path, bytes);

    await expect(
      persistResult({
        orgId: arrangement.tenant.orgId,
        taskId: arrangement.task.taskId,
        result: {
          ...resultFor(arrangement),
          evidence: {
            ...summary,
            manifestDigest: digest,
            artifact: { ...summary.artifact, checksum: digest, sizeBytes: bytes.byteLength },
          },
        },
      }),
    ).rejects.toThrow(/EVIDENCE_INTEGRITY_FAILED|not JSON/);
  });

  it('does not re-attribute a content-addressed manifest to a later attempt', async () => {
    const arrangement = await arrange('evidence-reattribution');
    const summary = arrangement.summary;
    if (summary === null) throw new Error('unreachable');

    await persistResult({
      orgId: arrangement.tenant.orgId,
      taskId: arrangement.task.taskId,
      result: { ...resultFor(arrangement), evidence: summary },
    });

    // A second attempt of the same run. `persistResult` resolves the *newest* attempt, so
    // this is the shape that would rebind the row if the upsert updated provenance.
    const second = await client.executionAttempt.create({
      data: {
        orgId: arrangement.tenant.orgId,
        taskId: arrangement.task.taskId,
        workflowRunId: arrangement.task.workflowRunId,
        attemptNumber: 2,
        runtimeId: 'local-simulated',
        simulated: true,
        status: 'running',
        startedAt: new Date(),
      },
      select: { id: true },
    });

    // Byte-identical evidence — the same tree, so the same digest, so the same row id.
    await persistResult({
      orgId: arrangement.tenant.orgId,
      taskId: arrangement.task.taskId,
      result: { ...resultFor(arrangement), evidence: summary },
    });

    const manifest = await client.artifact.findFirst({
      where: { orgId: arrangement.tenant.orgId, kind: 'change-manifest' },
    });

    // Still the first attempt's row. Those bytes were first recorded from attempt 1, and
    // moving the link would re-attribute history to whichever run persisted last.
    expect(manifest?.attemptId).toBe(arrangement.attemptId);
    expect(manifest?.attemptId).not.toBe(second.id);
  });

  it('reports a row written before the columns existed as unattributed and non-authoritative', async () => {
    const arrangement = await arrange('evidence-legacy');

    await client.artifact.create({
      data: {
        orgId: arrangement.tenant.orgId,
        taskId: arrangement.task.taskId,
        runtimeId: 'local-simulated',
        kind: 'diff',
        uri: arrangement.diffPath,
        checksum: 'c'.repeat(64),
        sizeBytes: 3n,
      },
    });

    const legacy = await client.artifact.findFirst({
      where: { orgId: arrangement.tenant.orgId, checksum: 'c'.repeat(64) },
    });

    // NULL is not "unknown, so probably authority". The defaults are the honest answer for
    // every row written before the distinction existed.
    expect(legacy?.attemptId).toBeNull();
    expect(legacy?.workspaceId).toBeNull();
    expect(legacy?.evidenceSource).toBeNull();
    expect(legacy?.authoritative).toBe(false);
    expect(legacy?.manifestDigest).toBeNull();
  });

  /**
   * Gate G, correction 1: the workspace link is **derived**, not proposed.
   *
   * `resolveWorkspaceId` used to take `result.providerMeta["workspaceId"]` and accept it if
   * it named any `ExecutionWorkspace` row in the same org and task. Adapter output therefore
   * decided which tree the artifact claimed its bytes came from — bounded to the task, so no
   * cross-tenant read, but still the agent influencing the provenance this gate exists to
   * establish. Both tests below fail against that code.
   */
  it("attributes the manifest to the attempt's own directory, never the sibling the adapter names", async () => {
    const arrangement = await arrange('evidence-sibling-named');

    // What the adapter claims: attempt 1's directory. It is real, it belongs to this org and
    // this task, and it is exactly the value the removed `candidate` parameter accepted.
    const claimed = arrangement.workspaceId;

    // What attempt 2 actually leased. Same task, different directory — the sibling.
    const own = await provisionAttemptWorkspace(arrangement.tenant, arrangement.task, 2);

    const initial = await captureInitialEvidence(own.handle);
    if (initial === null) throw new Error('baseline capture failed for attempt 2');
    await writeFile(join(own.handle.repoPath, 'answer.txt'), 'from attempt 2\n', { mode: 0o600 });

    const summary = await captureFinalEvidence({ handle: own.handle, initial });
    if (summary === null) throw new Error('final capture failed for attempt 2');

    const second = await addAttempt(arrangement.tenant, arrangement.task, 2);

    await persistResult({
      orgId: arrangement.tenant.orgId,
      taskId: arrangement.task.taskId,
      result: {
        ...resultFor(arrangement),
        providerMeta: { workspaceId: claimed, model: 'simulated' },
        evidence: summary,
      },
    });

    const manifest = await client.artifact.findFirst({
      where: { orgId: arrangement.tenant.orgId, kind: 'change-manifest' },
    });

    // The row names the directory the worker leased for this attempt, and the sibling the
    // adapter asked for is nowhere in it.
    expect(manifest?.attemptId).toBe(second.id);
    expect(manifest?.workspaceId).toBe(own.workspaceId);
    expect(manifest?.workspaceId).not.toBe(claimed);
    expect(manifest?.authoritative).toBe(true);
  });

  it('leaves a manifest unbound, and non-authoritative, when the attempt leased no directory', async () => {
    const arrangement = await arrange('evidence-sibling-unbound');
    const summary = arrangement.summary;
    if (summary === null) throw new Error('unreachable');

    // A newer attempt that leased nothing (a runtime that needs no workspace, or a
    // provisioning failure). The adapter still names attempt 1's directory, and that row
    // exists — so a resolution that accepts proposals finds an answer here. There is no
    // honest one: this attempt has no tree, so its manifest cannot be said to describe one.
    await addAttempt(arrangement.tenant, arrangement.task, 2);

    await persistResult({
      orgId: arrangement.tenant.orgId,
      taskId: arrangement.task.taskId,
      result: { ...resultFor(arrangement), evidence: summary },
    });

    const manifest = await client.artifact.findFirst({
      where: { orgId: arrangement.tenant.orgId, kind: 'change-manifest' },
    });

    // The bytes are still recorded and still verified — the claim is real, it is just
    // unbound. `null` forces `authoritative = false`, so the failure direction is "less
    // claim", never more.
    expect(manifest?.manifestDigest).toBe(summary.manifestDigest);
    expect(manifest?.workspaceId).toBeNull();
    expect(manifest?.authoritative).toBe(false);

    // And the run record does not claim a directory either.
    const run = await client.agentRun.findFirst({
      where: { orgId: arrangement.tenant.orgId, workflowRunId: arrangement.task.workflowRunId },
    });
    expect(run?.workspaceId).toBeNull();
  });

  /**
   * The other half of the `authoritative` rule, which correction 1 must not disturb:
   * `evidence.authoritative && workspaceId !== null`. A manifest that *is* bound is still not
   * authority when the walk that produced it stopped early. Binding and completeness are
   * separate facts, and only their conjunction is a claim.
   */
  it('records an incomplete manifest without granting it authority, even when the workspace binds', async () => {
    const arrangement = await arrange('evidence-incomplete');

    const own = await provisionAttemptWorkspace(arrangement.tenant, arrangement.task, 2);

    const initial = await captureInitialEvidence(own.handle);
    if (initial === null) throw new Error('baseline capture failed for attempt 2');

    // Two changed paths against a manifest capped at one: the walk stops early and says so.
    await writeFile(join(own.handle.repoPath, 'a.txt'), 'a\n', { mode: 0o600 });
    await writeFile(join(own.handle.repoPath, 'b.txt'), 'b\n', { mode: 0o600 });

    const summary = await captureFinalEvidence({ handle: own.handle, initial, maxChanges: 1 });
    if (summary === null) throw new Error('final capture failed for attempt 2');

    // The walk's own verdict, not this activity's: the summary is what the host measured.
    expect(summary.authoritative).toBe(false);

    const second = await addAttempt(arrangement.tenant, arrangement.task, 2);

    await persistResult({
      orgId: arrangement.tenant.orgId,
      taskId: arrangement.task.taskId,
      result: { ...resultFor(arrangement), evidence: summary },
    });

    const manifest = await client.artifact.findFirst({
      where: { orgId: arrangement.tenant.orgId, kind: 'change-manifest' },
    });

    // Bound to the attempt's own directory, so the `false` below is incompleteness and not a
    // missing link: a workspace that resolves does not promote an incomplete walk.
    expect(manifest?.attemptId).toBe(second.id);
    expect(manifest?.workspaceId).toBe(own.workspaceId);
    expect(manifest?.authoritative).toBe(false);
  });
});
