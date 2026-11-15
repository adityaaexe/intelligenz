import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildChangeManifest, takeWorkspaceSnapshot } from '../src';
import { git, initRepo } from './helpers/git';

/**
 * One workspace containing every hostile construct the contract names, in one place.
 *
 * The primary assertion is the first one and it is deliberately blunt: **no marker file
 * exists**. Every hostile program — a textconv, an external diff driver, a clean filter, a
 * `core.fsmonitor`, a hook — writes a uniquely named file outside the repository when it
 * runs. If the evidence path executes any of them, a marker appears. Nothing else in this
 * file matters if that assertion fails, because a manifest produced by a walk that can be
 * made to execute agent-authored programs is not evidence of anything.
 *
 * The repository is also **not usable by git at all** by the time the snapshots are taken:
 * its index is corrupted, its `.git/config` names programs that do not do what git expects,
 * and its hooks fire on ordinary commands. That is intentional. A walk that shelled out to
 * git would fail here; a walk that reads bytes cannot tell the difference, and should not.
 */

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let scratch: string;
let workspace: string;
let outside: string;
let markers: string;

/**
 * A program that proves it ran, then behaves exactly as git would need it to.
 *
 * The behaviour matters for the *attack* to be credible — a textconv that printed nothing
 * would make `git diff` empty for the wrong reason. Each of these produces output a real
 * diff would accept, and leaves a marker behind either way.
 */
