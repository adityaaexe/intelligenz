import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  buildSandboxCommand,
  createWorkspaceManager,
  evidencePath,
  execSandboxed,
  type WorkspaceHandle,
} from '../src';

/**
 * `evidence/` must be outside the only writable mount.
 *
 * The argument is structural and short: `buildSandboxCommand` binds exactly one
 * agent-writable host directory — `<rootPath>/repo` at `/workspace` — plus read-only
 * system paths and tmpfs scratch. `evidence/` is a sibling of `repo/`, so it appears on no
 * mount. That is the whole containment claim, and this test measures it inside a real
 * `bwrap` namespace rather than asserting it from the source.
 *
 * Why it matters: a manifest the agent can rewrite is a manifest the agent authored, which
 * is the defect the manifest exists to remove. Writing the report must not be part of the
 * run being reported on.
 */

let scratch: string;
let handle: WorkspaceHandle;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'intelligenz-evidence-isolation-'));
  const manager = createWorkspaceManager({ root: scratch });

  handle = await manager.provision({
    orgId: 'org-1',
    taskId: 'task-evidence',
    workspaceId: 'ws-evidence',
    // An empty workspace: this test is about the mount table, not about a checkout.
    source: { kind: 'empty' },
  });

  const directory = evidencePath(handle.rootPath);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'change-manifest.json'), '{"digest":"host"}\n');
}, 120_000);

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

async function runInside(argv: readonly string[]): Promise<string> {
  const command = buildSandboxCommand(handle, argv, { env: {} });
  const { stdout } = await execSandboxed(command, { timeoutMs: 15_000, maxBuffer: 1024 * 1024 });

  return stdout.trim();
}

describe('evidence/ is not on the sandbox mount table', () => {
  it('is invisible inside the sandbox, by its host path and by any relative route', async () => {
    const hostPath = evidencePath(handle.rootPath);

    // Three routes a process could try:
    //   - the absolute host path, which would work if any ancestor were mounted;
    //   - the parent of `/workspace`, which is where a sibling would be if the bind
    //     exposed the workspace root instead of the checkout;
    //   - a traversal from the checkout itself.
    const output = await runInside([
      '/bin/sh',
      '-c',
      [
        `test -e ${JSON.stringify(hostPath)} && echo HOST_PATH_VISIBLE || echo HOST_PATH_HIDDEN`,
        'test -e /evidence && echo ROOT_EVIDENCE_VISIBLE || echo ROOT_EVIDENCE_HIDDEN',
        'test -e /workspace/../evidence && echo TRAVERSAL_VISIBLE || echo TRAVERSAL_HIDDEN',
        `cat ${JSON.stringify(join(hostPath, 'change-manifest.json'))} 2>/dev/null || echo CONTENT_UNREADABLE`,
      ].join('; '),
    ]);

    expect(output).toContain('HOST_PATH_HIDDEN');
    expect(output).toContain('ROOT_EVIDENCE_HIDDEN');
    expect(output).toContain('TRAVERSAL_HIDDEN');
    expect(output).toContain('CONTENT_UNREADABLE');
    expect(output).not.toContain('"digest":"host"');
  });

  it('cannot overwrite the host copy: a write attempt leaves the protected bytes identical', async () => {
    const hostPath = evidencePath(handle.rootPath);
    const protectedFile = join(hostPath, 'change-manifest.json');

    // `mkdir -p` may succeed *inside* the sandbox when the host root lives under `/tmp`:
    // `/tmp` is a tmpfs there, so the absolute path names a fresh, empty directory in the
    // sandbox's own mount namespace. That is still containment — the write lands in a
    // tmpfs that dies with the namespace, not in the host's directory — so the assertion
    // is about the bytes that survive, not about the syscall's return code.
    const output = await runInside([
      '/bin/sh',
      '-c',
      [
        `mkdir -p ${JSON.stringify(hostPath)} 2>/dev/null`,
        `printf '{"digest":"forged"}' > ${JSON.stringify(protectedFile)} 2>/dev/null`,
        `cat ${JSON.stringify(protectedFile)} 2>/dev/null || echo HOST_BYTES_UNREADABLE`,
        `ls ${JSON.stringify(hostPath)} 2>/dev/null || echo HOST_DIR_UNREADABLE`,
      ].join('; '),
    ]);

    // Whatever the sandbox sees, it is not the host's file: either the read is refused, or
    // it reads the file it wrote a moment ago inside its own tmpfs. What it must never see
    // is the host's content.
    expect(output).not.toContain('"digest":"host"');
    expect(
      output.includes('HOST_BYTES_UNREADABLE') ||
        output.includes('HOST_DIR_UNREADABLE') ||
        output.includes('"digest":"forged"'),
    ).toBe(true);

    // The bytes the platform will later verify are untouched.
    expect(await readFile(protectedFile, 'utf8')).toBe('{"digest":"host"}\n');
  });

  it('is a sibling of the checkout, not a decoration on it', () => {
    // The layout the assertions above depend on, stated once where a reader will see it.
    expect(dirname(evidencePath(handle.rootPath))).toBe(handle.rootPath);
    expect(basename(evidencePath(handle.rootPath))).toBe('evidence');
    expect(handle.repoPath.startsWith(evidencePath(handle.rootPath))).toBe(false);
  });
});
