import { mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  AgentRuntime,
  ExecutionRequest,
  ExecutionResult,
  RuntimeCapabilities,
  RuntimeHealth,
} from '@intelligenz/agent-runtime';
import type { PrismaClient } from '@intelligenz/database';
import { evidencePath } from '@intelligenz/workspace-manager';

import { persistResult } from '../src/activities/persist-result';
import { resetWorkerConfig } from '../src/config';
import { resetAgentRuntime, setAgentRuntime } from '../src/runtime';
import type { ExecuteAgentActivityResult } from '../src/shared/contracts';
import {
  createExecutionHarness,
  temporalReachable,
  type ExecutionHarness,
} from './helpers/execution-harness';
import {
  createTask,
  createTenant,
  dropTenant,
  reserveAndClaim,
  testDatabaseUrl,
  useTestDatabase,
  type TenantFixture,
} from './helpers/database';

/**
 * Where the baseline is taken — observed from inside the adapter.
 *
 * The contract's requirement is precise: the initial snapshot must precede **every
 * agent-reachable side effect**, and a baseline taken after something the agent can touch
 * is not a baseline. Source order is necessary but not sufficient evidence: a refactor can
 * move a call without moving its line, and a helper can do work eagerly.
 *
 * So this suite asks the process that is being measured. The adapter installed below is
 * the first agent-reachable thing in the run, and when it is invoked it reads:
 *
 *   - `ExecutionWorkspace.initialManifestDigest` for its own workspace, and
 *   - the contents of `<rootPath>/evidence/`,
 *
 * and records both. If the baseline were taken later, `execute()` would see `null` and an
 * empty directory. It also writes into `/workspace` — exactly the "first write" the
 * baseline must be taken before — and the manifest built afterwards must report that write
 * as an **addition**, not as pre-existing state.
 *
 * The run is real: real Temporal execution, real claim, real lease, real cgroup probe,
 * real sandbox mount table. Only the vendor adapter is replaced.
 */

const databaseUrl = testDatabaseUrl();
const enabled = databaseUrl !== undefined;
const temporalEnabled = enabled && (await temporalReachable());

let client: PrismaClient;
let harness: ExecutionHarness | undefined;
let workspaceRoot: string;
const tenants: TenantFixture[] = [];

interface Observation {
  readonly workspaceRoot: string;
  readonly initialDigestAtExecute: string | null;
  readonly evidenceFilesAtExecute: readonly string[];
  readonly snapshotAt: Date | null;
}

/**
 * The observing adapter: it does nothing a vendor would do, and it looks around before it
 * does it.
 */
class ObservingRuntime implements AgentRuntime {
  readonly id = 'observing-workspace-runtime';
  observation: Observation | undefined;

  constructor(private readonly prisma: PrismaClient) {}

  async capabilities(): Promise<RuntimeCapabilities> {
    return {
      shell: false,
      network: false,
      filesystem: 'write',
      browser: false,
      mcp: false,
      imageInput: false,
    };
  }

  async health(): Promise<RuntimeHealth> {
    return { status: 'ok', simulated: false, checkedAt: new Date().toISOString() };
  }

  async cancel(): Promise<void> {}

  async execute(req: ExecutionRequest): Promise<ExecutionResult> {
    // An adapter that needs a filesystem must refuse a request without a workspace; this
    // one is measuring that workspace, so the absence is a failed test rather than a
    // fallback to "wherever the process is".
    if (req.workspaceRoot === undefined) {
      throw new Error('ObservingRuntime requires a workspaceRoot');
    }

    // `workspaceRoot` is the workspace *root*; `allowedPaths[0]` is the checkout the
    // adapter may write — the same pair the sandbox binds. Using one as the other would
    // put a test write outside the tree it is measuring.
    const rootPath = req.workspaceRoot;
    const repoPath = req.allowedPaths[0] ?? join(rootPath, 'repo');

    const row = await this.prisma.executionWorkspace.findFirst({
      where: { rootPath },
      select: { initialManifestDigest: true, snapshotAt: true },
    });

    const directory = evidencePath(rootPath);
    const files = await readdir(directory).catch(() => [] as string[]);

    this.observation = {
      workspaceRoot: repoPath,
      initialDigestAtExecute: row?.initialManifestDigest ?? null,
      evidenceFilesAtExecute: files,
      snapshotAt: row?.snapshotAt ?? null,
    };

    // The agent's first write, inside the only read-write mount. If the baseline had not
    // already been taken, this file would be invisible in the manifest — it would look
    // like it had always been there.
    await writeFile(join(repoPath, 'agent-first-write.txt'), 'by the run\n');

    return {
      status: 'succeeded',
      summary: 'observed the workspace and wrote one file',
      artifacts: [
        {
          kind: 'diff',
          uri: join(rootPath, 'artifacts', 'diff.patch'),
          // Deliberately not the hash of anything: the diff is display-only, and a test
          // that made it verifiable would blur the line this suite is about.
          checksum: 'a'.repeat(64),
          sizeBytes: 0,
          mediaType: 'text/x-diff',
        },
      ],
      events: [],
      usage: { usd: 0 },
      runtimeId: this.id,
      simulated: false,
    };
  }
}

