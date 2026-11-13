import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { authHeaders, login, startSuite, type Suite } from './helpers/app';
import type { ApiErrorBody, DataBody } from './helpers/api-types';

/**
 * Execution history and artifact integrity.
 *
 * The Phase 2 gap this closes: artifacts were written, never read back, and the
 * checksum was never re-verified. Every assertion below is about bytes on disk, not
 * about a column — a stored "ok" is exactly what this endpoint refuses to trust.
 *
 * Three failure modes get a status code of their own:
 *
 *   - bytes disagree with the checksum → `409 ARTIFACT_INTEGRITY_FAILED`
 *   - bytes are gone                     → `410 ARTIFACT_GONE`
 *   - the row points outside every root  → `404`, never the path
 */

interface AttemptBody {
  id: string;
  attemptNumber: number;
  runtimeId: string;
  runtimeVersion: string | null;
  simulated: boolean;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: string | null;
  error: unknown;
  workspace: { id: string; state: string; sourceKind: string; baseCommit: string | null } | null;
}

interface ArtifactBody {
  id: string;
  taskId: string;
  kind: string;
  uri: string;
  checksum: string;
  sizeBytes: number;
  integrity: 'verified' | 'failed' | 'unknown';
  mediaType: string;
}

interface DetailBody {
  attempt: AttemptBody;
  toolInvocations: { id: string; sequence: number; tool: string; summary: string; occurredAt: string }[];
  artifacts: ArtifactBody[];
}

const TRANSCRIPT = [
  '{"type":"step_start","sessionID":"ses_test","part":{"type":"step-start"}}',
  '{"type":"tool","part":{"tool":"read","state":{"input":{"filePath":"src/sum.js"}}}}',
  '{"type":"text","part":{"type":"text","text":"fixed the sum"}}',
  '',
].join('\n');

let suite: Suite;
let ownerToken: string;
let ownerBToken: string;
let memberToken: string;
let viewerToken: string;
let attemptId: string;
let artifactId: string;
let diffArtifactId: string;
let traversalArtifactId: string;
let artifactRoot: string;
let workspaceRoot: string;
let transcriptPath: string;
const checksum = createHash('sha256').update(Buffer.from(TRANSCRIPT, 'utf8')).digest('hex');

