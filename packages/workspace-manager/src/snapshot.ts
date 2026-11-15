import { createHash } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import { readdir, lstat, open, readlink, type FileHandle } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';

import { SnapshotError } from './errors';

/**
 * The host's own description of a workspace tree.
 *
 * ## Why this exists
 *
 * Evidence used to be `git status --porcelain` plus `git diff`, collected by asking the
 * repository what it thought had happened. Every one of those answers is produced by a
 * program the agent can configure:
 *
 * | Attack | `git diff` hunks | what the tree actually contains |
 * |---|---|---|
 * | `git add -A` (staged, no config change) | 0 | the whole edit |
 * | `.gitattributes` with a `clean` filter | 0 | the filter's rewritten bytes |
 * | `git add` + `git commit` | 0 | completely different content |
 *
 * The last row is the one that matters: not a tampering *signal*, a confident **negative**.
 * `--no-textconv` does not help, because a clean/smudge filter is a different mechanism
 * and `--no-ext-diff` never saw it.
 *
 * So the authority stopped being git and became a walk. This module reads the tree the
 * way the kernel presents it — `lstat`, `readlink`, `open` — and nothing else. It does not
 * spawn, does not read `.git/config` as configuration, and cannot be configured by
 * anything inside the tree it is describing. ESLint enforces the spawn discipline
 * structurally (`SEC-403` in `eslint.config.mjs`): `child_process` may only be imported by
 * the files on its reviewed allowlist, and `snapshot.ts` is not one of them. Two other
 * files in this package are — `sandbox.ts` and `manager.ts` — so the rule is an allowlist
 * over the spawn boundary, not a package-wide ban. A test asserts this module imports none.
 *
 * ## What a snapshot is, and is not
 *
 * It is a **statement about bytes at an instant**: for every path, what kind of thing it
 * is, its permission bits, its size and the SHA-256 of its contents. It is not a diff, an
 * interpretation, or a claim about intent, and it is not incremental — two snapshots are
 * comparable precisely because each one is complete.
 *
 * Three properties are load-bearing and each has a test:
 *
 * 1. **`lstat` only.** A symlink is recorded as a link and its target string, never
 *    followed. A link to `/etc/passwd` produces one entry with that target; the file is
 *    never opened. A link to a directory outside the tree is not walked into — neither as
 *    an entry of the tree nor as `.git/hooks`, which is enumerated through the same
 *    helper and therefore has the same rule.
 * 2. **Special files are classified, never opened.** Opening a FIFO blocks until a writer
 *    appears, and reading a character device can block or stream forever. A snapshot of a
 *    repository containing a FIFO must not hang, so `fifo`/`socket`/`device` become
 *    `kind: 'special'` with no digest. A regular file that is *swapped* for a special one
 *    between `lstat` and `open` is refused for the same reason: descriptors are opened
 *    `O_NONBLOCK` and only a regular `fstat` is hashed (F-G17).
 * 3. **An incomplete snapshot says so.** `maxEntries` and `maxTotalBytes` bound the walk.
 *    Exceeding either stops it and sets `complete: false` with the counts actually
 *    reached. A partial manifest that looks whole is the same failure as the empty
 *    `git diff`: a confident wrong answer.
 * 4. **Everything visible is described.** The only exclusion is the workspace root's
 *    `.git`, which is the repository's own metadata and is captured in
 *    `SnapshotGitMetadata`. A `.git` at any other depth is not the root repository's
 *    metadata, so it is walked as content like every other directory: an agent write
 *    inside `sub/.git` changes `entries`, and therefore the digest and the manifest. It
 *    was previously skipped at every depth and described nowhere, which made it a silent
 *    write area (F-G11). Its presence is also recorded as a `nested-git:` anomaly, because
 *    "this workspace holds a nested repository" is a fact a reviewer should not have to
 *    derive from a digest (F-G14).
 * 5. **A directory is re-checked after its children (F-G20, partial).** Each queued
 *    directory carries the `lstat` that classified it; after its children are read, the
 *    path is `lstat`ed again and `dev`/`ino`/`ctimeMs` are compared. A parent swapped for a
 *    symbolic link between `readdir` and a child's `lstat` resolves the child through the
 *    link, and the entry-level check agrees with itself because both halves were resolved
 *    through the same link — the parent's identity does not. A mismatch sets
 *    `parent-replaced` (identity moved) or `unstable` (`ctime` only) and **withdraws the
 *    subtree's entries**, because a path resolved through a substituted parent can produce
 *    a digest of a file outside the workspace. This is a **detection, not a prevention**:
 *    without `openat2(RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS)` every open here is
 *    path-based, so a digest can still be computed from a momentarily-substituted path
 *    before the re-check runs. The window is bounded by one directory's children, the
 *    snapshot is `complete: false`, and the attempt fails (F-G13); see
 *    `TRUSTED-SNAPSHOT-DESIGN.md` §"Parent-swap residual" for the exact claim.
 *
 * A sixth property is narrower and stated precisely because earlier versions of this
 * comment overstated it: **a file is hashed through a descriptor whose identity and
 * timestamps were checked.** `open` uses `O_NOFOLLOW`, the descriptor is `fstat`ed, and
 * `dev`/`ino`/`size`/`ctimeMs` are compared with the `lstat` that classified the entry. A
 * path swapped for a different inode, or rewritten in place, fails the entry as
 * `unstable` instead of hashing the replacement. `ctimeMs` is compared again after the
 * read; an unprivileged process can restore `mtime` but not `ctime`, which is what makes
 * a same-size rewrite during capture detectable (F-G4).
 */

/**
 * Bumped when the canonical form changes. A digest is only comparable at its version.
 *
 * 3 — `git.anomalies` (F-G14).
 */
export const SNAPSHOT_VERSION = 3;

