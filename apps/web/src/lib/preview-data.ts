import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * The preview loader — **server-only**.
 *
 * `/preview` exists because the control centre's browser client talks to the API
 * on `localhost:4100`, and a phone behind a tunnel to `:3100` would resolve
 * `localhost` to itself. So this module reads its two sources on the server:
 *
 *   1. the programme ledger, from disk (`node:fs`), and
 *   2. `GET /health/ready` on the loopback address.
 *
 * There is no browser-side call, no proxy route, and no change to `lib/api.ts`.
 * The page receives finished HTML.
 *
 * Why a client component cannot import this module: `node:fs` and `node:path`
 * do not exist in the browser, so a client bundle that reaches this file fails
 * to build. That is the enforcement — the import graph itself, not a convention.
 * `server-only` is not a dependency of this workspace, so the guard below is the
 * local equivalent: a loud failure if the module is ever evaluated in a browser
 * runtime instead of the Node server.
 *
 * What is allowed to leave this module is an **allowlist**, not the ledger:
 * `branch`, `head`, `phase`, `updatedAt`, and per task `id`, `title`, `status`,
 * `phase`, `riskClass`, `dependsOn`, `owner`, `updatedAt`,
 * `evidenceRequirement.artifact` and `executionPolicy.gate`. The evidence note is
 * truncated to 240 characters. Nothing else crosses the boundary, and no error
 * message carries an absolute path.
 */

if (typeof window !== 'undefined') {
  throw new Error(
    'lib/preview-data is server-only: it reads the programme ledger from disk and must not be bundled for the browser.',
  );
}

/** Repo-relative. The absolute root is discovered, never hardcoded. */
export const LEDGER_RELATIVE_PATH = 'docs/engineering/programme/EXECUTION-STATE.json';

/** `evidenceRequirement.note` is shown truncated or not at all — never in full. */
export const NOTE_LIMIT = 240;

/**
 * Loopback, server-side only. This string is never rendered: the page reports
 * dependency status, not the address it was read from.
 */
const READINESS_URL = 'http://127.0.0.1:4100/health/ready';
const READINESS_TIMEOUT_MS = 2000;

/* ---------------------------------------------------------------------------
 * Model
 * ------------------------------------------------------------------------- */

export type PreviewFilter = 'all' | 'completed' | 'blocked' | 'planned';

export interface PreviewTask {
  readonly id: string;
  readonly title: string;
  /** Ledger value, lower-cased. Unknown values are kept, not coerced. */
  readonly status: string;
  readonly phase: string;
  readonly riskClass: string;
  readonly dependsOn: readonly string[];
  readonly owner: string;
  readonly updatedAt: string;
  /** Repo-relative path from `evidenceRequirement.artifact`, or `null`. */
  readonly evidenceArtifact: string | null;
  /** `executionPolicy.gate`, or `null` when the ledger records none. */
  readonly gate: string | null;
  /** `evidenceRequirement.note`, truncated to `NOTE_LIMIT`. */
  readonly evidenceNote: string | null;
}

export interface PreviewLedger {
  readonly branch: string;
  readonly head: string;
  readonly phase: string;
  readonly updatedAt: string;
  readonly tasks: readonly PreviewTask[];
  /** Entries dropped because they carried no usable `id`. Reported, not hidden. */
  readonly droppedTasks: number;
}

export type LedgerParseResult =
  | { readonly ok: true; readonly ledger: PreviewLedger }
  | { readonly ok: false; readonly error: string };

export interface ProgrammeSummary {
  readonly total: number;
  readonly completed: number;
  readonly blocked: number;
  readonly planned: number;
  /** Tasks carrying a status outside the three counted above. */
  readonly other: number;
  /** `completed / total`, one decimal. `0` when there are no tasks — never NaN. */
  readonly percentage: number;
}

export type DependencyStatus = 'up' | 'down' | 'not reported' | 'unavailable';

export interface PreviewDependencyHealth {
  readonly name: string;
  readonly status: DependencyStatus;
  readonly latencyMs: number | null;
}

export interface PreviewHealth {
  readonly api: 'ready' | 'not_ready' | 'unavailable';
  readonly dependencies: readonly PreviewDependencyHealth[];
  /** ISO timestamp from the web server's clock, not the API's. */
  readonly checkedAt: string;
  /** Why the reading is unavailable, when it is. Never a credential, never a URL. */
  readonly note: string | null;
}