beforeAll(async () => {
  artifactRoot = await mkdtemp(join(tmpdir(), 'intelligenz-api-artifacts-'));
  workspaceRoot = await mkdtemp(join(tmpdir(), 'intelligenz-api-workspaces-'));

  suite = await startSuite({ appOverrides: { artifactRoot, workspaceRoot } });

  ownerToken = await login(suite.app, suite.fixtures.users.ownerA.email);
  ownerBToken = await login(suite.app, suite.fixtures.users.ownerB.email);
  memberToken = await login(suite.app, suite.fixtures.users.memberA.email);
  viewerToken = await login(suite.app, suite.fixtures.users.viewerA.email);

  const orgId = suite.fixtures.orgA.id;
  const taskId = suite.fixtures.tasks.draftA;
  const startedAt = new Date('2026-11-13T10:00:00.000Z');
  const finishedAt = new Date('2026-11-13T10:00:42.000Z');

  const workspace = await suite.prisma.executionWorkspace.create({
    data: {
      orgId,
      taskId,
      state: 'completed',
      rootPath: join(workspaceRoot, 'org', 'task', 'workspace-1'),
      sourceKind: 'clone',
      baseCommit: 'a'.repeat(40),
      branch: 'main',
      readyAt: startedAt,
      cleanedAt: finishedAt,
    },
  });

  const workflowRun = await suite.prisma.workflowRun.create({
    data: {
      orgId,
      taskId,
      workflowId: `task-${taskId}`,
      status: 'succeeded',
      startedAt,
      finishedAt,
    },
  });

  const attempt = await suite.prisma.executionAttempt.create({
    data: {
      orgId,
      taskId,
      workflowRunId: workflowRun.id,
      attemptNumber: 1,
      runtimeId: 'opencode-cli',
      simulated: false,
      status: 'succeeded',
      startedAt,
      finishedAt,
    },
  });

  attemptId = attempt.id;

  const agentRun = await suite.prisma.agentRun.create({
    data: {
      orgId,
      workflowRunId: workflowRun.id,
      runtimeId: 'opencode-cli',
      model: 'commandcode/deepseek/deepseek-v4-flash',
      status: 'succeeded',
      startedAt,
      finishedAt,
      tokensIn: 43_598,
      tokensOut: 120,
      costUsd: 0.000452,
      attemptNumber: 1,
      simulated: false,
      runtimeVersion: '2.2.7',
      workspaceId: workspace.id,
      providerMeta: { model: 'commandcode/deepseek/deepseek-v4-flash', steps: 4 },
    },
  });

  await suite.prisma.executionAttempt.update({
    where: { id: attempt.id },
    data: { agentRunId: agentRun.id },
  });
  await suite.prisma.executionWorkspace.update({
    where: { id: workspace.id },
    data: { agentRunId: agentRun.id },
  });

  await suite.prisma.toolInvocation.createMany({
    data: [
      {
        orgId,
        agentRunId: agentRun.id,
        sequence: 1,
        tool: 'read',
        summary: 'read src/sum.js',
        occurredAt: startedAt,
      },
      {
        orgId,
        agentRunId: agentRun.id,
        sequence: 2,
        tool: 'edit',
        summary: 'edit src/sum.js',
        occurredAt: new Date(startedAt.getTime() + 5_000),
      },
      {
        orgId,
        agentRunId: agentRun.id,
        sequence: 3,
        tool: 'bash',
        summary: 'bash node --test (3 passed)',
        occurredAt: new Date(startedAt.getTime() + 20_000),
      },
    ],
  });

  // The bytes live where the worker would have materialised them: inside the
  // workspace's durable artifacts directory.
  const artifactsDirectory = join(workspaceRoot, 'org', 'task', 'workspace-1', 'artifacts');
  await mkdir(artifactsDirectory, { recursive: true, mode: 0o700 });
  transcriptPath = join(artifactsDirectory, 'transcript.ndjson');
  await writeFile(transcriptPath, TRANSCRIPT, { mode: 0o600 });

  const artifact = await suite.prisma.artifact.create({
    data: {
      orgId,
      taskId,
      runtimeId: 'opencode-cli',
      kind: 'transcript',
      uri: transcriptPath,
      checksum,
      sizeBytes: Buffer.byteLength(TRANSCRIPT, 'utf8'),
      // Persisted during the attempt, as the worker does. The detail endpoint
      // attributes artifacts by (task, runtime, time window) because the schema has
      // no `attemptId` on Artifact.
      createdAt: finishedAt,
    },
  });

  artifactId = artifact.id;

  // A `diff` artifact from the same run. It exists so the transcript restriction can be
  // shown as *narrow*: a VIEWER keeps the redacted diff, and loses only the raw stream.
  const diffBody = '# git status --porcelain\n M src/sum.js\n';
  const diffPath = join(artifactsDirectory, 'diff.patch');
  await writeFile(diffPath, diffBody, { mode: 0o600 });

  const diff = await suite.prisma.artifact.create({
    data: {
      orgId,
      taskId,
      runtimeId: 'opencode-cli',
      kind: 'diff',
      uri: diffPath,
      checksum: createHash('sha256').update(Buffer.from(diffBody, 'utf8')).digest('hex'),
      sizeBytes: Buffer.byteLength(diffBody, 'utf8'),
      createdAt: finishedAt,
    },
  });

  diffArtifactId = diff.id;

  const traversal = await suite.prisma.artifact.create({
    data: {
      orgId,
      taskId,
      runtimeId: 'opencode-cli',
      kind: 'report',
      // A hostile or corrupt row: an absolute path outside every configured root.
      uri: '/etc/passwd',
      checksum: 'b'.repeat(64),
      sizeBytes: 1,
      createdAt: finishedAt,
    },
  });

  traversalArtifactId = traversal.id;
});