/** 50,000 entries is ~4× a large monorepo; beyond it, evidence stops being readable. */
export const DEFAULT_MAX_ENTRIES = 50_000;

/** 8 GiB of content hashed per snapshot. Deliberately generous: this is a guard. */
export const DEFAULT_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Ceiling for one git metadata file (`config`, `index`). An index is a few MB for a large
 * repository; 256 MiB means something is wrong in a way that must be reported rather than
 * hashed for a minute.
 */
const GIT_METADATA_MAX_BYTES = 256 * 1024 * 1024;

/** `HEAD` is a ref line or a commit id. Anything longer is not a HEAD; cap what we keep. */
const GIT_HEAD_MAX_CHARS = 512;

/** A `gitdir:` pointer is one line. A `.git` file larger than this is not one. */
const GITFILE_MAX_BYTES = 4 * 1024;

/** A hooks directory with more entries than this is not a hooks directory. */
const MAX_HOOKS = 1_024;

/**
 * The directory excluded from the content manifest **at the workspace root only**.
 *
 * The root's `.git` is the repository's own metadata: expensive to walk, not the agent's
 * work, and captured structurally by `SnapshotGitMetadata`. A `.git` at any other depth
 * belongs to a nested repository or a submodule and is not the root repository's control
 * surface, so it is content — see `walk`.
 */
export const GIT_DIRECTORY = '.git';

export type SnapshotEntryKind = 'file' | 'dir' | 'symlink' | 'special';

/** One filesystem object, described without following it. */
export interface SnapshotEntry {
  /** Relative POSIX path from the snapshot root. `''` never appears: the root is implicit. */
  readonly path: string;
  readonly kind: SnapshotEntryKind;
  /** Permission bits only (`mode & 0o7777`). File type bits live in `kind`. */
  readonly mode: number;
  /** Bytes of content hashed. `0` for directories, symlinks and special files. */
  readonly sizeBytes: number;
  /** SHA-256 of the file's bytes, lowercase hex. `null` for anything not a regular file. */
  readonly sha256: string | null;
  /** The link's target string, verbatim. `null` for anything that is not a symlink. */
  readonly symlinkTarget: string | null;
}

export interface SnapshotLimits {
  readonly maxEntries: number;
  readonly maxTotalBytes: number;
}

/**
 * Why the walk stopped before the tree was exhausted.
 *
 * `unreadable` and `unstable` are not bounds; they are honesty. An entry that vanished
 * between `readdir` and `lstat`, or a file whose size changed while it was being hashed,
 * means the snapshot describes a tree that did not exist at any single instant. That is
 * not authority, so it is reported instead of silently omitted.
 */
export type SnapshotStopReason =
  | 'max-entries'
  | 'max-total-bytes'
  | 'unreadable'
  /**
   * The tree changed under the walk: an entry vanished, a file grew, or a directory gained
   * or lost a child while it was being described (F-G20). The snapshot describes no single
   * instant.
   */
  | 'unstable'
  /**
   * A directory is no longer the directory that was classified — its `dev`/`ino` moved, or
   * it became a link (F-G20). Distinguished from `unstable` because it is a different fact:
   * the walk may have resolved children through a path that now points somewhere else, so
   * the subtree's entries were withdrawn rather than merely marked as a moving target.
   */
  | 'parent-replaced'
  | null;

export interface SnapshotHook {
  readonly name: string;
  readonly kind: SnapshotEntryKind;
  /** Hash of the hook's bytes, or of the link target for a symlinked hook. */
  readonly sha256: string | null;
}

/**
 * `.git` as metadata, never as content.
 *
 * The directory is excluded from `entries` because its files are not the agent's work —
 * but its *configuration* is an attack surface and must therefore be visible. A changed
 * `config`, `index` or hook has to show up somewhere; it shows up here, as a digest, and
 * it cannot influence anything else because no code path reads it as configuration.
 */
export interface SnapshotGitMetadata {
  readonly present: boolean;
  /**
   * `directory` for a normal checkout, `file` for a worktree's `gitdir:` pointer,
   * `special` for anything else (a FIFO or device at `/.git`), `null` when absent.
   */
  readonly kind: 'directory' | 'file' | 'special' | null;
  /** Resolved branch ref or commit id as written. `null` when absent or a gitfile. */
  readonly head: string | null;
  readonly configSha256: string | null;
  readonly indexSha256: string | null;
  /** Hash of the `.git` file itself, for a worktree checkout. */
  readonly gitfileSha256: string | null;
  readonly hooks: readonly SnapshotHook[];
  /**
   * `.git/hooks` when it is a symbolic link: recorded, never enumerated.
   *
   * A symlinked hooks directory is a link, exactly like a symlinked file in the content
   * walk, and it is described the only honest way — by its target string. `null` means
   * `hooks` was a real directory (enumerated), absent, or not a directory.
   *
   * Recorded rather than thrown on purpose. A throw would delete the entire snapshot,
   * which hands whatever made the link a switch that turns evidence off; recording keeps
   * every other byte described and puts the anomaly in the digest, where a comparison
   * between two snapshots sees it.
   */
  readonly hooksDirectoryLinkTarget: string | null;
  /** Metadata files that exceeded `GIT_METADATA_MAX_BYTES` and were not hashed. */
  readonly oversize: readonly string[];
  /** True when the hooks directory held more than `MAX_HOOKS` entries. */
  readonly hooksTruncated: boolean;
  /**
   * Metadata that could not be described as a normal file, one line each.
   *
   * These are the same facts the fields above carry structurally — a link target, an
   * oversize name — restated as a list so they can travel somewhere a reviewer looks
   * without parsing digests (F-G14). They are inside the canonical body, so two
   * snapshots whose *only* difference is an anomaly still have different digests; and
   * the worker writes them to a durable audit record, so `authoritative: true,
   * changeCount: 0` cannot hide one.
   */
  readonly anomalies: readonly string[];
}

