import { readdir, readFile, rmdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CgroupError,
  DEFAULT_CGROUP_ROOT,
  killCgroup,
  listProcesses,
  removeCgroup,
  type CgroupHandle,
} from './cgroup';

/**
 * Leaf hygiene: name a leaf so it cannot collide, dispose of it so it cannot leak, and
 * reconcile the ones a crashed run left behind.
 *
 * ## The leak this exists for
 *
 * `removeCgroup` does not throw when it cannot remove a leaf — it returns `false`, because
 * a transient `EBUSY` is normal while a killed process is being reaped. Every `finally`
 * in the suites called it and discarded the boolean:
 *
 * ```ts
 * } finally {
 *   await removeCgroup(handle);     // false == still there, silently
 * }
 * ```
 *
 * Three leaves survived for days that way (`cpu-budget-857041-28855`,
 * `oom-684210-31881`, `oom3-687854` — recorded in `IO-ENFORCEMENT-PROOF.md` §8). One of
 * them still held a busy-loop shell, so it was not even inert: it kept charging the
 * delegation root's CPU and it kept the leaf un-removable forever. A boolean nobody reads
 * is not a cleanup path.
 *
 * ## Three properties
 *
 *   1. **A name is an attempt, not a pid.** `makeLeafId` returns `<label>-<pid>-<time36>-<n>`.
 *      A bare pid is reused by the next run and collides with a leaked leaf; the sequence
 *      and timestamp make the name unique within a process and across processes.
 *   2. **Empty before `rmdir`.** `disposeLeaf` kills, waits for `cgroup.procs` to empty,
 *      and *refuses to call `rmdir`* while anything is still in the leaf. `rmdir` on a
 *      non-empty cgroup would fail anyway, but the failure would be the opaque `EBUSY`
 *      again instead of "pid 4242 is still in it".
 *   3. **Reconciliation is an allowlist.** `reconcileTestLeaves` only ever considers names
 *      the test suites produce. Production leaves are named by execution workspace id (a
 *      UUID); `worker` is the launcher's leaf. Anything unrecognised is reported and
 *      refused, never deleted — this function is run by an operator, and an operator
 *      typo must not be able to delete the worker's own cgroup.
 */

/**
 * The labels the suites use. Deliberately an allowlist and not a wildcard: a pattern like
 * `/^[a-z-]+-\d+-\d+$/` would also match a future production naming scheme, and the whole
 * value of the check is that it cannot.
 */
const TEST_OWNED_LABELS = [
  'attempt',
  'cleanup',
  'cpu',
  'cpu-budget',
  'cpu-desc-child',
  'cpu-desc-parent',
  'cpu-under',
  'files',
  'io-bad-device',
  'io-baseline',
  'io-max',
  'io-probe',
  'io-throttled',
  'iso-a',
  'iso-b',
  'kill',
  'limits',
  'oom',
  'pids',
  'place',
  'probe',
  'swap',
  'tier-probe',
  'truth',
  'twice',
] as const;

/**
 * `<label>-<pid>-<time36>-<sequence>`, plus the older `<label>-<pid>-<5 digits>` form that
 * leaked leaves on this host still carry. Both are test-owned; neither can be produced by
 * the production path, which uses a UUID from `executionWorkspaceIdFor`.
 */
const TEST_LEAF_NAME = new RegExp(
  `^(?:${TEST_OWNED_LABELS.join('|')})-(?:[0-9]+-[0-9a-z]+-[0-9]+|[0-9]+-[0-9]+)$`,
);

const LABEL = /^[a-z][a-z0-9-]{0,19}$/;

/** `CGROUP_ID` in `cgroup.ts`: 1–64 of `[A-Za-z0-9_-]`. */
const MAX_LEAF_ID = 64;

let sequence = 0;

/**
 * A leaf id that identifies **this attempt**, not **this process**.
 *
 * The pid is included because it makes a leaked leaf point at the run that made it, but it
 * is not sufficient: `Date.now()` alone is not sufficient either (two leaves in one
 * millisecond), and a counter alone is not unique across processes. All three together are
 * cheap and unambiguous.
 */
export function makeLeafId(label: string, now: number = Date.now()): string {
  if (!LABEL.test(label)) {
    throw new CgroupError(
      'CGROUP_CREATE_FAILED',
      `Refusing leaf label "${label}": expected ${LABEL.source} (lowercase, no slash).`,
    );
  }

  sequence += 1;

  const id = `${label}-${String(process.pid)}-${now.toString(36)}-${String(sequence)}`;

  if (id.length > MAX_LEAF_ID) {
    throw new CgroupError(
      'CGROUP_CREATE_FAILED',
      `Refusing leaf id "${id}": ${String(id.length)} characters exceeds the ${String(MAX_LEAF_ID)}-character cgroup name limit.`,
    );
  }

  return id;
}

