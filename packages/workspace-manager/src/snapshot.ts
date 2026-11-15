import { createHash } from 'node:crypto';
import { createReadStream, type Stats } from 'node:fs';
import { readdir, readFile, lstat, readlink } from 'node:fs/promises';
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
 * spawn, does not read `.git/config`, and cannot be configured by anything inside the
 * tree it is describing. ESLint enforces the first of those structurally: files under
 * `packages/workspace-manager/src` may not import `child_process` at all.
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
 *    never opened. A link to a directory outside the tree is not walked into.
 * 2. **Special files are classified, never opened.** Opening a FIFO blocks until a writer
 *    appears, and reading a character device can block or stream forever. A snapshot of a
 *    repository containing a FIFO must not hang, so `fifo`/`socket`/`device` become
 *    `kind: 'special'` with no digest.
 * 3. **An incomplete snapshot says so.** `maxEntries` and `maxTotalBytes` bound the walk.
 *    Exceeding either stops it and sets `complete: false` with the counts actually
 *    reached. A partial manifest that looks whole is the same failure as the empty
 *    `git diff`: a confident wrong answer.
 */

/** Bumped when the canonical form changes. A digest is only comparable at its version. */
export const SNAPSHOT_VERSION = 1;

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

/** A hooks directory with more entries than this is not a hooks directory. */
const MAX_HOOKS = 1_024;

/** The directory excluded from the content manifest at every depth. */
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
  | 'unstable'
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
  /** `directory` for a normal checkout, `file` for a worktree's `gitdir:` pointer. */
  readonly kind: 'directory' | 'file' | null;
  /** Resolved branch ref or commit id as written. `null` when absent or a gitfile. */
  readonly head: string | null;
  readonly configSha256: string | null;
  readonly indexSha256: string | null;
  /** Hash of the `.git` file itself, for a worktree checkout. */
  readonly gitfileSha256: string | null;
  readonly hooks: readonly SnapshotHook[];
  /** Metadata files that exceeded `GIT_METADATA_MAX_BYTES` and were not hashed. */
  readonly oversize: readonly string[];
  /** True when the hooks directory held more than `MAX_HOOKS` entries. */
  readonly hooksTruncated: boolean;
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

/**
 * Stream one file through SHA-256.
 *
 * Streamed rather than read whole: a 2 GiB artifact in a workspace must cost a fixed
 * buffer, not its own size in the worker's heap. The byte count is returned because it is
 * the only way to notice that the file was not the size `lstat` reported.
 */