export interface PreviewData {
  readonly snapshotAt: string;
  readonly ledger: LedgerParseResult;
  readonly health: PreviewHealth;
}

/* ---------------------------------------------------------------------------
 * Parsing — allowlist only
 * ------------------------------------------------------------------------- */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function nonEmpty(value: string | null): string | null {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * A task artifact path is rendered on the page, so it must be repo-relative.
 * Absolute paths, drive letters, home-relative paths and `..` segments are
 * dropped rather than echoed: the page never names a filesystem location
 * outside the repository.
 */
export function safeRepoPath(value: unknown): string | null {
  const raw = nonEmpty(asString(value));
  if (raw === null) return null;
  if (raw.startsWith('/') || raw.startsWith('\\') || raw.startsWith('~')) return null;
  if (/^[A-Za-z]:[\\/]/.test(raw)) return null;
  if (raw.split(/[\\/]/).includes('..')) return null;
  return raw;
}

/** Truncates to `NOTE_LIMIT` characters *including* the ellipsis. */
export function capNote(value: string | null): string | null {
  const trimmed = nonEmpty(value);
  if (trimmed === null) return null;
  if (trimmed.length <= NOTE_LIMIT) return trimmed;
  return `${trimmed.slice(0, NOTE_LIMIT - 1).trimEnd()}…`;
}

function parseTask(value: unknown): PreviewTask | null {
  const task = asRecord(value);
  if (task === null) return null;

  const id = nonEmpty(asString(task['id']));
  if (id === null) return null;

  const evidence = asRecord(task['evidenceRequirement']);
  const policy = asRecord(task['executionPolicy']);
  const status = nonEmpty(asString(task['status']))?.toLowerCase() ?? 'unknown';

  return {
    id,
    title: nonEmpty(asString(task['title'])) ?? id,
    status,
    phase: nonEmpty(asString(task['phase'])) ?? '',
    riskClass: nonEmpty(asString(task['riskClass']))?.toLowerCase() ?? '',
    dependsOn: asStringArray(task['dependsOn']),
    owner: nonEmpty(asString(task['owner'])) ?? '',
    updatedAt: nonEmpty(asString(task['updatedAt'])) ?? '',
    evidenceArtifact: safeRepoPath(evidence?.['artifact']),
    gate: nonEmpty(asString(policy?.['gate'])),
    evidenceNote: capNote(asString(evidence?.['note'])),
  };
}

/**
 * Phase then id, both natural: `8.4` sorts before `8.6`, and `P83-009` before
 * `P83-010`. Non-numeric phases sort last so an unexpected value is visible at
 * the bottom instead of silently between two real phases.
 */
export function comparePhaseThenId(
  a: { readonly phase: string; readonly id: string },
  b: { readonly phase: string; readonly id: string },
): number {
  const left = a.phase.split('.');
  const right = b.phase.split('.');
  const depth = Math.max(left.length, right.length);

  for (let index = 0; index < depth; index += 1) {
    const segmentLeft = numericSegment(left[index]);
    const segmentRight = numericSegment(right[index]);
    if (segmentLeft !== segmentRight) return segmentLeft < segmentRight ? -1 : 1;
  }

  if (a.id === b.id) return 0;
  return a.id < b.id ? -1 : 1;
}

function numericSegment(value: string | undefined): number {
  if (value === undefined) return -1;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? Number.POSITIVE_INFINITY : parsed;
}

export function sortTasks<T extends { readonly phase: string; readonly id: string }>(
  tasks: readonly T[],
): readonly T[] {
  return [...tasks].sort(comparePhaseThenId);
}

/**
 * Parses the ledger text into the preview's allowlisted shape.
 *
 * A malformed ledger is an **error state**, not a crash and not an empty page:
 * the caller renders the message and the rest of the preview (health, the
 * honest footer) still works.
 */
export function parseLedger(raw: string): LedgerParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'The programme ledger is not valid JSON.' };
  }

  const root = asRecord(parsed);
  if (root === null) {
    return { ok: false, error: 'The programme ledger is not a JSON object.' };
  }

  const rawTasks = root['tasks'];
  if (!Array.isArray(rawTasks)) {
    return { ok: false, error: `The programme ledger has no tasks array (${LEDGER_RELATIVE_PATH}).` };
  }

  const tasks: PreviewTask[] = [];
  for (const entry of rawTasks) {
    const task = parseTask(entry);
    if (task !== null) tasks.push(task);
  }

  return {
    ok: true,
    ledger: {
      branch: nonEmpty(asString(root['branch'])) ?? '',
      head: nonEmpty(asString(root['head'])) ?? '',
      phase: nonEmpty(asString(root['phase'])) ?? '',
      updatedAt: nonEmpty(asString(root['updatedAt'])) ?? '',
      tasks: sortTasks(tasks),
      droppedTasks: rawTasks.length - tasks.length,
    },
  };
}