/** True when the name is one the test suites produce. Never used to *find* a leaf — only to permit deletion. */
export function isTestOwnedLeafName(name: string): boolean {
  return TEST_LEAF_NAME.test(name);
}

export interface LeafState {
  readonly path: string;
  readonly exists: boolean;
  readonly pids: readonly number[];
  /** `cgroup.events`' `populated` line; `null` when the file could not be parsed. */
  readonly populated: boolean | null;
}

/** What is in this leaf right now. `cgroup.procs`, not a name match, is the authority. */
export async function readLeafState(path: string): Promise<LeafState> {
  let procsText: string;

  try {
    procsText = await readFile(join(path, 'cgroup.procs'), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path, exists: false, pids: [], populated: null };
    }

    throw error;
  }

  const pids = procsText
    .split('\n')
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0);

  let populated: boolean | null = null;

  try {
    const events = await readFile(join(path, 'cgroup.events'), 'utf8');
    const match = /^populated\s+(\d+)$/m.exec(events);

    if (match?.[1] !== undefined) populated = match[1] === '1';
  } catch {
    // `cgroup.events` is not load-bearing: `cgroup.procs` already answered the question.
    populated = null;
  }

  return { path, exists: true, pids, populated };
}

export interface DisposeOptions {
  readonly attempts?: number;
  readonly delayMs?: number;
  /** Seams, so the kill/verify/refuse logic is testable without a full-tier host. */
  readonly listPids?: (handle: CgroupHandle) => Promise<readonly number[]>;
  readonly kill?: (handle: CgroupHandle) => Promise<void>;
  readonly remove?: (handle: CgroupHandle) => Promise<boolean>;
  readonly wait?: (ms: number) => Promise<void>;
}

export interface DisposeResult {
  readonly path: string;
  readonly removed: boolean;
  readonly killedPids: readonly number[];
  readonly remainingPids: readonly number[];
  readonly reason?: string;
}

/**
 * Dispose of a leaf on **every** path: success, assertion failure, timeout and forced
 * child termination.
 *
 * The four cases collapse into one procedure, which is the point — a per-case cleanup is
 * four places to forget one:
 *
 *   - success / assertion failure: the leaf is empty → `rmdir` straight away;
 *   - timeout: the caller's deadline fired but the child may still be alive → `cgroup.kill`
 *     reaches every descendant in one kernel pass, which is why it is used rather than a
 *     signal to a process group the child may have escaped;
 *   - forced termination: same path, plus a second kill halfway through the wait, because a
 *     process can fork between the first kill and the read.
 *
 * It never throws. A cleanup failure must not replace the assertion failure that caused the
 * cleanup, and it must not be silent either: the result carries `removed` and `remainingPids`,
 * and the caller reports them.
 */
export async function disposeLeaf(
  handle: CgroupHandle,
  options: DisposeOptions = {},
): Promise<DisposeResult> {
  const listPids = options.listPids ?? listProcesses;
  const kill = options.kill ?? killCgroup;
  const remove =
    options.remove ??
    ((target: CgroupHandle): Promise<boolean> =>
      removeCgroup(target, {
        ...(options.attempts === undefined ? {} : { attempts: options.attempts }),
        ...(options.delayMs === undefined ? {} : { delayMs: options.delayMs }),
      }));
  const wait = options.wait ?? ((ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms)));

  const attempts = options.attempts ?? 40;
  const delayMs = options.delayMs ?? 25;

  // A read failure is not an empty leaf. `listProcesses` already maps ENOENT to `[]`
  // (a leaf the reaper removed), so an error here is EACCES/EPERM/EIO — and removing a
  // cgroup whose contents could not be read would be deleting on an assumption.
  const readPids = async (): Promise<{ readonly ok: boolean; readonly pids: readonly number[] }> => {
    try {
      return { ok: true, pids: await listPids(handle) };
    } catch {
      return { ok: false, pids: [] };
    }
  };

  const killedPids: number[] = [];
  const first = await readPids();

  if (first.pids.length > 0) {
    killedPids.push(...first.pids);
    await kill(handle).catch(() => undefined);
  }

  let remaining: readonly number[] = first.pids;
  let verified = first.ok;
  const halfWay = Math.floor(attempts / 2);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const read = attempt === 0 ? first : await readPids();

    if (!read.ok) {
      verified = false;
      break;
    }

    remaining = read.pids;

    if (remaining.length === 0) break;

    // A process forked after the first kill is still in the tree. One second pass covers
    // the ordinary case; past that, this is reported rather than looped on forever.
    if (attempt === halfWay) {
      killedPids.push(...remaining);
      await kill(handle).catch(() => undefined);
    }

    if (attempt < attempts - 1) await wait(delayMs);
  }

  if (!verified) {
    return {
      path: handle.path,
      removed: false,
      killedPids,
      remainingPids: [],
      reason:
        'cgroup.procs could not be read, so the leaf cannot be shown to be empty; ' +
        'refusing to rmdir a cgroup whose contents are unverified',
    };
  }

  if (remaining.length > 0) {
    return {
      path: handle.path,
      removed: false,
      killedPids,
      remainingPids: remaining,
      reason:
        `leaf still holds ${String(remaining.length)} process(es) after ${String(attempts)} ` +
        `checks (${remaining.slice(0, 8).join(', ')}); refusing to rmdir a non-empty cgroup`,
    };
  }

  const removed = await remove(handle).catch(() => false);

  return {
    path: handle.path,
    removed,
    killedPids,
    remainingPids: [],
    ...(removed
      ? {}
      : { reason: 'rmdir did not remove the leaf; it may already be gone or still busy' }),
  };
}