export interface WorkspaceSnapshot {
  readonly root: string;
  /** When the walk finished. Outside the digest on purpose — see `serialiseSnapshot`. */
  readonly capturedAt: string;
  readonly complete: boolean;
  readonly stopReason: SnapshotStopReason;
  /** Entries recorded, which equals `entries.length`. Stated so a truncated body is obvious. */
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly limits: SnapshotLimits;
  readonly entries: readonly SnapshotEntry[];
  readonly git: SnapshotGitMetadata;
  /** SHA-256 of `serialiseSnapshot(this)`. */
  readonly digest: string;
}

/** The subset of a snapshot that its digest covers. */
export interface SnapshotDigestInput {
  readonly root: string;
  readonly complete: boolean;
  readonly stopReason: SnapshotStopReason;
  readonly entryCount: number;
  readonly totalBytes: number;
  readonly limits: SnapshotLimits;
  readonly entries: readonly SnapshotEntry[];
  readonly git: SnapshotGitMetadata;
}

export interface TakeSnapshotOptions {
  readonly maxEntries?: number;
  readonly maxTotalBytes?: number;
  /** Injected in tests so a canonical body is reproducible. */
  readonly now?: () => Date;
  /**
   * Called after a directory has been listed and before its children are classified.
   *
   * Exists for the parent-swap suite (F-G20) and for nothing else: the window between
   * `readdir` and a child's `lstat` cannot be held open from outside the walk without a
   * seam, in the same way `hashRegularFile` had to be exported to test the entry-level
   * race. Production callers pass nothing, and a caller that did pass something could only
   * make its own snapshot *more* likely to be reported incomplete.
   */
  readonly afterDirectoryListed?: (relativePath: string) => Promise<void> | void;
}

/**
 * Byte-order comparison, not UTF-16 order.
 *
 * `Array.prototype.sort` compares UTF-16 code units, which puts astral-plane characters
 * before `U+E000..U+FFFF`. Two hosts (or two Node versions) would then disagree about the
 * canonical order of a path a filesystem happily stores, and the digest would differ for
 * an identical tree. The contract is "sorted by path bytes", so compare bytes.
 */
function comparePathBytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256Bytes(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** One deterministic order for the metadata anomaly list, so the digest is stable. */
function normaliseAnomalies(anomalies: readonly string[]): readonly string[] {
  return [...new Set(anomalies)].sort(comparePathBytes);
}

/**
 * An entry whose identity changed between classification and hashing.
 *
 * Not an error the caller reports to a user: it is the walk's answer to "the tree is not
 * the one I was describing". Callers turn it into `stopReason: 'unstable'` (content walk)
 * or a metadata gap (`.git` files), never into a digest.
 */
class UnstableEntryError extends Error {
  constructor(absolute: string, detail: string) {
    super(`Entry ${absolute} changed during capture: ${detail}`);
    this.name = 'UnstableEntryError';
  }
}

/**
 * Stream one open descriptor through SHA-256.
 *
 * `start: 0` reads from the beginning regardless of the descriptor's position, and
 * `autoClose: false` keeps the handle open so the caller can `fstat` it again afterwards —
 * that second look is what notices a writer that changed the file while it was being read.
 */
function digestHandle(handle: FileHandle): Promise<{ sha256: string; sizeBytes: number }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    let settled = false;

    const stream = handle.createReadStream({ autoClose: false, start: 0 });

    stream.on('data', (chunk) => {
      sizeBytes += chunk.length;
      hash.update(chunk);
    });

    stream.on('error', (error) => {
      // A read error is not a digest of zero bytes. It fails the walk, which the caller
      // turns into `complete: false`.
      if (settled) return;
      settled = true;
      reject(error);
    });

    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolvePromise({ sha256: hash.digest('hex'), sizeBytes });
    });
  });
}

/**
 * Hash a regular file through a descriptor, refusing to follow a link, a swap, or a
 * rewrite.
 *
 * `expected` is the `lstat` that decided this path was a regular file. Five things are
 * checked, and each closes a different hole:
 *
 *   1. `O_NOFOLLOW` — if the final component became a symlink, `open` fails with `ELOOP`
 *      instead of reading the target. This is the `lstat` → `open` race: `lstat` says
 *      "file", the agent replaces it with `.git/… -> /etc/passwd`, and a plain
 *      `createReadStream` would have hashed the target.
 *   2. `O_NONBLOCK` plus `isFile()` — if the final component became a FIFO, `open` would
 *      block until a writer appeared, hanging the walk (F-G17). Non-blocking `open`
 *      returns immediately and the descriptor is refused unless it is a regular file.
 *   3. `dev`/`ino`/`ctimeMs` — the descriptor must be the very inode `lstat` described,
 *      and it must not have been written since. A path swapped for a different
 *      (possibly same-size) file fails the identity check; a same-size in-place rewrite
 *      fails the `ctimeMs` check, because `ctime` is not settable by an unprivileged
 *      process (F-G4).
 *   4. `size` — the descriptor's size must be the size the budget was checked against, so
 *      a file that grew after `lstat` cannot exceed `maxTotalBytes` unannounced.
 *   5. `size`, `mtimeMs` and `ctimeMs` again after hashing — a writer that appended,
 *      rewrote or truncated while the stream was open is detected. A same-size rewrite
 *      that also restores `mtimeMs` is caught by `ctimeMs`; the previous version of this
 *      check said it was not, and the design document's corresponding bound was false.
 *
 * Exported for the escape suite: the identity comparison is the subject of a test and
 * cannot be triggered deterministically without holding a stale `lstat`.
 */
