import { formatCost } from '@intelligenz/design-system';
import type { IconName, StatusTone } from '@intelligenz/design-system';

import type {
  ArtifactIntegrity,
  ExecutionAttempt,
  ExecutionWorkspaceState,
  RunStatus,
  TaskDetail,
} from './types';

/**
 * The execution state vocabulary — pure mappings, no DOM, unit-tested.
 *
 * `api-contract.md` §Executions states the rule this module exists to make
 * unbreakable:
 *
 *   > `simulated` is **required** and comes from the adapter's own report. `false`
 *   > means a real model call happened. The UI must label every row from this
 *   > field; **never infer it from `runtimeId`.**
 *
 * So provenance is a function of exactly one field. There is no fallback, no
 * "looks like a simulated runtime so probably simulated", and no default. A
 * caller cannot render a badge without a `Provenance` value, and the only way to
 * obtain one is `provenanceOf()`, which reads `simulated`.
 *
 * Two dimensions stay orthogonal on purpose:
 *
 * | dimension | question | values |
 * |---|---|---|
 * | provenance | did a model really run? | `live` · `simulated` |
 * | state | where did the attempt get to? | queued · executing · completed · failed · cancelled |
 *
 * A simulated attempt can complete. A live attempt can fail. Collapsing the two
 * into one badge is how a demo starts claiming a real run.
 */

export type Provenance = 'live' | 'simulated';

/** A glyph + word + tone triple. Colour is the third channel, never the only one. */
export interface StateDescriptor {
  readonly tone: StatusTone;
  readonly glyph: IconName;
  /** The visible word. Always present; never rendered without its glyph. */
  readonly label: string;
  /** Spoken prefix so a screen reader hears the dimension, not a bare word. */
  readonly srPrefix: string;
}

/* ---------------------------------------------------------------------------
 * Provenance — from `simulated`, nothing else
 * ------------------------------------------------------------------------- */

/**
 * The only place provenance is decided.
 *
 * Deliberately *not* `runtimeId`-aware: `local-simulated` reporting
 * `simulated: false` is a bug the operator must see, not a bug this function
 * quietly repairs by "knowing better".
 */
export function provenanceOf(attempt: Pick<ExecutionAttempt, 'simulated'>): Provenance {
  return attempt.simulated === true ? 'simulated' : 'live';
}

const PROVENANCE: Readonly<Record<Provenance, StateDescriptor>> = {
  live: {
    tone: 'active',
    glyph: 'status-active',
    label: 'Live',
    srPrefix: 'Provenance: ',
  },
  simulated: {
    // A flask: the same glyph the product uses for work that was produced, not
    // performed. Neutral tone because `Simulated` is a provenance, not a health
    // state — painting it green would imply the run succeeded, and painting it
    // amber would imply something is wrong.
    tone: 'neutral',
    glyph: 'research',
    label: 'Simulated',
    srPrefix: 'Provenance: ',
  },
};

export function provenanceDescriptor(provenance: Provenance): StateDescriptor {
  return PROVENANCE[provenance];
}

/* ---------------------------------------------------------------------------
 * Run state — `RunStatus` mapped to the product's words
 * ------------------------------------------------------------------------- */

export interface RunStateDescriptor extends StateDescriptor {
  /** True while the attempt has no `finishedAt`: elapsed time is meaningful. */
  readonly open: boolean;
  /** A qualifier that must not replace the state word (`Failed · timed out`). */
  readonly qualifier: string | null;
}

const RUN_STATES: Readonly<Record<RunStatus, Omit<RunStateDescriptor, 'srPrefix'>>> = {
  queued: {
    tone: 'queued',
    glyph: 'status-queued',
    label: 'Queued',
    open: true,
    qualifier: null,
  },
  running: {
    // DESIGN.md §4.4 calls this `Running`; the product vocabulary for an attempt
    // is `Executing`, and an attempt and a task must not read as the same object.
    tone: 'active',
    glyph: 'status-active',
    label: 'Executing',
    open: true,
    qualifier: null,
  },
  succeeded: {
    tone: 'completed',
    glyph: 'status-completed',
    label: 'Completed',
    open: false,
    qualifier: null,
  },
  failed: {
    tone: 'failed',
    glyph: 'status-failed',
    label: 'Failed',
    open: false,
    qualifier: null,
  },
  cancelled: {
    tone: 'offline',
    glyph: 'status-offline',
    label: 'Cancelled',
    open: false,
    qualifier: null,
  },
  // `Timed out` is a secondary state word (DESIGN.md §4.4) that reuses the failed
  // stem. It qualifies `Failed` rather than replacing it, so a scan for failures
  // finds every failure.
  timed_out: {
    tone: 'failed',
    glyph: 'status-failed',
    label: 'Failed',
    open: false,
    qualifier: 'Timed out',
  },
};