/* ---------------------------------------------------------------------------
 * Derivations — pure, and the only place the page gets its numbers
 * ------------------------------------------------------------------------- */

/**
 * Counts and completion.
 *
 * `completed / total`, and nothing else counts as complete: a blocked task is
 * work that is stopped, a planned task is work that has not started. A
 * denominator of zero yields `0`, never `NaN`.
 */
export function summarise(ledger: Pick<PreviewLedger, 'tasks'>): ProgrammeSummary {
  let completed = 0;
  let blocked = 0;
  let planned = 0;
  let other = 0;

  for (const task of ledger.tasks) {
    if (task.status === 'completed') completed += 1;
    else if (task.status === 'blocked') blocked += 1;
    else if (task.status === 'planned') planned += 1;
    else other += 1;
  }

  const total = ledger.tasks.length;
  const percentage = total === 0 ? 0 : Math.round((completed / total) * 1000) / 10;

  return { total, completed, blocked, planned, other, percentage };
}

export function blockedTasks(ledger: Pick<PreviewLedger, 'tasks'>): readonly PreviewTask[] {
  return sortTasks(ledger.tasks.filter((task) => task.status === 'blocked'));
}

/**
 * The first planned task whose every dependency is `completed`, in phase/id
 * order. A dependency that is missing from the ledger, blocked or still planned
 * is not satisfied — so the function returns `null` rather than guessing.
 */
export function nextEligible(ledger: Pick<PreviewLedger, 'tasks'>): PreviewTask | null {
  const completed = new Set(
    ledger.tasks.filter((task) => task.status === 'completed').map((task) => task.id),
  );

  for (const task of sortTasks(ledger.tasks)) {
    if (task.status !== 'planned') continue;
    if (task.dependsOn.every((dependency) => completed.has(dependency))) return task;
  }

  return null;
}

/**
 * Facts about blockers that the ledger alone supports. Each sentence is a
 * restatement of a recorded field — a gate, or a `dependsOn` edge — never an
 * inferred cause.
 */
export function blockerFacts(ledger: Pick<PreviewLedger, 'tasks'>): readonly string[] {
  const blockedIds = new Set(blockedTasks(ledger).map((task) => task.id));
  const facts: string[] = [];

  for (const task of blockedTasks(ledger)) {
    if (task.gate !== null) {
      facts.push(`${task.id} registers the execution gate “${task.gate}”.`);
    }
  }

  for (const task of sortTasks(ledger.tasks)) {
    if (task.status === 'completed') continue;
    for (const dependency of task.dependsOn) {
      if (!blockedIds.has(dependency)) continue;
      const fact = `${task.id} depends on ${dependency}, which is blocked.`;
      if (!facts.includes(fact)) facts.push(fact);
    }
  }

  return facts;
}

export function parseFilter(value: string | string[] | undefined): PreviewFilter {
  const raw = Array.isArray(value) ? value[0] : value;
  if (raw === 'completed' || raw === 'blocked' || raw === 'planned') return raw;
  return 'all';
}

export function filterTasks(
  tasks: readonly PreviewTask[],
  filter: PreviewFilter,
): readonly PreviewTask[] {
  if (filter === 'all') return tasks;
  return tasks.filter((task) => task.status === filter);
}

/** Abbreviated commit for display; the full value stays in the ledger and the `title`. */
export function shortCommit(head: string): string {
  return head.length > 7 ? head.slice(0, 7) : head;
}

/** ISO string → `YYYY-MM-DD HH:MM:SSZ`, or `—`. Never a locale-dependent format. */
export function formatUtc(iso: string): string {
  if (iso.length === 0) return '—';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '—';
  return `${parsed.toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')}`;
}

/* ---------------------------------------------------------------------------
 * Filesystem
 * ------------------------------------------------------------------------- */

