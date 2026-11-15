import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createWorkspaceManager, evidencePath, type WorkspaceManager } from '../src';

/**
 * `cleanup` must keep `evidence/` alive for as long as it keeps `artifacts/`.
 *
 * The reason is a digest that outlives its bytes. `ExecutionWorkspace.finalManifestDigest`
 * is a claim about a file on disk; if the sweeper deletes the file and leaves the row, the
 * platform holds a checksum nobody can ever check again — which is worse than holding
 * none, because it looks like evidence.
 *
 * The three cases below are the three shapes the old implementation got wrong: evidence
 * surviving with artifacts, evidence surviving *without* artifacts (the old guard tested
 * `exists(artifacts)` and would have deleted everything), and an explicit
 * `keepArtifacts: false` where the operator asked for the whole directory to go.
 */

const IDS = { orgId: 'org-evidence', taskId: 'task-evidence' } as const;

let root: string;
let manager: WorkspaceManager;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'intelligenz-evidence-lifecycle-'));
  manager = createWorkspaceManager({ root });
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function provision(workspaceId: string) {
  return manager.provision({ ...IDS, workspaceId, source: { kind: 'empty' } });
}

async function seedEvidence(handle: { rootPath: string }): Promise<void> {
  const directory = evidencePath(handle.rootPath);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'change-manifest.json'), '{"digest":"d"}\n');
  await writeFile(join(directory, 'initial-snapshot.json'), '{"snapshot":{}}\n');
}

describe('cleanup — evidence is preserved with the artifacts', () => {
  it('keeps evidence/ beside artifacts/ and reports both', async () => {
    const handle = await provision('ws-both');

    await mkdir(join(handle.rootPath, 'artifacts'), { recursive: true });
    await writeFile(join(handle.rootPath, 'artifacts', 'transcript.ndjson'), '{}\n');
    await seedEvidence(handle);

    const result = await manager.cleanup(handle, { keepArtifacts: true });

    expect(result.artifactsKept).toBe(true);
    expect(result.evidenceKept).toBe(true);
    expect(result.removed).toBe(false);
    expect((await readdir(handle.rootPath)).sort()).toEqual(['artifacts', 'evidence']);

    // The manifest the digest refers to is still there, byte for byte.
    expect(await readFile(join(evidencePath(handle.rootPath), 'change-manifest.json'), 'utf8')).toBe(
      '{"digest":"d"}\n',
    );
    expect(manager.get(handle.id)?.state).toBe('completed');
  });

  it('keeps evidence/ even when the adapter produced no artifacts at all', async () => {
    const handle = await provision('ws-evidence-only');
    await seedEvidence(handle);

    // The old guard was `exists(artifacts)`. A run whose adapter wrote nothing would have
    // taken the `else` branch and removed the evidence along with the checkout.
    const result = await manager.cleanup(handle, { keepArtifacts: true });

    expect(result.artifactsKept).toBe(false);
    expect(result.evidenceKept).toBe(true);
    expect(result.removed).toBe(false);
    expect(await readdir(handle.rootPath)).toEqual(['evidence']);
  });

  it('removes evidence when the operator asks for the whole directory to go', async () => {
    const handle = await provision('ws-nuke-evidence');
    await seedEvidence(handle);

    const result = await manager.cleanup(handle, { keepArtifacts: false });

    expect(result.evidenceKept).toBe(false);
    await expect(readdir(handle.rootPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