export interface LeafClassification {
  readonly name: string;
  readonly path: string;
  readonly ownedByTests: boolean;
  readonly pids: readonly number[];
  readonly populated: boolean | null;
  readonly removable: boolean;
  /** Why this leaf must not be removed. Absent exactly when `removable` is true. */
  readonly refusal?: string;
}

/**
 * Decide what may be deleted. Pure, so every refusal is testable without arranging the
 * filesystem state that produces it.
 */
export function classifyLeaf(
  name: string,
  path: string,
  pids: readonly number[],
  populated: boolean | null,
): LeafClassification {
  const ownedByTests = isTestOwnedLeafName(name);

  const refusal = !ownedByTests
    ? `not a test-owned leaf name; production leaves carry an execution workspace id and ` +
      `${DEFAULT_CGROUP_ROOT}/worker belongs to the launcher`
    : pids.length > 0
      ? `holds ${String(pids.length)} process(es): ${pids.slice(0, 8).join(', ')}`
      : populated === true
        ? 'cgroup.events reports populated=1 although cgroup.procs is empty'
        : undefined;

  return {
    name,
    path,
    ownedByTests,
    pids,
    populated,
    removable: refusal === undefined,
    ...(refusal === undefined ? {} : { refusal }),
  };
}

/** Every directory under the root, classified. Sorted, so two runs diff cleanly. */
export async function listStaleTestLeaves(
  root: string = DEFAULT_CGROUP_ROOT,
): Promise<readonly LeafClassification[]> {
  const entries = await readdir(root, { withFileTypes: true });
  const names = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  const classified: LeafClassification[] = [];

  for (const name of names) {
    const path = join(root, name);
    const state = await readLeafState(path);

    classified.push(classifyLeaf(name, path, state.pids, state.populated));
  }

  return classified;
}

export interface ReconcileOptions {
  readonly root?: string;
  /** `false` (default) lists only. Deletion is an explicit, separate decision. */
  readonly apply?: boolean;
}

export interface ReconcileReport {
  readonly root: string;
  readonly applied: boolean;
  readonly leaves: readonly LeafClassification[];
  readonly removable: readonly string[];
  readonly removed: readonly string[];
  readonly refused: readonly { readonly path: string; readonly reason: string }[];
}

/**
 * List the leaves a crashed or timed-out run left behind, and remove **only** the ones
 * that are test-owned and empty.
 *
 * Dry run unless `apply: true`. Emptiness is re-read immediately before each `rmdir`,
 * because the listing and the removal are two different moments and a process can be
 * forked between them.
 */
export async function reconcileTestLeaves(
  options: ReconcileOptions = {},
): Promise<ReconcileReport> {
  const root = options.root ?? DEFAULT_CGROUP_ROOT;
  const applied = options.apply === true;
  const leaves = await listStaleTestLeaves(root);

  const removable = leaves.filter((leaf) => leaf.removable).map((leaf) => leaf.path);
  const removed: string[] = [];
  const refused: { path: string; reason: string }[] = leaves
    .filter((leaf) => !leaf.removable)
    .map((leaf) => ({ path: leaf.path, reason: leaf.refusal ?? 'not removable' }));

  if (applied) {
    for (const path of removable) {
      const state = await readLeafState(path);

      if (!state.exists) {
        removed.push(path);
        continue;
      }

      if (state.pids.length > 0 || state.populated === true) {
        refused.push({
          path,
          reason: `became non-empty between the listing and the removal (${state.pids.join(', ') || 'populated=1'})`,
        });
        continue;
      }

      try {
        await rmdir(path);
        removed.push(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          removed.push(path);
          continue;
        }

        refused.push({
          path,
          reason: `rmdir failed: ${(error as NodeJS.ErrnoException).code ?? String(error)}`,
        });
      }
    }
  }

  return { root, applied, leaves, removable, removed, refused };
}