afterAll(async () => {
  await suite.close();
  await rm(artifactRoot, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

function path(taskId: string): string {
  return `/v1/orgs/${suite.fixtures.orgA.id}/tasks/${taskId}/executions`;
}

describe('GET /executions', () => {
  it('lists attempts newest first with the run facts flattened in', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(path(suite.fixtures.tasks.draftA))
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const body = response.body as DataBody<AttemptBody[]>;

    expect(body.data).toHaveLength(1);

    const attempt = body.data[0]!;

    expect(attempt.attemptNumber).toBe(1);
    expect(attempt.runtimeId).toBe('opencode-cli');
    expect(attempt.runtimeVersion).toBe('2.2.7');
    expect(attempt.simulated).toBe(false);
    expect(attempt.status).toBe('succeeded');
    expect(attempt.durationMs).toBe(42_000);
    expect(attempt.tokensIn).toBe(43_598);
    expect(attempt.costUsd).toBe('0.0005');
    expect(attempt.workspace).toMatchObject({ state: 'completed', sourceKind: 'clone' });
    // Never the host path.
    expect(JSON.stringify(attempt)).not.toContain(workspaceRoot);
  });

  it('answers 404 for a task in another organisation', async () => {
    await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgB.id}/tasks/${suite.fixtures.tasks.draftA}/executions`)
      .set(authHeaders(ownerBToken, suite.fixtures.orgB.id))
      .expect(404);
  });
});

describe('GET /executions/:attemptId', () => {
  it('returns the attempt with its ordered tool trace and its artifacts', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`${path(suite.fixtures.tasks.draftA)}/${attemptId}`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const body = response.body as DataBody<DetailBody>;

    expect(body.data.attempt.id).toBe(attemptId);
    expect(body.data.toolInvocations.map((row) => row.sequence)).toEqual([1, 2, 3]);
    expect(body.data.toolInvocations[2]?.tool).toBe('bash');

    const transcript = body.data.artifacts.find((artifact) => artifact.kind === 'transcript');
    expect(transcript).toBeDefined();
    expect(transcript?.integrity).toBe('verified');
    expect(transcript?.uri).toBe('org/task/workspace-1/artifacts/transcript.ndjson');
  });

  it('answers 404 for an attempt belonging to a different tenant', async () => {
    await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgB.id}/tasks/${suite.fixtures.tasks.draftB}/executions/${attemptId}`)
      .set(authHeaders(ownerBToken, suite.fixtures.orgB.id))
      .expect(404);
  });
});

