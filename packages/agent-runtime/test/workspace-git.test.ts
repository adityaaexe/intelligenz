import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSandboxCommand, createWorkspaceManager, type WorkspaceHandle } from '@intelligenz/workspace-manager';

import { collectWorkspaceEvidence } from '../src';

/**
 * F1 regression: **no host process against agent-controlled content.**
 *
 * The audited adapter ran `git -C <workspace>/repo status --porcelain` on the host after
 * every run — including cancelled, failed and timed-out runs. The workspace is
 * agent-writable, so `.git/config` (`core.fsmonitor`) and `.git/hooks/*` were
 * agent-controlled programs executed by the worker user. The audit reproduced it end to
 * end and got execution on the host as `ubuntu`.
 *
 * This suite plants exactly that payload and proves three things:
 *
 *   1. **The payload is live.** A host `git` against the same repository executes it —
 *      otherwise the other assertions would be vacuous. It runs against its own
 *      workspace so a lingering fsmonitor process cannot contaminate the others.
 *   2. **The adapter's post-run path cannot reach it.** `collectWorkspaceEvidence` runs
 *      git inside `bwrap`; no host marker appears, and the command still returns correct
 *      `--porcelain` output.
 *   3. **The sandbox alone is sufficient.** Running git inside the sandbox *without* the
 *      `-c` overrides lets the hook fire — it writes into `/workspace`, which is allowed
 *      — but it still cannot write to a path outside the sandbox. That is the property
 *      that must hold even if a future edit removes a `-c` flag.
 */

const execFileAsync = promisify(execFile);
const FIXTURE = resolve(fileURLToPath(new URL('../../../infra/fixtures/sample-repo', import.meta.url)));

const MARKER = 'executed';
const INSIDE = 'hook-ran';

function payloadFor(markerPath: string): string {
  return [
    '#!/bin/sh',
    // The host path exists only on the host. Inside the sandbox it is not resolvable,
    // which is the whole point.
    `echo pwned >> ${markerPath}`,
    // This path exists only inside the sandbox, where it is the workspace bind. A hook
    // that fires there proves execution; it does not prove escape.
    `echo pwned >> /workspace/${INSIDE}`,
    '',
  ].join('\n');
}

async function plantPayload(repoPath: string, markerPath: string): Promise<void> {
  const payload = payloadFor(markerPath);

  await writeFile(join(repoPath, 'pwn.sh'), payload, { mode: 0o755 });
  await chmod(join(repoPath, 'pwn.sh'), 0o755);

  for (const hook of ['post-checkout', 'post-index-change']) {
    const path = join(repoPath, '.git', 'hooks', hook);
    await mkdir(join(repoPath, '.git', 'hooks'), { recursive: true });
    await writeFile(path, payload, { mode: 0o755 });
    await chmod(path, 0o755);
  }

  // Agent-authored config: git runs this on every status.
  await execFileAsync('git', ['-C', repoPath, 'config', 'core.fsmonitor', './pwn.sh']);
}

describe('post-run git cannot execute agent-authored hooks on the host', () => {
  let root: string;
  let markerDir: string;
  let handle: WorkspaceHandle;
  let control: WorkspaceHandle;

  const repoPath = (): string => join(handle.rootPath, 'repo');
  const controlRepoPath = (): string => join(control.rootPath, 'repo');
  const markerPath = (): string => join(markerDir, MARKER);
  const controlMarkerPath = (): string => join(markerDir, `control-${MARKER}`);
  const insidePath = (): string => join(repoPath(), INSIDE);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'intelligenz-git-sandbox-'));
    markerDir = await mkdtemp(join(tmpdir(), 'intelligenz-git-marker-'));

    const manager = createWorkspaceManager({ root });

    const base = { orgId: 'org-sec', taskId: 'task-sec' } as const;

    handle = await manager.provision({
      ...base,
      workspaceId: 'ws-sec',
      source: { kind: 'clone', repoPath: FIXTURE },
    });
    control = await manager.provision({
      ...base,
      workspaceId: 'ws-control',
      source: { kind: 'clone', repoPath: FIXTURE },
    });

    for (const workspace of [handle, control]) {
      if (workspace.state !== 'ready') {
        throw new Error(`fixture workspace did not provision: ${workspace.error?.message ?? 'unknown'}`);
      }
    }

    await plantPayload(repoPath(), markerPath());
    await plantPayload(controlRepoPath(), controlMarkerPath());

    // Something to report, so "correct --porcelain" has a real expectation.
    await writeFile(join(repoPath(), 'src', 'sum.js'), 'export const sum = (a, b) => a + b + 1;\n');
    await writeFile(join(repoPath(), 'note.txt'), 'agent note\n');
  }, 120_000);

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(markerDir, { recursive: true, force: true });
  });

  it('is executable by a host git — the negative control that makes the test real', async () => {
    await execFileAsync('git', ['-C', controlRepoPath(), 'status', '--porcelain'], { timeout: 20_000 });

    expect(existsSync(controlMarkerPath())).toBe(true);
  });

  it('collects correct evidence with no host marker, because git runs inside the sandbox', async () => {
    // Belt and braces: the control's marker is in a different file, but a stale one here
    // would make this assertion meaningless.
    await rm(markerPath(), { force: true });

    const evidence = await collectWorkspaceEvidence({ workspaceRoot: handle.rootPath });

    expect(evidence).not.toBeNull();
    // A correct porcelain: the modified file and the untracked one, both reported.
    expect(evidence?.status).toContain('M src/sum.js');
    expect(evidence?.status).toContain('?? note.txt');
    expect(evidence?.diff).toContain('+export const sum');

    // The two assertions this whole file exists for.
    expect(existsSync(markerPath())).toBe(false);
    expect(existsSync(insidePath())).toBe(false);
  }, 60_000);

  it('contains the hook even without the -c overrides, because the sandbox is the control', async () => {
    const command = buildSandboxCommand({ rootPath: handle.rootPath }, ['git', 'status', '--porcelain'], {
      env: { PATH: '/usr/local/bin:/usr/bin:/bin' },
    });

    await execFileAsync(command.file, [...command.args], { timeout: 20_000, maxBuffer: 1024 * 1024 });

    // The hook ran: it wrote into the one read-write path the sandbox has.
    expect(existsSync(insidePath())).toBe(true);
    // It could not reach the host path, which is the difference between "runs" and
    // "escapes".
    expect(existsSync(markerPath())).toBe(false);

    await rm(insidePath(), { force: true });
  }, 60_000);

  it('leaves no diff artifact behind when the workspace is not a checkout', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'intelligenz-no-git-'));

    try {
      await mkdir(join(empty, 'repo'), { recursive: true });
      expect(await collectWorkspaceEvidence({ workspaceRoot: empty })).toBeNull();
    } finally {
      await rm(empty, { recursive: true, force: true });
    }
  }, 30_000);
});