export function runStateDescriptor(status: RunStatus): RunStateDescriptor {
  return { ...RUN_STATES[status], srPrefix: 'Status: ' };
}

/* ---------------------------------------------------------------------------
 * Task gate — where `Blocked` and `Waiting for approval` come from
 * ------------------------------------------------------------------------- */

export type TaskGateWord = 'Blocked' | 'Waiting for approval';

export interface TaskGateDescriptor extends StateDescriptor {
  readonly word: TaskGateWord;
  readonly reason: string;
}

/**
 * A task-level state, not an attempt-level one.
 *
 * Precedence matters: a `blocked` task is blocked even when an approval request
 * is also pending, because approving would not unblock it — the task has to be
 * re-opened with a reason (`blocked → ready`). Reporting `Waiting for approval`
 * there would name the wrong action.
 *
 * `Waiting for approval` is otherwise observable rather than guessed: the
 * approval gate (`api-contract.md` §6) creates a PENDING request for every
 * HIGH/CRITICAL task, and such a task cannot be run while one is pending.
 */
export function taskGateState(
  detail: Pick<TaskDetail, 'status' | 'approvals'>,
): TaskGateDescriptor | null {
  const pending = detail.approvals.find((approval) => approval.status === 'PENDING');
  const running = detail.status === 'running' || detail.status === 'queued';

  if (detail.status === 'blocked') {
    return {
      word: 'Blocked',
      tone: 'awaiting',
      glyph: 'status-awaiting',
      label: 'Blocked',
      srPrefix: 'Task state: ',
      reason: 'The task must be re-opened with a reason before it can run again.',
    };
  }

  if (pending !== undefined && !running) {
    return {
      word: 'Waiting for approval',
      tone: 'awaiting',
      // The check-badge glyph, so it is distinguishable from `Blocked` at a
      // glance and in greyscale; both await a human, so both use the awaiting stem.
      glyph: 'approvals',
      label: 'Waiting for approval',
      srPrefix: 'Task state: ',
      reason: 'A run cannot start until this request is approved.',
    };
  }

  return null;
}

/* ---------------------------------------------------------------------------
 * Artifact integrity — computed by the API at read time
 * ------------------------------------------------------------------------- */

export interface IntegrityDescriptor {
  readonly label: string;
  readonly tone: StatusTone;
  readonly glyph: IconName;
  readonly srPrefix: string;
  /** One sentence stating what the label means. Rendered beside `failed`. */
  readonly detail: string;
  /** Failed integrity is loud: tinted row, bold label, warning line. */
  readonly loud: boolean;
}

const INTEGRITY: Readonly<Record<ArtifactIntegrity, IntegrityDescriptor>> = {
  verified: {
    label: 'Verified',
    tone: 'completed',
    glyph: 'status-completed',
    srPrefix: 'Integrity: ',
    detail: 'The bytes on disk match the recorded SHA-256.',
    loud: false,
  },
  failed: {
    label: 'Failed',
    tone: 'failed',
    glyph: 'status-failed',
    srPrefix: 'Integrity: ',
    detail: 'The file no longer matches its checksum. Nothing is served from it.',
    loud: true,
  },
  // The contract is explicit: `unknown` must render as "unverified", never as a
  // pass. A checksum that was not checked is not a checksum that matched.
  unknown: {
    label: 'Unverified',
    tone: 'neutral',
    glyph: 'status-neutral',
    srPrefix: 'Integrity: ',
    detail: 'The file could not be read, so the checksum could not be checked.',
    loud: false,
  },
};

export function integrityDescriptor(integrity: ArtifactIntegrity): IntegrityDescriptor {
  return INTEGRITY[integrity];
}

/* ---------------------------------------------------------------------------
 * Cost — the provider's figure, or nothing
 * ------------------------------------------------------------------------- */

/**
 * `$0.0005` · `$2.14` · `—`.
 *
 * A cost is never estimated. `null` is "the provider did not report one", which
 * is not zero, and a non-numeric string is a contract violation that must not
 * become `$NaN`. Both render `—`, and the caller marks it "Not reported".
 */
export function formatProviderCost(costUsd: string | null | undefined): string {
  if (costUsd === null || costUsd === undefined) {
    return '—';
  }
  const trimmed = costUsd.trim();
  if (trimmed.length === 0) {
    return '—';
  }
  const value = Number.parseFloat(trimmed);
  if (!Number.isFinite(value)) {
    return '—';
  }
  return formatCost(value);
}