describe('GET /artifacts/:artifactId', () => {
  it('reports integrity as verified and a logical uri', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${artifactId}`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const body = response.body as DataBody<ArtifactBody>;

    expect(body.data.integrity).toBe('verified');
    expect(body.data.checksum).toBe(checksum);
    expect(body.data.sizeBytes).toBe(Buffer.byteLength(TRANSCRIPT, 'utf8'));
    expect(body.data.uri.endsWith('transcript.ndjson')).toBe(true);
    expect(body.data.uri.startsWith('/')).toBe(false);
    expect(JSON.stringify(body.data)).not.toContain(workspaceRoot);
  });

  it('reports unknown, not verified, when the file is gone', async () => {
    await unlink(transcriptPath);

    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${artifactId}`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    expect((response.body as DataBody<ArtifactBody>).data.integrity).toBe('unknown');

    // Restore for the content tests below.
    await writeFile(transcriptPath, TRANSCRIPT, { mode: 0o600 });
  });

  it('never serves a path outside the configured roots', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${traversalArtifactId}`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    const body = response.body as DataBody<ArtifactBody>;

    expect(body.data.integrity).toBe('unknown');
    expect(body.data.uri).toBe('external/passwd');
  });
});

describe('GET /artifacts/:artifactId/content', () => {
  it('streams the bytes with their checksum when they match', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${artifactId}/content`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      // NDJSON is not JSON: superagent's default parser sees "json" in the media type
      // and would try to parse the whole stream as one document. Asking for raw bytes
      // is what a real client (and the checksum) expects.
      .responseType('arraybuffer')
      .expect(200);

    const received = Buffer.from(response.body as ArrayBuffer).toString('utf8');

    expect(createHash('sha256').update(received, 'utf8').digest('hex')).toBe(checksum);
    expect(response.headers['x-artifact-checksum']).toBe(checksum);
    expect(response.headers['content-type']).toContain('application/x-ndjson');
  });

  it('refuses tampered bytes with 409 ARTIFACT_INTEGRITY_FAILED', async () => {
    await writeFile(transcriptPath, `${TRANSCRIPT}{"type":"injected"}\n`, { mode: 0o600 });

    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${artifactId}/content`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(409);

    expect((response.body as ApiErrorBody).error.code).toBe('ARTIFACT_INTEGRITY_FAILED');

    // The metadata endpoint agrees — computed at read time, not remembered.
    const metadata = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${artifactId}`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(200);

    expect((metadata.body as DataBody<ArtifactBody>).data.integrity).toBe('failed');

    // Restore the original bytes; a later test must not inherit the tamper.
    await writeFile(transcriptPath, TRANSCRIPT, { mode: 0o600 });
  });

  it('refuses a row outside every root with 404, not with a path', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${traversalArtifactId}/content`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(404);

    expect((response.body as ApiErrorBody).error.code).toBe('NOT_FOUND');
  });

  it('answers 410 ARTIFACT_GONE when the file has disappeared', async () => {
    await unlink(transcriptPath);

    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${artifactId}/content`)
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .expect(410);

    expect((response.body as ApiErrorBody).error.code).toBe('ARTIFACT_GONE');

    await writeFile(transcriptPath, TRANSCRIPT, { mode: 0o600 });
  });
});

/**
 * Raw transcripts are `ADMIN`+.
 *
 * A transcript is whatever the agent read, printed or was told: model output, shell
 * output, file contents. It is redacted at collection time, but it remains the highest
 * risk artifact the platform stores, and downloading it is an administrative act. These
 * tests pin the boundary in both directions — the raw stream is refused to a `MEMBER`
 * and a `VIEWER`; the redacted `diff` and the metadata are not.
 */
describe('GET /artifacts/:artifactId/content — raw transcript authorisation', () => {
  const transcriptContentUrl = (): string =>
    `/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${artifactId}/content`;

  it('refuses the raw transcript to a VIEWER with 403 and no bytes', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(transcriptContentUrl())
      .set(authHeaders(viewerToken, suite.fixtures.orgA.id))
      .expect(403);

    expect((response.body as ApiErrorBody).error.code).toBe('FORBIDDEN');
    // A refused request must not leak the body it refused to serve.
    expect(JSON.stringify(response.body)).not.toContain('ses_test');
  });

  it('refuses the raw transcript to a MEMBER with 403', async () => {
    await request(suite.app.getHttpServer())
      .get(transcriptContentUrl())
      .set(authHeaders(memberToken, suite.fixtures.orgA.id))
      .expect(403);
  });

  it('still serves the metadata of a transcript to a VIEWER', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${artifactId}`)
      .set(authHeaders(viewerToken, suite.fixtures.orgA.id))
      .expect(200);

    expect((response.body as DataBody<ArtifactBody>).data.kind).toBe('transcript');
  });

  it('serves the redacted diff to a VIEWER', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(`/v1/orgs/${suite.fixtures.orgA.id}/artifacts/${diffArtifactId}/content`)
      .set(authHeaders(viewerToken, suite.fixtures.orgA.id))
      .responseType('arraybuffer')
      .expect(200);

    expect(Buffer.from(response.body as ArrayBuffer).toString('utf8')).toContain('src/sum.js');
  });

  it('serves the raw transcript to an ADMIN, because that is who debugs a run', async () => {
    const response = await request(suite.app.getHttpServer())
      .get(transcriptContentUrl())
      .set(authHeaders(ownerToken, suite.fixtures.orgA.id))
      .responseType('arraybuffer')
      .expect(200);

    expect(Buffer.from(response.body as ArrayBuffer).toString('utf8')).toBe(TRANSCRIPT);
  });
});