async function tenant(label: string): Promise<TenantFixture> {
  const created = await createTenant(client, label);
  tenants.push(created);
  return created;
}

beforeAll(async () => {
  if (!enabled) return;

  const database = useTestDatabase();
  client = database.client;
  workspaceRoot = await mkdtemp(join(tmpdir(), 'intelligenz-capture-points-'));

  process.env['DATABASE_URL'] = database.url;
  process.env['WORKSPACE_ROOT'] = workspaceRoot;
  process.env['ARTIFACT_ROOT'] = join(workspaceRoot, 'artifacts');

  resetWorkerConfig();
  resetAgentRuntime();

  if (temporalEnabled) harness = await createExecutionHarness();
});

afterAll(async () => {
  if (!enabled) return;

  resetAgentRuntime();
  await harness?.close();
  for (const fixture of tenants) await dropTenant(client, fixture);
  await client.$disconnect();
});

describe.skipIf(!temporalEnabled)('the baseline is recorded before the adapter is called', () => {
  it('is already on disk and in the row when `execute()` runs, and the first write is an addition', async () => {
    const runtime = new ObservingRuntime(client);
    setAgentRuntime(runtime);

    const fixture = await tenant('capture-point');
    const task = await createTask(client, fixture, { title: 'Capture point ordering' });

    const session = await (harness?.session() ?? Promise.reject(new Error('no harness')));

    let result: ExecuteAgentActivityResult;

    try {
      const claim = await reserveAndClaim(client, fixture, task, session.runId);

      result = await session.call<ExecuteAgentActivityResult>({
        op: 'execute',
        input: {
          taskId: task.taskId,
          orgId: fixture.orgId,
          correlationId: 'capture-point-1',
          workflowRunId: task.workflowRunId,
          attemptId: claim.attemptId,
        },
      });
    } finally {
      await session.stop();
    }

    // ── What the adapter saw ────────────────────────────────────────────────
    const observation = runtime.observation;
    expect(observation).toBeDefined();
    if (observation === undefined) return;

    // The baseline was recorded *before* the adapter was invoked. This is the assertion
    // the whole file exists for: `null` here would mean the baseline was taken after the
    // agent's process existed.
    expect(observation.initialDigestAtExecute).toMatch(/^[a-f0-9]{64}$/);
    expect(observation.snapshotAt).toBeInstanceOf(Date);

    // And the bytes were already on disk, not merely promised to be.
    expect(observation.evidenceFilesAtExecute).toContain('initial-snapshot.json');

    // ── What the workflow got back ──────────────────────────────────────────
    const evidence = result.evidence;
    expect(evidence).toBeDefined();
    if (evidence === undefined) return;

    expect(evidence.evidenceSource).toBe('host-snapshot');
    expect(evidence.authoritative).toBe(true);
    expect(evidence.initialManifestDigest).toBe(observation.initialDigestAtExecute);
    expect(evidence.finalManifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.initialManifestDigest).not.toBe(evidence.finalManifestDigest);

    // The adapter's write is a change against the baseline, not pre-existing state.
    const manifest = JSON.parse(await readFile(evidence.artifact.uri, 'utf8')) as {
      changes: { path: string; status: string; before: unknown }[];
    };

    const firstWrite = manifest.changes.find((change) => change.path === 'agent-first-write.txt');
    expect(firstWrite?.status).toBe('added');
    expect(firstWrite?.before).toBeNull();

    // ── Persistence binds it to the attempt the worker opened ───────────────
    await persistResult({
      orgId: fixture.orgId,
      taskId: task.taskId,
      result,
    });

    const artifact = await client.artifact.findFirst({
      where: { orgId: fixture.orgId, kind: 'change-manifest' },
    });

    const attempt = await client.executionAttempt.findFirst({
      where: { orgId: fixture.orgId },
      orderBy: { attemptNumber: 'desc' },
      select: { id: true },
    });

    expect(artifact?.attemptId).toBe(attempt?.id);
    expect(artifact?.authoritative).toBe(true);
    expect(artifact?.evidenceSource).toBe('host-snapshot');

    // The workspace row carries both digests, and the final one is the tree the run left.
    const workspace = await client.executionWorkspace.findFirst({
      where: { orgId: fixture.orgId },
      select: { initialManifestDigest: true, finalManifestDigest: true, snapshotAt: true },
    });

    expect(workspace?.initialManifestDigest).toBe(evidence.initialManifestDigest);
    expect(workspace?.finalManifestDigest).toBe(evidence.finalManifestDigest);
  }, 120_000);
});