function digestFile(absolute: string): Promise<{ sha256: string; sizeBytes: number }> {
  return new Promise((resolvePromise, reject) => {
    const hash = createHash('sha256');
    let sizeBytes = 0;
    let settled = false;

    const stream = createReadStream(absolute);

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

/** `lstat` without throwing: `undefined` means the entry is gone. */
async function statOrUndefined(absolute: string): Promise<Stats | undefined> {
  try {
    return await lstat(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
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
 * Read the git metadata the content manifest deliberately excludes.
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
    oversize: [],
    hooksTruncated: false,
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
      gitfileSha256: sha256Bytes(target ?? ''),
    };
  }

  if (stat.isFile()) {
    const bytes = await readFile(gitPath);
    return { ...empty, present: true, kind: 'file', gitfileSha256: sha256Bytes(bytes) };
  }

  if (!stat.isDirectory()) {
    return { ...empty, present: true, kind: 'file' };
  }

  const oversize: string[] = [];

  const digestMetadata = async (name: string): Promise<string | null> => {
    const absolute = join(gitPath, name);
    const candidate = await statOrUndefined(absolute);

    // A symlinked `config`/`index` is recorded by target, never read through: that is the
    // same rule the content walk follows, and it is what stops `.git/config` from being a
    // read primitive for an arbitrary host file.
    if (candidate === undefined) return null;

    if (candidate.isSymbolicLink()) {
      try {
        return sha256Bytes(`symlink:${await readlink(absolute)}`);
      } catch {
        return null;
      }
    }

    if (!candidate.isFile()) return null;

    if (candidate.size > GIT_METADATA_MAX_BYTES) {
      oversize.push(name);
      return null;
    }

    try {
      return (await digestFile(absolute)).sha256;
    } catch {
      oversize.push(name);
      return null;
    }
  };

  const [configSha256, indexSha256] = await Promise.all([
    digestMetadata('config'),
    digestMetadata('index'),
  ]);

  let head: string | null = null;
  try {
    const raw = await readFile(join(gitPath, 'HEAD'), 'utf8');
    const trimmed = raw.trim();
    head = trimmed.length === 0 ? null : trimmed.slice(0, GIT_HEAD_MAX_CHARS);
  } catch {
    head = null;
  }

  const hooks: SnapshotHook[] = [];
  let hooksTruncated = false;

  try {
    const names = (await readdir(join(gitPath, 'hooks'))).sort(comparePathBytes);

    for (const name of names) {
      if (hooks.length >= MAX_HOOKS) {
        hooksTruncated = true;
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
          hooks.push({ name, kind, sha256: null });
          continue;
        }

        try {
          hooks.push({ name, kind, sha256: (await digestFile(absolute)).sha256 });
        } catch {
          oversize.push(join(GIT_DIRECTORY, 'hooks', name));
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
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  return {
    present: true,
    kind: 'directory',
    head,
    configSha256,
    indexSha256,
    gitfileSha256: null,
    hooks,
    oversize,
    hooksTruncated,
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
}

/**
 * Walk the tree breadth-first with a sorted frontier.
 *
 * Sorted because a bound that stops mid-walk has to stop in the same place on every host;
 * an unsorted `readdir` would make "which 50,000 entries" a filesystem implementation
 * detail. Breadth-first because it keeps the stack proportional to the number of
 * directories rather than the depth of the tree, and because a truncated snapshot of a
 * deep tree is more useful when it includes every top-level entry.
 */
async function walk(root: string, limits: SnapshotLimits): Promise<WalkResult> {
  const entries: SnapshotEntry[] = [];
  let totalBytes = 0;
  let stopReason: SnapshotStopReason = null;

  const queue: string[] = [''];

  while (queue.length > 0) {
    const relativeDirectory = queue.shift() as string;
    const absoluteDirectory =
      relativeDirectory === '' ? root : join(root, relativeDirectory);

    if (!isContained(root, absoluteDirectory)) {
      throw new SnapshotError(
        'SNAPSHOT_PATH_ESCAPE',
        `Directory ${absoluteDirectory} is outside ${root}`,
      );
    }

    let names: string[];
    try {
      names = (await readdir(absoluteDirectory)).sort(comparePathBytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // Removed after it was queued. The tree is not the one we started describing.
        stopReason = 'unreadable';
        break;
      }

      throw error;
    }

    for (const name of names) {
      if (name === '.' || name === '..' || name.includes(sep) || name === GIT_DIRECTORY) {
        // `readdir` cannot return separators or dots; a `.git` at any depth is metadata,
        // not content. The first two conditions are assertions that cost one comparison.
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
        queue.push(relativePath);
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
        digest = await digestFile(absolute);
      } catch {
        stopReason = 'unreadable';
        break;
      }

      // The file changed size while it was being read, so this digest describes a state
      // that did not exist at one instant. Report it rather than record a half-truth.
      if (digest.sizeBytes !== stat.size) {
        stopReason = 'unstable';
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
  }

  return { entries, totalBytes, stopReason };
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
      oversize: [...input.git.oversize].sort(comparePathBytes),
      hooksTruncated: input.git.hooksTruncated,
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

  const walked = await walk(absoluteRoot, limits);
  const git = await readGitMetadata(absoluteRoot);

  // Metadata we could not digest, or a hooks directory we could not enumerate, is a gap
  // in the same evidence set. It downgrades completeness rather than being dropped.
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
    git,
  };

  return {
    ...body,
    capturedAt: (options.now?.() ?? new Date()).toISOString(),
    digest: snapshotDigest(body),
  };
}