function hostileScript(directory: string, marker: string, body: string): string {
  return `#!/bin/sh\nprintf 'ran\\n' >> ${JSON.stringify(join(directory, marker))}\n${body}\n`;
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'intelligenz-hostile-'));
  workspace = join(scratch, 'repo');
  outside = join(scratch, 'outside');
  markers = join(scratch, 'markers');
  await mkdir(markers, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(join(outside, 'target.txt'), 'sibling content that must never be hashed\n');

  await initRepo(workspace, {
    'secret.txt': 'SECRET=original\n',
    'src/app.ts': 'export const answer = 41;\n',
    'docs/note.md': '# note\n',
  });

  // Written as bytes, not as a string: a fixture that round-trips binary content through
  // UTF-8 would be testing a different file than the one it claims to.
  await writeFile(join(workspace, 'data.bin'), Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00, 0x7f]));

  // ── The hostile configuration, installed *before* the baseline ────────────
  //
  // Pre-existing is the realistic shape: this arrives with a clone, an earlier attempt,
  // or an agent that got this far. It is not a "change" the manifest should report — it
  // is configuration that must be *unable to matter*.
  const textconv = join(markers, 'textconv.sh');
  const externalDiff = join(markers, 'external-diff.sh');
  const clean = join(markers, 'clean.sh');
  const fsmonitor = join(markers, 'fsmonitor.sh');

  await writeFile(textconv, hostileScript(markers, 'textconv-ran', 'exec cat'), { mode: 0o755 });
  await writeFile(externalDiff, hostileScript(markers, 'external-diff-ran', 'echo "fabricated diff"'), {
    mode: 0o755,
  });
  await writeFile(clean, hostileScript(markers, 'clean-ran', 'exec cat'), { mode: 0o755 });
  await writeFile(fsmonitor, hostileScript(markers, 'fsmonitor-ran', 'exit 1'), { mode: 0o755 });

  await writeFile(
    join(workspace, '.gitattributes'),
    ['*.md diff=custom', 'secret.txt filter=hide', '*.bin -diff', ''].join('\n'),
  );

  const baseConfig = await readFile(join(workspace, '.git', 'config'), 'utf8');
  await writeFile(
    join(workspace, '.git', 'config'),
    [
      baseConfig,
      '[diff]',
      `\texternal = ${externalDiff}`,
      '[diff "custom"]',
      `\ttextconv = ${textconv}`,
      `\tcommand = ${externalDiff}`,
      '[filter "hide"]',
      `\tclean = ${clean}`,
      '\tsmudge = cat',
      '[core]',
      `\tfsmonitor = ${fsmonitor}`,
      '',
    ].join('\n'),
  );

  for (const hook of ['pre-commit', 'post-checkout', 'pre-push']) {
    await writeFile(
      join(workspace, '.git', 'hooks', hook),
      hostileScript(markers, 'hook-ran', 'exit 1'),
      { mode: 0o755 },
    );
  }

  // An altered index. Appending bytes is enough: the snapshot's job is to notice that the
  // index is not the one the baseline saw, not to parse it — and it also makes this
  // repository unusable by git, which is a second, structural proof that the evidence path
  // never invokes it.
  const index = await readFile(join(workspace, '.git', 'index'));
  await writeFile(join(workspace, '.git', 'index'), Buffer.concat([index, Buffer.from('tamper')]));

  // Symlinks: one absolute to a file the process can read, one relative to a sibling
  // outside the workspace. Neither is followed.
  await symlink('/etc/passwd', join(workspace, 'etc-passwd'));
  await symlink(join(outside, 'target.txt'), join(workspace, 'outside-link'));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe('hostile workspace — the helpers must never execute', () => {
  it('takes a complete snapshot pair and a correct manifest while every hostile program stays dormant', async () => {
    // ── The baseline ─────────────────────────────────────────────────────────
    const initial = await takeWorkspaceSnapshot(workspace);

    // ── What the agent does ──────────────────────────────────────────────────
    //
    // A filtered file (the `clean` filter rewrites what git indexes), a plain edit, a
    // deletion, a binary rewrite, three awkward names, and two new symlinks.
    await writeFile(join(workspace, 'secret.txt'), 'SECRET=COMPROMISED\n');
    await writeFile(join(workspace, 'src/app.ts'), 'export const answer = 42;\n');
    await unlink(join(workspace, 'docs/note.md'));

    const binaryAfter = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0xff]);
    await writeFile(join(workspace, 'data.bin'), binaryAfter);

    await writeFile(join(workspace, 'file with spaces.txt'), 'spaces\n');
    await writeFile(join(workspace, 'ünïcode-文件.txt'), 'unicode\n');
    await writeFile(join(workspace, 'new\nline.txt'), 'newline\n');

    await symlink('/etc/passwd', join(workspace, 'exfil'));

    // ── The final snapshot and the manifest ──────────────────────────────────
    const final = await takeWorkspaceSnapshot(workspace);
    const manifest = buildChangeManifest({ initial, final });

    // ── (1) THE ASSERTION ────────────────────────────────────────────────────
    //
    // Every hostile program writes a marker outside the tree. The directory is empty, so
    // not one of them ran: not the textconv, not the external diff, not the clean filter,
    // not the fsmonitor, not a hook.
    expect(await readdir(markers).then((entries) => entries.filter((e) => e.endsWith('-ran')))).toEqual(
      [],
    );

    // ── (2) the real changes are all there ───────────────────────────────────
    const byPath = new Map(manifest.changes.map((change) => [change.path, change]));

    expect(byPath.get('secret.txt')?.status).toBe('modified');
    // The bytes on disk. A `clean` filter would have reported `SECRET=original`.
    expect(byPath.get('secret.txt')?.after?.sha256).toBe(sha256('SECRET=COMPROMISED\n'));

    expect(byPath.get('src/app.ts')?.status).toBe('modified');
    expect(byPath.get('src/app.ts')?.after?.sha256).toBe(sha256('export const answer = 42;\n'));

    expect(byPath.get('docs/note.md')?.status).toBe('deleted');
    expect(byPath.get('docs/note.md')?.after).toBeNull();

    expect(byPath.get('data.bin')?.status).toBe('modified');
    expect(byPath.get('data.bin')?.after?.sha256).toBe(sha256(binaryAfter));
    expect(byPath.get('data.bin')?.after?.sizeBytes).toBe(binaryAfter.byteLength);

    expect(byPath.get('file with spaces.txt')?.status).toBe('added');
    expect(byPath.get('ünïcode-文件.txt')?.status).toBe('added');
    expect(byPath.get('new\nline.txt')?.status).toBe('added');

    expect(manifest.complete).toBe(true);
    expect(manifest.changeCount).toBe(manifest.changes.length);

    // ── (3) symlinks are links, and `/etc/passwd` is never read ──────────────
    const passwdEntry = final.entries.find((entry) => entry.path === 'etc-passwd');
    expect(passwdEntry).toMatchObject({ kind: 'symlink', symlinkTarget: '/etc/passwd', sha256: null });

    const exfil = byPath.get('exfil');
    expect(exfil?.status).toBe('added');
    expect(exfil?.after).toMatchObject({ kind: 'symlink', symlinkTarget: '/etc/passwd' });

    // The decisive check: the digest of the real `/etc/passwd` appears nowhere in the
    // manifest. Recording the link is not reading the file.
    const passwdDigest = sha256(await readFile('/etc/passwd'));
    expect(manifest.changes.some((change) => change.after?.sha256 === passwdDigest)).toBe(false);
    expect(final.entries.some((entry) => entry.sha256 === passwdDigest)).toBe(false);

    // A symlink to a sibling outside the workspace is recorded, not walked into.
    const outsideEntry = final.entries.find((entry) => entry.path === 'outside-link');
    expect(outsideEntry).toMatchObject({
      kind: 'symlink',
      symlinkTarget: join(outside, 'target.txt'),
    });
    expect(
      final.entries.some((entry) => entry.sha256 === sha256('sibling content that must never be hashed\n')),
    ).toBe(false);

    // ── (4) the hostile `.git` is visible as metadata, and only as metadata ──
    //
    // The config is not a change (it was hostile before the baseline), but its digest is
    // recorded, so a config that changes *during* a run cannot be invisible.
    expect(final.git.configSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(final.git.indexSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(final.git.hooks.map((hook) => hook.name)).toEqual(
      expect.arrayContaining(['post-checkout', 'pre-commit', 'pre-push']),
    );

    // The config did not change during the run, so it is not in the manifest — and its
    // digest is identical in both snapshots. Hostile configuration that sits still is not
    // noise; hostile configuration that *moves* would be, because the digest covers it.
    expect(final.git.configSha256).toBe(initial.git.configSha256);

    // No content entry lives under `.git/`: configuration is not the agent's work.
    expect(final.entries.some((entry) => entry.path.startsWith('.git/'))).toBe(false);
  });

  /**
   * The control, without which the primary assertion is unfalsifiable.
   *
   * Same scripts, same configuration, same `git diff --no-ext-diff --no-textconv` call —
   * and the marker *appears*. So the empty directory above is not a directory nothing
   * writes to; it is a directory nothing had a reason to write to, because the evidence
   * path never ran a program. `--no-textconv` is visible here for the record: it is exactly
   * the flag the old collector used, and it does not stop a clean filter.
   */
  it('the trap is armed: the same helper does run when a git command is invoked', async () => {
    const control = join(scratch, 'control-repo');
    const controlMarkers = await mkdtemp(join(tmpdir(), 'intelligenz-control-markers-'));

    await initRepo(control, { 'secret.txt': 'SECRET=original\n' });

    const clean = join(controlMarkers, 'clean.sh');
    await writeFile(clean, hostileScript(controlMarkers, 'clean-ran', 'exec cat'), { mode: 0o755 });

    await writeFile(join(control, '.gitattributes'), 'secret.txt filter=hide\n');
    const baseConfig = await readFile(join(control, '.git', 'config'), 'utf8');
    await writeFile(
      join(control, '.git', 'config'),
      `${baseConfig}[filter "hide"]\n\tclean = ${clean}\n\tsmudge = cat\n`,
    );

    await writeFile(join(control, 'secret.txt'), 'SECRET=COMPROMISED\n');

    // The exact command shape the old collector used, including `--no-textconv`.
    await git(control, ['diff', '--no-ext-diff', '--no-textconv', '--no-color']);

    expect(await readdir(controlMarkers)).toContain('clean-ran');

    await rm(controlMarkers, { recursive: true, force: true });
  });

  it('detects a file modified after the manifest was built, because the digest is an instant', async () => {
    const initial = await takeWorkspaceSnapshot(workspace);
    await writeFile(join(workspace, 'src/app.ts'), 'export const answer = 43;\n');
    const final = await takeWorkspaceSnapshot(workspace);
    const manifest = buildChangeManifest({ initial, final });

    // The "output was generated" claim: the manifest is finished and its digests recorded.
    // Then one more byte lands — an adapter that writes after reporting, a stray daemon, a
    // late hook.
    await writeFile(join(workspace, 'src/app.ts'), 'export const answer = 44;\n');

    const afterwards = await takeWorkspaceSnapshot(workspace);

    // The recorded final digest no longer describes the tree, so a verifier re-walking it
    // gets a mismatch. That is the property: a manifest is true of an instant, and the
    // instant is checkable.
    expect(afterwards.digest).not.toBe(manifest.final.digest);
    expect(manifest.changes.find((change) => change.path === 'src/app.ts')?.after?.sha256).toBe(
      sha256('export const answer = 43;\n'),
    );
  });
});