/* ---------------------------------------------------------------------------
 * Mismatch warnings — provenance that contradicts the runtime
 * ------------------------------------------------------------------------- */

export type MismatchCode = 'REPORTED_SIMULATION' | 'SIMULATED_RUNTIME_LABELLED_LIVE';

export interface ProvenanceMismatch {
  readonly code: MismatchCode;
  readonly title: string;
  readonly message: string;
  /** Quiet when the adapter said it simulated; loud when a real label is doubtful. */
  readonly loud: boolean;
}

/** Runtime ids that are, by their own adapter, simulation (matches the API's vocabulary). */
const SIMULATED_RUNTIME_IDS: ReadonlySet<string> = new Set(['local-simulated', 'simulated']);

export function isSimulatedRuntimeId(runtimeId: string | null | undefined): boolean {
  if (!runtimeId) {
    return false;
  }
  return SIMULATED_RUNTIME_IDS.has(runtimeId.trim().toLowerCase());
}

/**
 * The two ways the provenance field can disagree with the adapter that produced
 * the attempt. Neither is repaired here — the badge still renders exactly what
 * `simulated` said, and the disagreement is stated beside it.
 *
 * 1. A real runtime reported `simulated: true`. The requirement is explicit:
 *    render `Simulated` and add a quiet warning. The label is what the adapter
 *    claimed; the warning is what an operator needs to file the bug.
 * 2. The simulated adapter reported `simulated: false`. The row would say `Live`
 *    about a run that provably called no model. That label is not trustworthy, so
 *    it gets a louder warning — this is the failure mode ADR-006 exists to catch.
 */
export function provenanceMismatch(
  attempt: Pick<ExecutionAttempt, 'simulated' | 'runtimeId'>,
): ProvenanceMismatch | null {
  const simulated = attempt.simulated === true;
  const simulatedAdapter = isSimulatedRuntimeId(attempt.runtimeId);

  if (simulated && !simulatedAdapter) {
    return {
      code: 'REPORTED_SIMULATION',
      title: 'The runtime reported simulation.',
      message:
        `Attempt reported simulated:true from ${attempt.runtimeId}. ` +
        'It is labelled Simulated, not Live. If a real model call was intended, this is a data defect.',
      loud: false,
    };
  }

  if (!simulated && simulatedAdapter) {
    return {
      code: 'SIMULATED_RUNTIME_LABELLED_LIVE',
      title: 'This attempt is labelled Live but ran on the simulated adapter.',
      message:
        `${attempt.runtimeId} reports simulated:false. The adapter made no model call, so the ` +
        'Live label is not trustworthy. Treat the run as simulated until the adapter is fixed.',
      loud: true,
    };
  }

  return null;
}

/* ---------------------------------------------------------------------------
 * Elapsed time — a measurement, never a progress bar
 * ------------------------------------------------------------------------- */

/**
 * Milliseconds between `startedAt` and `finishedAt` (or `now` while open).
 *
 * Returns `null` rather than `0` when the start is unknown: a duration of zero
 * is a measurement, and inventing one would be a claim.
 */
export function elapsedMs(
  attempt: Pick<ExecutionAttempt, 'startedAt' | 'finishedAt' | 'durationMs'>,
  now: number,
): number | null {
  if (attempt.durationMs !== null) {
    return attempt.durationMs;
  }
  if (attempt.startedAt === null) {
    return null;
  }
  const started = Date.parse(attempt.startedAt);
  if (Number.isNaN(started)) {
    return null;
  }
  const finished = attempt.finishedAt === null ? now : Date.parse(attempt.finishedAt);
  if (Number.isNaN(finished)) {
    return null;
  }
  return Math.max(0, finished - started);
}

/* ---------------------------------------------------------------------------
 * Error text — `ExecutionResult.error` is not a uniform shape
 * ------------------------------------------------------------------------- */

/**
 * The worker persists `ExecutionResult.error` verbatim (contract: `{ code,
 * message, retryable }`), but a pre-dispatch failure can carry anything. This
 * extracts what is readable and says so when it is not — it never stringifies an
 * arbitrary object into the ledger.
 */
export function describeAttemptError(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null;
  }
  if (typeof error === 'string') {
    return error.length > 0 ? error : 'The runtime reported an error with no message.';
  }
  if (typeof error === 'object') {
    const record = error as { readonly code?: unknown; readonly message?: unknown };
    const code = typeof record.code === 'string' ? record.code : null;
    const message = typeof record.message === 'string' ? record.message : null;
    if (code !== null && message !== null) {
      return `${code}: ${message}`;
    }
    if (message !== null) {
      return message;
    }
    if (code !== null) {
      return `${code} (the runtime reported no message).`;
    }
  }
  return 'The runtime reported an error in a shape this client cannot render.';
}

