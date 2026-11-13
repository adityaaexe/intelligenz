import Link from 'next/link';

import { Button, Panel, SkeletonStack } from '@intelligenz/design-system';

import type { ApiError } from '../../lib/api';
import { moduleHref } from '../../lib/nav';

/**
 * The states of this screen that are not the ledger: no scope, loading, and a
 * history read that failed.
 *
 * Each one says what is absent and why, and offers the one action that changes
 * it. None of them substitutes a zero, a placeholder row, or a cached value —
 * the whole point of the ledger is that every figure on it was measured.
 */

/** The workspace slug in the URL is not one of the caller's memberships. */
export function WorkspaceUnavailable({ workspace }: { readonly workspace: string }) {
  return (
    <div className="ex-stack">
      <Panel title="This workspace is not available to your account">
        <p className="iz-empty__body">
          <span className="iz-mono">{workspace}</span> is not one of the workspaces your memberships
          include. Nothing was requested, and no execution history is shown.
        </p>
        <p className="iz-empty__body">
          <Link className="iz-link" href={moduleHref(workspace, 'overview')}>
            Back to Overview
          </Link>
        </p>
      </Panel>
    </div>
  );
}

/** Two skeletons, not a centred spinner: the shape of what is coming. */
export function ExecutionSkeleton() {
  return (
    <div className="ex-stack" aria-busy="true">
      <div className="ex-skeleton">
        <SkeletonStack rows={2} rowHeight={16} label="Loading task state" />
      </div>
      <div className="ex-skeleton">
        <SkeletonStack rows={4} rowHeight={22} label="Loading execution history" />
      </div>
    </div>
  );
}

/**
 * `404` is the same answer for "absent" and "another tenant's record", so the two
 * cannot be told apart here either — and the page says so instead of guessing.
 */
export function TaskNotFound({
  workspace,
  taskId,
}: {
  readonly workspace: string;
  readonly taskId: string;
}) {
  return (
    <div className="ex-stack">
      <Panel
        title="This task is not in this organisation"
        meta={
          <span className="iz-mono ex-kv__id" title={taskId}>
            {taskId}
          </span>
        }
      >
        <p className="iz-empty__body">
          The API answers 404 for a task that does not exist and for a task belonging to another
          organisation, so the two cannot be told apart. Nothing is shown, and no execution history
          was requested.
        </p>
        <p className="iz-empty__body">
          <Link className="iz-link" href={moduleHref(workspace, 'overview')}>
            Back to Overview
          </Link>
        </p>
      </Panel>
    </div>
  );
}

/**
 * The attempt list failed. It gets its own retry because the task read and the
 * list read fail independently: a broken list must not blank the header, and a
 * broken header must not blank the list.
 */
export function ExecutionsRegionError({
  error,
  onRetry,
}: {
  readonly error: ApiError | null;
  readonly onRetry: () => void;
}) {
  return (
    <div className="ex-region-error">
      <h3 className="iz-empty__title">Execution history could not be read.</h3>
      <p className="iz-empty__body">
        {error?.message ?? 'The list request failed.'}
        {error?.correlationId != null ? (
          <>
            {' '}
            <span className="iz-mono">Correlation {error.correlationId}</span>
          </>
        ) : null}
      </p>
      {error !== null ? (
        <p className="iz-field__hint">
          Code <span className="iz-mono">{error.code}</span> · HTTP {error.status}
        </p>
      ) : null}
      <div className="iz-empty__actions">
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