/**
 * Walks up from `start` until the ledger exists. `next dev` and `next start`
 * both run with `apps/web` as cwd, so the monorepo root is two levels up — but
 * it is located by evidence, not by counting `..` segments.
 */
export function findRepoRoot(start: string): string | null {
  let current = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(current, LEDGER_RELATIVE_PATH))) return current;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Reads and parses the ledger. Errors name the repo-relative path only:
 * an absolute path on this host is a filesystem disclosure the page does not
 * need, and the operator cannot act on it through a phone anyway.
 */
export async function readLedger(start: string = process.cwd()): Promise<LedgerParseResult> {
  const root = findRepoRoot(start);
  if (root === null) {
    return {
      ok: false,
      error: `The programme ledger was not found. The preview looked for ${LEDGER_RELATIVE_PATH} in the web app's working directory and its parents.`,
    };
  }

  try {
    const raw = await readFile(path.join(root, LEDGER_RELATIVE_PATH), 'utf8');
    return parseLedger(raw);
  } catch {
    return { ok: false, error: `The programme ledger could not be read from ${LEDGER_RELATIVE_PATH}.` };
  }
}

/**
 * `GET /health/ready`, from the server.
 *
 * No answer within two seconds is `unavailable` — not "healthy because it
 * usually is". Redis and the worker are absent from this endpoint and are
 * labelled as unchecked by the page, not inferred here.
 */
export async function readReadiness(checkedAt: string): Promise<PreviewHealth> {
  try {
    const response = await fetch(READINESS_URL, {
      cache: 'no-store',
      signal: AbortSignal.timeout(READINESS_TIMEOUT_MS),
      headers: { accept: 'application/json' },
    });

    const payload: unknown = await response.json().catch(() => null);
    if (payload === null) {
      return unavailableHealth(checkedAt, 'the readiness response was not JSON');
    }

    return { ...parseReadiness(payload), checkedAt };
  } catch (error) {
    const timedOut =
      error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    return unavailableHealth(
      checkedAt,
      timedOut
        ? `no answer within ${READINESS_TIMEOUT_MS} ms`
        : 'the readiness endpoint could not be reached',
    );
  }
}

const DEPENDENCY_NAMES = ['postgres', 'temporal'] as const;

function unavailableHealth(checkedAt: string, note: string): PreviewHealth {
  return {
    api: 'unavailable',
    dependencies: DEPENDENCY_NAMES.map((name) => ({
      name,
      status: 'unavailable' as const,
      latencyMs: null,
    })),
    checkedAt,
    note,
  };
}

/**
 * Reads the documented readiness document: `{ status, checks: { <name>:
 * { status, latencyMs } } }`. A payload that does not match is `unavailable` —
 * an unparseable answer is not evidence of health.
 */
export function parseReadiness(payload: unknown): Omit<PreviewHealth, 'checkedAt'> {
  const root = asRecord(payload);
  const checks = asRecord(root?.['checks']);
  if (root === null || checks === null) {
    return {
      api: 'unavailable',
      dependencies: DEPENDENCY_NAMES.map((name) => ({
        name,
        status: 'unavailable' as const,
        latencyMs: null,
      })),
      note: 'the readiness response did not match the documented shape',
    };
  }

  const rawStatus = nonEmpty(asString(root['status']));
  if (rawStatus !== 'ready' && rawStatus !== 'not_ready') {
    return {
      api: 'unavailable',
      dependencies: DEPENDENCY_NAMES.map((name) => ({
        name,
        status: 'unavailable' as const,
        latencyMs: null,
      })),
      note: 'the readiness response carried no recognised status',
    };
  }

  const dependencies = DEPENDENCY_NAMES.map((name): PreviewDependencyHealth => {
    const check = asRecord(checks[name]);
    const status = nonEmpty(asString(check?.['status']));
    const latency = check?.['latencyMs'];
    return {
      name,
      status: status === 'up' ? 'up' : status === 'down' ? 'down' : 'not reported',
      latencyMs: typeof latency === 'number' && Number.isFinite(latency) ? latency : null,
    };
  });

  return { api: rawStatus, dependencies, note: null };
}

/** The page's single entry point: ledger and readiness are read concurrently. */
export async function loadPreviewData(start: string = process.cwd()): Promise<PreviewData> {
  const snapshotAt = new Date().toISOString();
  const [ledger, health] = await Promise.all([readLedger(start), readReadiness(snapshotAt)]);
  return { snapshotAt, ledger, health };
}