export async function hashRegularFile(
  absolute: string,
  expected: Stats,
): Promise<{ sha256: string; sizeBytes: number }> {
  const handle = await open(
    absolute,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  ).catch((error: NodeJS.ErrnoException) => {
    // `O_NOFOLLOW` turns "the final component became a symlink" into an error rather
    // than a read of the target. `ELOOP` is exactly that swap, so it is contested (the
    // entry is not what `lstat` described) rather than unreadable.
    if (error.code === 'ELOOP' || error.code === 'EMLINK') {
      throw new UnstableEntryError(absolute, 'became a symbolic link after classification');
    }

    throw error;
  });

  try {
    const opened = await handle.stat();

    // A FIFO, socket, device or directory opened without blocking is still not the
    // regular file `lstat` described. Reject before any read: `createReadStream` on a
    // FIFO would wait for a writer, which is the hang `O_NONBLOCK` exists to avoid.
    if (!opened.isFile()) {
      throw new UnstableEntryError(
        absolute,
        'is no longer a regular file (opened a special file or directory)',
      );
    }

    if (opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new UnstableEntryError(
        absolute,
        `inode ${String(opened.dev)}:${String(opened.ino)} is not the ${String(expected.dev)}:${String(expected.ino)} that was classified`,
      );
    }

    // `ctime` is the timestamp a writer cannot set. `mtime` is under `utimes`' control,
    // which is why the same-size-rewrite detection cannot rest on it alone.
    if (opened.ctimeMs !== expected.ctimeMs) {
      throw new UnstableEntryError(
        absolute,
        `ctime moved from ${String(expected.ctimeMs)} to ${String(opened.ctimeMs)} before the read`,
      );
    }

    if (opened.size !== expected.size) {
      throw new UnstableEntryError(
        absolute,
        `size ${String(opened.size)} is not the ${String(expected.size)} that was budgeted`,
      );
    }

    const digest = await digestHandle(handle);
    const after = await handle.stat();

    if (
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    ) {
      throw new UnstableEntryError(
        absolute,
        `written during capture (${String(opened.size)}→${String(after.size)} bytes, mtime ${String(opened.mtimeMs)}→${String(after.mtimeMs)}, ctime ${String(opened.ctimeMs)}→${String(after.ctimeMs)})`,
      );
    }

    // The stream's own byte count is what was hashed; a short read with an unchanged
    // descriptor size would mean the digest covers fewer bytes than it claims.
    if (digest.sizeBytes !== opened.size) {
      throw new UnstableEntryError(
        absolute,
        `hashed ${String(digest.sizeBytes)} of ${String(opened.size)} bytes`,
      );
    }

    return digest;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/** `lstat` without throwing: `undefined` means the entry is gone. */
async function statOrUndefined(absolute: string): Promise<Stats | undefined> {
  try {
    return await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

/**
 * What is at a path we are about to enumerate.
 *
 * The one rule this whole module exists to enforce is "never descend through a link", and
 * a directory listing is a descent. `readdir('…/.git/hooks')` where `hooks` is a symlink to
 * `/etc` returns `/etc`'s entries, and every one of them then looks like
 * `<root>/.git/hooks/<name>` to a lexical containment check — which is how a snapshot came
 * to carry the SHA-256 of `/etc/passwd`.
 *
 * So every enumeration goes through here: `lstat` first, and a link is described, never
 * listed. It is used for the content walk **and** for `.git` metadata, because the rule is
 * about descending, not about which directory is being walked. For the content walk it is
 * also a second look: a directory that was classified as `dir` and swapped for a link
 * before it was read is refused here.
 */
type DirectoryListing =
  | { readonly kind: 'listed'; readonly names: readonly string[] }
  | { readonly kind: 'symlink'; readonly target: string | null }
  | { readonly kind: 'not-a-directory' }
  | { readonly kind: 'absent' };

async function listDirectory(absolute: string): Promise<DirectoryListing> {
  const stat = await statOrUndefined(absolute);

  if (stat === undefined) return { kind: 'absent' };

  if (stat.isSymbolicLink()) {
    let target: string | null = null;

    try {
      target = await readlink(absolute);
    } catch {
      target = null;
    }

    return { kind: 'symlink', target };
  }

  if (!stat.isDirectory()) return { kind: 'not-a-directory' };

  // `EACCES`/`EIO` propagate on purpose: a directory we were told exists and cannot read
  // is a gap in the evidence, not an empty directory.
  return { kind: 'listed', names: (await readdir(absolute)).sort(comparePathBytes) };
}

function classify(stat: Stats): SnapshotEntryKind {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'dir';
  if (stat.isFile()) return 'file';
  // FIFO, socket, character device, block device — and anything the platform adds later.
  // Classified, never opened: `open()` on a FIFO blocks until a writer exists.
  return 'special';
}

/**
 * Read a small file without following a link, and without trusting its length.
 *
 * `.git/HEAD` is a ref line and `.git` may be a `gitdir:` pointer; both are text, both are
 * paths an agent can replace, and `readFile` follows symlinks and reads a length it did not
 * choose. A `.git -> /etc/shadow` gitfile would have hashed the target into
 * `gitfileSha256`; a multi-gigabyte `.git` file would have been read into the worker's
 * heap. `O_NOFOLLOW` plus an explicit ceiling closes both.
 */
async function readSmallFileNoFollow(
  absolute: string,
  maxBytes: number,
): Promise<Buffer | null> {
  let handle: FileHandle;

  try {
    // `O_NONBLOCK` matters here too: this helper is called only for a path `lstat`
    // classified as a regular file, but a swap can turn it into a FIFO before the open.
    handle = await open(
      absolute,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch {
    return null;
  }

  try {
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    if (stat.size > maxBytes) return null;

    const buffer = Buffer.alloc(stat.size);
    const { bytesRead } = await handle.read(buffer, 0, stat.size, 0);

    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

/**
 * Read `.git/HEAD` without following a link.
 *
 * `.git/HEAD` is a ref line or a commit id, so it is small and it is text — but it is also
 * a path an agent can replace, and `readFile` follows symlinks. `.git/HEAD -> /etc/passwd`
 * would have put up to 512 bytes of `/etc/passwd` into the manifest as `head`, which is the
 * same boundary violation as the hooks directory in a different field. `O_NOFOLLOW` makes
 * the link fail to open, and the honest answer for "HEAD is a link" is `null`.
 */
async function readHead(absolute: string): Promise<string | null> {
  const bytes = await readSmallFileNoFollow(absolute, GIT_HEAD_MAX_CHARS * 4);
  if (bytes === null) return null;

  const trimmed = bytes.toString('utf8').trim();

  return trimmed.length === 0 ? null : trimmed.slice(0, GIT_HEAD_MAX_CHARS);
}

/**
 * Read the git metadata the content manifest deliberately excludes.
 *
 * Only the **workspace root's** `.git` is read here. A nested `.git` is content — see
 * `walk` — because it is not the root repository's metadata and the agent can write it.
 *
 * Never follows the `.git` pointer: a worktree's `.git` is a *file* containing
 * `gitdir: /somewhere`, and following it would leave the tree this snapshot claims to
 * describe. For a worktree the pointer's hash is recorded and the remaining fields are
 * `null` — the honest answer, because those files are outside the root.
 */
async function readGitMetadata(root: string): Promise<SnapshotGitMetadata> {
  const empty: SnapshotGitMetadata = {
    present: false,
    kind: null,
    head: null,
    configSha256: null,
    indexSha256: null,
    gitfileSha256: null,
    hooks: [],
    hooksDirectoryLinkTarget: null,
    oversize: [],
    hooksTruncated: false,
    anomalies: [],
  };

  const gitPath = join(root, GIT_DIRECTORY);
  const stat = await statOrUndefined(gitPath);
  if (stat === undefined) return empty;

  if (stat.isSymbolicLink()) {
    // A `.git` symlink is not a checkout layout we describe; following it would leave the
    // root. Record the link and stop.
    let target: string | null = null;
    try {
      target = await readlink(gitPath);
    } catch {
      target = null;
    }

    return {
      ...empty,
      present: true,
      kind: 'file',
      // Prefixed like every other symlink digest in this module (`hooks`, `config`): a
      // `.git` *file* containing exactly this path string and a `.git` *link* to it are
      // different facts, and an unprefixed hash would represent both as one value.
      gitfileSha256: sha256Bytes(`symlink:${target ?? ''}`),
      anomalies: normaliseAnomalies([`git-link:${target ?? ''}`]),
    };
  }

  if (stat.isFile()) {
    const bytes = await readSmallFileNoFollow(gitPath, GITFILE_MAX_BYTES);

    // Unreadable, oversized, or replaced by a link: the pointer's own hash is the only
    // thing that can be reported, and a `null` here is a **gap**, not a digest of nothing.
    // Reporting it through `oversize` is what makes the snapshot `complete: false` — the
    // alternative (present, hashed, complete) would say "the pointer was read" when it was
    // not.
    return {
      ...empty,
      present: true,
      kind: 'file',
      gitfileSha256: bytes === null ? null : sha256Bytes(bytes),
      oversize: bytes === null ? [GIT_DIRECTORY] : [],
      anomalies: bytes === null ? normaliseAnomalies(['gitfile-unreadable']) : [],
    };
  }

  if (!stat.isDirectory()) {
    return {
      ...empty,
      present: true,
      kind: 'special',
      anomalies: normaliseAnomalies(['git-special']),
    };
  }

  const oversize: string[] = [];
  const anomalies: string[] = [];

  const digestMetadata = async (name: string): Promise<string | null> => {
    const absolute = join(gitPath, name);
    const candidate = await statOrUndefined(absolute);

    // A symlinked `config`/`index` is recorded by target, never read through: that is the
    // same rule the content walk follows, and it is what stops `.git/config` from being a
    // read primitive for an arbitrary host file.
    if (candidate === undefined) return null;

    if (candidate.isSymbolicLink()) {
      anomalies.push(`metadata-link:${name}`);

      try {
        return sha256Bytes(`symlink:${await readlink(absolute)}`);
      } catch {
        return null;
      }
    }

    if (!candidate.isFile()) return null;

    if (candidate.size > GIT_METADATA_MAX_BYTES) {
      oversize.push(name);
      anomalies.push(`metadata-not-hashed:${name}`);
      return null;
    }

    try {
      return (await hashRegularFile(absolute, candidate)).sha256;
    } catch {
      // Oversize, contested, or unreadable: all three leave the same gap, and the gap is
      // what has to be visible rather than a digest of something else.
      oversize.push(name);
      anomalies.push(`metadata-not-hashed:${name}`);
      return null;
    }
  };

  const [configSha256, indexSha256] = await Promise.all([
    digestMetadata('config'),
    digestMetadata('index'),
  ]);

  const head = await readHead(join(gitPath, 'HEAD'));

  // A HEAD that could not be read — a link, an oversize file, an I/O error — is a gap in
  // the repository's control surface, not an empty answer. `readHead` returns `null` for
  // all of them, so the gap itself is recorded here.
  if (head === null) anomalies.push('head-not-read');

  const hooks: SnapshotHook[] = [];
  let hooksTruncated = false;

  // ── The hooks directory is a descent, so it obeys the descent rule ──────────
  //
  // `readdir` on a symlinked `hooks` follows it. Every name it returns then reads as
  // `<root>/.git/hooks/<name>` to `isContained`, which is lexical and therefore always
  // agrees — so the walk hashed `/etc/passwd` and reported it as a hook. Enumerate
  // through `listDirectory` and a link is a link: recorded by target, never listed.
  const hooksListing = await listDirectory(join(gitPath, 'hooks'));
  let hooksDirectoryLinkTarget: string | null = null;

  if (hooksListing.kind === 'symlink') {
    hooksDirectoryLinkTarget = hooksListing.target;
    anomalies.push(`hooks-directory-link:${hooksListing.target ?? ''}`);
  } else if (hooksListing.kind === 'listed') {
    for (const name of hooksListing.names) {
      if (hooks.length >= MAX_HOOKS) {
        hooksTruncated = true;
        anomalies.push('hooks-truncated');
        break;
      }

      const absolute = join(gitPath, 'hooks', name);
      if (!isContained(root, absolute)) {
        throw new SnapshotError(
          'SNAPSHOT_PATH_ESCAPE',
          `Hook ${JSON.stringify(name)} resolves outside ${root}`,
        );
      }

      const hookStat = await statOrUndefined(absolute);
      if (hookStat === undefined) continue;

      const kind = classify(hookStat);

      if (kind === 'file') {
        const candidateSize = hookStat.size;
        if (candidateSize > GIT_METADATA_MAX_BYTES) {
          oversize.push(join(GIT_DIRECTORY, 'hooks', name));
          anomalies.push(`hook-not-hashed:${name}`);
          hooks.push({ name, kind, sha256: null });
          continue;
        }

        try {
          hooks.push({ name, kind, sha256: (await hashRegularFile(absolute, hookStat)).sha256 });
        } catch {
          oversize.push(join(GIT_DIRECTORY, 'hooks', name));
          anomalies.push(`hook-not-hashed:${name}`);
          hooks.push({ name, kind, sha256: null });
        }

        continue;
      }

      if (kind === 'symlink') {
        try {
          hooks.push({ name, kind, sha256: sha256Bytes(`symlink:${await readlink(absolute)}`) });
        } catch {
          hooks.push({ name, kind, sha256: null });
        }
      }
    }
  }

  return {
    present: true,
    kind: 'directory',
    head,
    configSha256,
    indexSha256,
    gitfileSha256: null,
    hooks,
    hooksDirectoryLinkTarget,
    oversize,
    hooksTruncated,
    anomalies: normaliseAnomalies(anomalies),
  };
}

/**
 * `candidate` is inside `base`, lexically.
 *
 * Lexical on purpose. `realpath` would follow exactly the symlinks this module refuses to
 * follow, and a check that resolves the path cannot also promise it was never resolved.
 * Every component below `base` is a single `readdir` name, so traversal is impossible by
 * construction; this assertion is the belt to that brace.
 */
function isContained(base: string, candidate: string): boolean {
  return candidate === base || candidate.startsWith(base + sep);
}

interface WalkResult {
  readonly entries: readonly SnapshotEntry[];
  readonly totalBytes: number;
  readonly stopReason: SnapshotStopReason;
  /**
   * The directories below the root that are called `.git`, which the walk treats as content
   * (F-G11) and which the caller records as metadata anomalies (F-G14).
   */
  readonly nestedGitDirectories: readonly string[];
}

/** A directory queued for walking, with the `lstat` that classified it. */
interface PendingDirectory {
  readonly relativePath: string;
  /** The classification this path must still answer to after its children were read. */
  readonly stat: Stats;
}

/**
 * Is the directory we just walked still the directory we classified? — F-G20.
 *
 * Returns the stop reason, or `null` when the identity held. Two answers, because there are
 * two facts: `parent-replaced` when `dev`/`ino` moved or the path became a link (the name
 * resolves somewhere else, so the children may have been read through it), and `unstable`
 * when only `ctime` moved (the directory is the same one, but a child was created or removed
 * while it was being described).
 *
 * `ctime` is compared because an unprivileged process cannot set it — the same argument as
 * the file-level check in `hashRegularFile`. It is a best-effort signal: a filesystem with
 * one-second granularity can hide a change inside one tick.
 */
function directoryIdentityVerdict(
  classified: Stats,
  after: Stats | undefined,
): SnapshotStopReason {
  if (
    after === undefined ||
    after.isSymbolicLink() ||
    after.dev !== classified.dev ||
    after.ino !== classified.ino
  ) {
    return 'parent-replaced';
  }

  if (after.ctimeMs !== classified.ctimeMs) return 'unstable';

  return null;
}

/**
 * Walk the tree breadth-first with a sorted frontier.
 *
 * Sorted because a bound that stops mid-walk has to stop in the same place on every host;
 * an unsorted `readdir` would make "which 50,000 entries" a filesystem implementation
 * detail. Breadth-first because it keeps the stack proportional to the number of
 * directories rather than the depth of the tree, and because a truncated snapshot of a
 * deep tree is more useful when it includes every top-level entry.
 *
 * ## The parent is re-checked after its children (F-G20)
 *
 * Every queue entry carries the `lstat` that classified it. After the directory's children
 * have been read, the same path is `lstat`ed again and compared. A parent swapped for a
 * symbolic link between `readdir` and a child's `lstat` resolves the child through the link;
 * the child's own `lstat`/`fstat` agree with each other because both were resolved through
 * the same link, so the entry-level identity check cannot see it. The parent's identity can.
 *
 * On a mismatch the subtree's entries are **withdrawn**, not merely flagged. A path resolved
 * through a substituted parent may have produced a digest of a file outside the workspace,
 * and keeping it in a file would leave an off-tree hash where a reviewer looks for evidence
 * of the tree. The snapshot is `complete: false` either way, so nothing that was authority
 * is lost — and the attempt fails (F-G13), so nothing is silently accepted.
 */
async function walk(
  root: string,
  limits: SnapshotLimits,
  rootStat: Stats,
  options: TakeSnapshotOptions = {},
): Promise<WalkResult> {
  let entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  let stopReason: SnapshotStopReason = null;
  const nestedGitDirectories: string[] = [];

  const queue: PendingDirectory[] = [{ relativePath: '', stat: rootStat }];

  while (queue.length > 0) {
    const current = queue.shift() as PendingDirectory;
    const relativeDirectory = current.relativePath;
    const absoluteDirectory =
      relativeDirectory === '' ? root : join(root, relativeDirectory);

    if (!isContained(root, absoluteDirectory)) {
      throw new SnapshotError(
        'SNAPSHOT_PATH_ESCAPE',
        `Directory ${absoluteDirectory} is outside ${root}`,
      );
    }

    // The walk's own descent, through the same rule as `.git/hooks`. The queue only ever
    // holds paths that `lstat` classified as a directory, so `symlink`/`not-a-directory`
    // here means the entry was swapped between classification and enumeration — the tree
    // is not the one this snapshot was describing, which is `unstable`, not a listing.
    const listing = await listDirectory(absoluteDirectory);

    if (listing.kind === 'absent') {
      // Removed after it was queued. The tree is not the one we started describing.
      stopReason = 'unreadable';
      break;
    }

    if (listing.kind === 'symlink' || listing.kind === 'not-a-directory') {
      stopReason = 'unstable';
      break;
    }

    // The seam the parent-swap suite uses to hold the window open. Nothing else passes it.
    await options.afterDirectoryListed?.(relativeDirectory);

    const names = listing.names;

    for (const name of names) {
      // A `.git` at the **workspace root** is the repository's own metadata: excluded from
      // content here and described by `readGitMetadata` instead. At any other depth it is
      // not the root repository's metadata — it belongs to a nested repository or a
      // submodule, which is a place the agent can write — so it is walked as content like
      // every other directory. Excluding it at every depth made it a silent write area:
      // a write under `sub/.git` changed no entry and no digest (F-G11).
      if (
        name === '.' ||
        name === '..' ||
        name.includes(sep) ||
        (name === GIT_DIRECTORY && relativeDirectory === '')
      ) {
        continue;
      }

      const relativePath = relativeDirectory === '' ? name : `${relativeDirectory}/${name}`;
      const absolute = join(root, relativePath);

      if (!isContained(root, absolute)) {
        throw new SnapshotError(
          'SNAPSHOT_PATH_ESCAPE',
          `Entry ${JSON.stringify(relativePath)} resolves outside ${root}`,
        );
      }

      // A `.git` below the root is content now, and its presence is a fact about the tree
      // a reviewer must be able to find without diffing digests (F-G14). Recorded whatever
      // its kind: a submodule pointer is a `.git` *file* and is just as much a nested
      // repository as a nested clone is.
      if (name === GIT_DIRECTORY) nestedGitDirectories.push(relativePath);

      if (entries.length >= limits.maxEntries) {
        stopReason = 'max-entries';
        break;
      }

      const stat = await statOrUndefined(absolute);

      if (stat === undefined) {
        stopReason = 'unreadable';
        break;
      }

      const kind = classify(stat);
      const mode = stat.mode & 0o7777;

      if (kind === 'dir') {
        entries.push({ path: relativePath, kind, mode, sizeBytes: 0, sha256: null, symlinkTarget: null });
        queue.push({ relativePath, stat });
        continue;
      }

      if (kind === 'symlink') {
        let target: string;
        try {
          target = await readlink(absolute);
        } catch {
          stopReason = 'unreadable';
          break;
        }

        // Recorded, never resolved. The target may be `/etc/passwd`, a sibling outside the
        // workspace, or a name that does not exist — all three are the same fact here.
        entries.push({
          path: relativePath,
          kind,
          mode,
          sizeBytes: 0,
          sha256: null,
          symlinkTarget: target,
        });
        continue;
      }

      if (kind === 'special') {
        entries.push({ path: relativePath, kind, mode, sizeBytes: 0, sha256: null, symlinkTarget: null });
        continue;
      }

      // Regular file: the budget is checked against the size `lstat` reports, before the
      // file is opened.
      if (totalBytes + stat.size > limits.maxTotalBytes) {
        stopReason = 'max-total-bytes';
        break;
      }

      let digest: { sha256: string; sizeBytes: number };
      try {
        digest = await hashRegularFile(absolute, stat);
      } catch (error) {
        // A contested entry is not "unreadable": the bytes were readable, the identity was
        // wrong. Both stop the walk, but the reason is different and the reason is the
        // only thing an operator can act on.
        stopReason = error instanceof UnstableEntryError ? 'unstable' : 'unreadable';
        break;
      }

      totalBytes += digest.sizeBytes;
      entries.push({
        path: relativePath,
        kind,
        mode,
        sizeBytes: digest.sizeBytes,
        sha256: digest.sha256,
        symlinkTarget: null,
      });
    }

    if (stopReason !== null) break;

    // ── The directory is still the one that was classified (F-G20) ─────────────
    //
    // Runs after the children, because the window to hold is between this directory's
    // `readdir` and a child's `lstat`: a parent swapped for a link inside that window
    // resolves every child through the link, and the child's own identity check agrees
    // with itself because both halves were resolved through it.
    const verdict = directoryIdentityVerdict(current.stat, await statOrUndefined(absoluteDirectory));

    if (verdict !== null) {
      stopReason = verdict;

      // Only a moved identity withholds entries. When `dev`/`ino` moved (or the path became
      // a link), the child paths were resolved through a name that now means something
      // else, so a digest under it may be a digest of a file outside the workspace:
      // keeping them "for forensics" would put an off-tree hash in a file an operator opens
      // as evidence of the tree. Withdrawing is the honest answer, and `complete: false`
      // already says the snapshot is not authority (F-G13 fails the attempt).
      //
      // A `ctime`-only mismatch is the same directory with a child that appeared or
      // vanished. The entries read from it are what they were at read time, so they stay —
      // the same choice the walk already makes when `unstable` stops it mid-listing.
      if (verdict === 'parent-replaced') {
        const contested = (path: string): boolean =>
          relativeDirectory === '' ||
          path === relativeDirectory ||
          path.startsWith(`${relativeDirectory}/`);

        entries = entries.filter((entry) => !contested(entry.path));
        for (let index = nestedGitDirectories.length - 1; index >= 0; index -= 1) {
          if (contested(nestedGitDirectories[index] as string)) {
            nestedGitDirectories.splice(index, 1);
          }
        }

        totalBytes = entries.reduce((sum, entry) => sum + entry.sizeBytes, 0);
      }

      break;
    }
  }

  return { entries, totalBytes, stopReason, nestedGitDirectories };
}

/**
 * The one deterministic form of a snapshot.
 *
 * Determinism is not a style preference here: the digest is compared across attempts, and
 * two hosts that serialise the same tree differently would report a change that did not
 * happen. Field order is the literal order below — `JSON.stringify` preserves insertion
 * order for string keys, and nothing here relies on a map's iteration order.
 *
 * `capturedAt` is deliberately outside the body. Two snapshots of an unchanged tree then
 * have the same digest, which is what makes "nothing changed" a fact rather than an
 * inference. The timestamp is carried in the snapshot envelope and, once persisted, in
 * the artifact checksum that covers this body plus that envelope.
 */
export function serialiseSnapshot(input: SnapshotDigestInput): string {
  return JSON.stringify({
    version: SNAPSHOT_VERSION,
    root: input.root,
    complete: input.complete,
    stopReason: input.stopReason,
    entryCount: input.entryCount,
    totalBytes: input.totalBytes,
    limits: { maxEntries: input.limits.maxEntries, maxTotalBytes: input.limits.maxTotalBytes },
    git: {
      present: input.git.present,
      kind: input.git.kind,
      head: input.git.head,
      configSha256: input.git.configSha256,
      indexSha256: input.git.indexSha256,
      gitfileSha256: input.git.gitfileSha256,
      hooks: input.git.hooks.map((hook) => ({
        name: hook.name,
        kind: hook.kind,
        sha256: hook.sha256,
      })),
      hooksDirectoryLinkTarget: input.git.hooksDirectoryLinkTarget,
      oversize: [...input.git.oversize].sort(comparePathBytes),
      hooksTruncated: input.git.hooksTruncated,
      anomalies: [...input.git.anomalies].sort(comparePathBytes),
    },
    entries: input.entries.map((entry) => ({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      sizeBytes: entry.sizeBytes,
      sha256: entry.sha256,
      symlinkTarget: entry.symlinkTarget,
    })),
  });
}

/** SHA-256 of `serialiseSnapshot(input)`. */
export function snapshotDigest(input: SnapshotDigestInput): string {
  return sha256Bytes(serialiseSnapshot(input));
}

/**
 * Describe a workspace tree from the host, with no subprocess and no repository config.
 *
 * `root` is the directory bound into the sandbox as `/workspace` (`<rootPath>/repo`), not
 * the workspace root: `artifacts/` and `evidence/` are siblings of the checkout and are
 * not the agent's work. Snapshotting the parent would make the evidence self-referential.
 */
export async function takeWorkspaceSnapshot(
  root: string,
  options: TakeSnapshotOptions = {},
): Promise<WorkspaceSnapshot> {
  const absoluteRoot = resolve(root);
  const limits: SnapshotLimits = {
    maxEntries: options.maxEntries ?? DEFAULT_MAX_ENTRIES,
    maxTotalBytes: options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES,
  };

  if (!Number.isInteger(limits.maxEntries) || limits.maxEntries <= 0) {
    throw new SnapshotError('SNAPSHOT_LIMITS_INVALID', `maxEntries must be a positive integer`);
  }

  if (!Number.isInteger(limits.maxTotalBytes) || limits.maxTotalBytes <= 0) {
    throw new SnapshotError('SNAPSHOT_LIMITS_INVALID', `maxTotalBytes must be a positive integer`);
  }

  const rootStat = await statOrUndefined(absoluteRoot);

  if (rootStat === undefined || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new SnapshotError(
      'SNAPSHOT_ROOT_INVALID',
      `Snapshot root ${absoluteRoot} must be a directory, not a symlink or a file`,
    );
  }

  const walked = await walk(absoluteRoot, limits, rootStat, options);
  const git = await readGitMetadata(absoluteRoot);

  // A nested `.git` is content now (F-G11), and its presence is a fact about the tree that
  // a reviewer must be able to see without diffing digests (F-G14). Merged into the
  // metadata anomaly list rather than a field of its own: one list, one durable record, one
  // place to look.
  const anomalies = normaliseAnomalies([
    ...git.anomalies,
    ...walked.nestedGitDirectories.map((path) => `nested-git:${path}`),
  ]);

  // Metadata we could not digest, or a hooks directory we could not enumerate, is a gap
  // in the same evidence set. It downgrades completeness rather than being dropped.
  //
  // Anomalies deliberately do **not** downgrade completeness: that would hand the agent a
  // switch that turns evidence off with one `ln -s`, which is the shape of the defect this
  // gate exists to remove. They are recorded instead — see the worker's
  // `attempt.evidence_anomaly.v1`.
  const gitIncomplete = git.oversize.length > 0 || git.hooksTruncated;
  const stopReason = walked.stopReason ?? (gitIncomplete ? 'unreadable' : null);
  const complete = stopReason === null;

  const body: SnapshotDigestInput = {
    root: absoluteRoot,
    complete,
    stopReason,
    entryCount: walked.entries.length,
    totalBytes: walked.totalBytes,
    limits,
    entries: walked.entries,
    git: anomalies.length === git.anomalies.length ? git : { ...git, anomalies },
  };

  return {
    ...body,
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    digest: snapshotDigest(body),
  };
}