/* ---------------------------------------------------------------------------
 * Workspace state — the storage vocabulary, humanised
 * ------------------------------------------------------------------------- */

const WORKSPACE_STATES: Readonly<Record<ExecutionWorkspaceState, string>> = {
  requested: 'Requested',
  provisioning: 'Provisioning',
  ready: 'Ready',
  executing: 'Executing',
  preserving: 'Preserving artifacts',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function workspaceStateLabel(state: ExecutionWorkspaceState): string {
  return WORKSPACE_STATES[state];
}

/* ---------------------------------------------------------------------------
 * Identity display
 * ------------------------------------------------------------------------- */

/**
 * A commit is an identifier: full value in the detail header, shortened here,
 * with the full value in `title` and the accessible name (DESIGN.md §5.3).
 */
export function shortCommit(commit: string | null): string | null {
  if (commit === null) {
    return null;
  }
  const trimmed = commit.trim();
  if (trimmed.length <= 12) {
    return trimmed;
  }
  return `${trimmed.slice(0, 12)}…`;
}

/** The file name an artifact download is saved as. Derived from the logical uri. */
export function artifactFilename(uri: string, kind: string): string {
  const segments = uri.split('/').filter((segment) => segment.length > 0);
  const last = segments.length > 0 ? (segments[segments.length - 1] ?? '') : '';
  return last.length > 0 ? last : `${kind}.bin`;
}

/**
 * Splits a logical artifact uri into the part that identifies its location and
 * the file name that identifies the artifact.
 *
 * A table cell truncates an identifier from the end (DESIGN.md §5.4 "truncation
 * never removes the prefix"), but for a *path* the only distinguishing characters
 * are at the end: `…/transcript.ndjson` and `…/diff.patch` share a 120-character
 * prefix. Rendering the two parts separately lets the prefix truncate while the
 * file name stays whole, so a column of artifacts is scannable.
 */
export function splitArtifactUri(uri: string): { readonly dir: string; readonly name: string } {
  const trimmed = uri.replace(/^\/+/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut < 0) {
    return { dir: '', name: trimmed };
  }
  return { dir: trimmed.slice(0, cut + 1), name: trimmed.slice(cut + 1) };
}

/**
 * Tool summaries for command-shaped tools render monospace, because a command is
 * an identifier and its output is a log line (DESIGN.md §5.3). A `read` or
 * `edit` summary is prose about an action and stays proportional.
 */
const COMMAND_TOOLS: ReadonlySet<string> = new Set([
  'shell',
  'bash',
  'sh',
  'exec',
  'command',
  'run',
  'terminal',
]);

export function isCommandSummary(tool: string): boolean {
  return COMMAND_TOOLS.has(tool.trim().toLowerCase());
}

/** `14:02:48` in UTC. A trace is an audit surface, so the value is absolute. */
export function clockUtc(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  const pad = (value: number): string => (value < 10 ? `0${value}` : String(value));
  return `${pad(parsed.getUTCHours())}:${pad(parsed.getUTCMinutes())}:${pad(parsed.getUTCSeconds())}`;
}

/** `1.2 kB` · `13.2 kB` · `1.4 MB` — sizes are bytes, never rounded to zero. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }
  if (bytes < 1000) {
    return `${Math.round(bytes)} B`;
  }
  if (bytes < 1_000_000) {
    return `${(bytes / 1000).toFixed(1)} kB`;
  }
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/**
 * Spoken form of a duration (`14m 22s` → "14 minutes 22 seconds"), so the
 * accessible name is not a compact string a screen reader has to guess at
 * (DESIGN.md §12.3). Missing is "Not reported", never "0 seconds".
 */
export function describeDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return 'Not reported';
  }
  if (ms < 1000) {
    return `${Math.round(ms)} milliseconds`;
  }
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const plural = (value: number, unit: string): string =>
    `${value} ${unit}${value === 1 ? '' : 's'}`;
  const parts: string[] = [];
  if (hours > 0) {
    parts.push(plural(hours, 'hour'));
  }
  if (minutes > 0) {
    parts.push(plural(minutes, 'minute'));
  }
  if (seconds > 0 || parts.length === 0) {
    parts.push(plural(seconds, 'second'));
  }
  return parts.join(' ');
}
