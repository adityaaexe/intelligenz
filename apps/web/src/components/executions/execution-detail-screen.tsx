'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  Banner,
  EmptyState,
  Panel,
  formatAbsoluteUtc,
  formatCount,
} from '@intelligenz/design-system';

import { ApiClient } from '../../lib/api';
import type { ApiError } from '../../lib/api';
import type { ArtifactDownload } from '../../lib/api';
import { defaultAttemptId, loadAttemptDetail, loadExecutionHistory } from '../../lib/executions';
import type { ExecutionHistory } from '../../lib/executions';
import { clearSession, readSession, resolveScope, sessionExpired } from '../../lib/session';
import type { ResolvedScope } from '../../lib/session';
import type { ExecutionAttemptDetail } from '../../lib/types';
import { AttemptDetail } from './attempt-detail';
import { ExecutionPageHeader } from './page-header';
import {
  ExecutionSkeleton,
  ExecutionsRegionError,
  TaskNotFound,
  WorkspaceUnavailable,
} from './screen-states';
import { TaskStrip } from './task-strip';
import { AttemptTable } from './attempt-table';

/**
 * The execution detail route — `/[workspace]/tasks/[taskId]`.
 *
 * Why a client component: the access token lives in this tab (`lib/session.ts`),
 * so every authenticated read has to happen where the token is. The RSC owns the
 * route and the metadata; the data pass is client-side, exactly as on the
 * Overview.
 *
 * What this screen refuses to do:
 * - show a progress bar for a running attempt (no step total is reported, so a
 *   percentage would be invented);
 * - show a cost that the provider did not report;
 * - keep a previous snapshot on screen when a refresh fails;
 * - label a row from anything other than the adapter's `simulated` field.
 */

const DETAIL_ID = 'attempt-detail';

type HistoryState =
  | { readonly status: 'loading' }
  | { readonly status: 'no-scope' }
  | {
      readonly status: 'ready';
      readonly history: ExecutionHistory;
      readonly readAt: number;
      readonly scope: ResolvedScope;
    };

type DetailState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading'; readonly attemptId: string }
  | { readonly status: 'ready'; readonly attemptId: string; readonly detail: ExecutionAttemptDetail }
  | { readonly status: 'failed'; readonly attemptId: string; readonly error: ApiError };

export function ExecutionDetailScreen({
  workspace,
  taskId,
}: {
  readonly workspace: string;
  readonly taskId: string;
}) {
  const router = useRouter();
  const [state, setState] = useState<HistoryState>({ status: 'loading' });
  const [detailState, setDetailState] = useState<DetailState>({ status: 'idle' });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [now, setNow] = useState<number>(() => Date.now());
  // Bumped by the detail panel's Retry: the selected attempt does not change, so
  // the effect needs a second reason to re-run.
  const [detailNonce, setDetailNonce] = useState(0);
  const loadSeq = useRef(0);
  const inFlight = useRef(false);
  const redirectTo = `/${workspace}/tasks/${taskId}`;

  const load = useCallback(
    async (initial: boolean) => {
      if (inFlight.current) {
        return;
      }
      inFlight.current = true;
      if (!initial) {
        setRefreshing(true);
      }

      const session = readSession();
      if (session === null || sessionExpired(session)) {
        clearSession();
        router.replace(`/login?next=${encodeURIComponent(redirectTo)}`);
        inFlight.current = false;
        return;
      }
      const scope = resolveScope(session, workspace);
      if (scope === null) {
        setState({ status: 'no-scope' });
        setRefreshing(false);
        inFlight.current = false;
        return;
      }

      const client = new ApiClient({
        getToken: () => readSession()?.accessToken ?? null,
        getOrgId: () => scope.membership.orgId,
        onUnauthorized: () => {
          clearSession();
          router.replace(`/login?next=${encodeURIComponent(redirectTo)}`);
        },
      });

      loadSeq.current += 1;
      const history = await loadExecutionHistory({
        client,
        orgId: scope.membership.orgId,
        taskId,
      });

      setState({ status: 'ready', history, readAt: Date.now(), scope });
      setRefreshing(false);
      inFlight.current = false;
      setAnnouncement(`Execution history refreshed at ${formatAbsoluteUtc(new Date().toISOString())}.`);
    },
    [redirectTo, router, taskId, workspace],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const refresh = useCallback(() => {
    void load(false);
  }, [load]);

  const attempts = state.status === 'ready' && state.history.attempts.ok ? state.history.attempts.value : [];
  const effectiveSelectedId =
    selectedId !== null && attempts.some((attempt) => attempt.id === selectedId)
      ? selectedId
      : defaultAttemptId(attempts);

  // One detail read per selected attempt. The sequence guard stops a slow earlier
  // response from overwriting a newer selection — a race that would silently show
  // attempt 1 under the heading for attempt 2.
  const detailSeq = useRef(0);
  useEffect(() => {
    if (state.status !== 'ready' || effectiveSelectedId === null) {
      setDetailState({ status: 'idle' });
      return;
    }
    const orgId = state.scope.membership.orgId;
    const client = new ApiClient({
      getToken: () => readSession()?.accessToken ?? null,
      getOrgId: () => orgId,
    });
    detailSeq.current += 1;
    const seq = detailSeq.current;
    setDetailState({ status: 'loading', attemptId: effectiveSelectedId });

    void loadAttemptDetail({ client, orgId, taskId, attemptId: effectiveSelectedId }).then((result) => {
      if (detailSeq.current !== seq) {
        return;
      }
      setDetailState(
        result.ok
          ? { status: 'ready', attemptId: effectiveSelectedId, detail: result.value }
          : { status: 'failed', attemptId: effectiveSelectedId, error: result.error },
      );
    });
  }, [effectiveSelectedId, state, taskId, detailNonce]);

  // The clock only ticks while an attempt is open, and it only drives measured
  // elapsed time. There is no percentage to animate.
  const hasOpenAttempt = attempts.some(
    (attempt) => attempt.startedAt !== null && attempt.finishedAt === null,
  );
  useEffect(() => {
    if (!hasOpenAttempt) {
      return;
    }
    const handle = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(handle);
  }, [hasOpenAttempt]);

  const download = useCallback(
    async (artifactId: string): Promise<ArtifactDownload> => {
      if (state.status !== 'ready') {
        throw new Error('The scope is not resolved; no download can be authorised.');
      }
      const orgId = state.scope.membership.orgId;
      const client = new ApiClient({
        getToken: () => readSession()?.accessToken ?? null,
        getOrgId: () => orgId,
        onUnauthorized: () => {
          clearSession();
          router.replace(`/login?next=${encodeURIComponent(redirectTo)}`);
        },
      });
      return client.artifactContent(orgId, artifactId);
    },
    [redirectTo, router, state],
  );

  if (state.status === 'no-scope') {
    return (
      <>
        <ExecutionPageHeader
          workspace={workspace}
          workspaceName={null}
          taskTitle={null}
          readAt={null}
          readState="not-requested"
          refreshing={false}
          onRefresh={refresh}
        />
        <WorkspaceUnavailable workspace={workspace} />
      </>
    );
  }

  if (state.status === 'loading') {
    return (
      <>
        <ExecutionPageHeader
          workspace={workspace}
          workspaceName={null}
          taskTitle={null}
          readAt={null}
          readState="loading"
          refreshing
          onRefresh={refresh}
        />
        <ExecutionSkeleton />
      </>
    );
  }

  const { history, readAt, scope } = state;
  const taskError = history.task.ok ? null : history.task.error;
  const attemptsError = history.attempts.ok ? null : history.attempts.error;
  const errors: ApiError[] = [];
  if (taskError !== null) {
    errors.push(taskError);
  }
  if (attemptsError !== null) {
    errors.push(attemptsError);
  }
  const unreachable = errors.find((error) => error.isNetwork);
  const forbidden = errors.find((error) => error.isForbidden);
  const taskMissing = taskError?.code === 'NOT_FOUND';
  const task = history.task.ok ? history.task.value : null;
  // `idle` with a selection is the frame between "history arrived" and "detail
  // effect ran". It is loading, not "no attempt" — the panel must not flash an
  // error it has not observed.
  const detailLoading =
    detailState.status === 'loading' ||
    (detailState.status === 'idle' && effectiveSelectedId !== null);
  // "Data as of" is a claim that something was read. With both reads failed the
  // header says so rather than stamping a timestamp on an empty page.
  const anyDataRead = history.task.ok || history.attempts.ok;

  return (
    <>
      <ExecutionPageHeader
        workspace={workspace}
        workspaceName={scope.workspace.name}
        taskTitle={task?.title ?? null}
        readAt={readAt}
        readState={anyDataRead ? 'ok' : 'failed'}
        refreshing={refreshing}
        onRefresh={refresh}
      />

      {unreachable !== undefined ? (
        <div className="mt-12">
          <Banner variant="offline" title="The API could not be reached." announce>
            Nothing on this page is live and no value is served from a cache. The regions below
            state what they could not read; Retry re-runs both reads.
          </Banner>
        </div>
      ) : null}

      {forbidden !== undefined ? (
        <div className="mt-12">
          <Banner variant="permission" title="Your role does not permit this read.">
            {forbidden.message} A VIEWER may read execution history in this product, so this is a
            membership problem rather than a role one. Ask an owner of this organisation.
          </Banner>
        </div>
      ) : null}

      {taskMissing ? (
        <TaskNotFound workspace={workspace} taskId={taskId} />
      ) : (
        <>
          {task !== null ? (
            <TaskStrip task={task} readAt={readAt} />
          ) : (
            <div className="mt-12">
              <Panel title="Task state could not be read">
                <p className="iz-empty__body">
                  {taskError?.message ?? 'The task read failed.'} Execution history is a separate
                  read, and its state is reported below — the two do not share a failure.
                </p>
              </Panel>
            </div>
          )}

          <div className="ex-stack">
            <Panel
              title="Executions"
              meta={
                history.attempts.ok && history.attempts.value.length > 0 ? (
                  <span className="iz-num">
                    {formatCount(history.attempts.value.length)} attempt
                    {history.attempts.value.length === 1 ? '' : 's'}
                  </span>
                ) : null
              }
              note={
                <>
                  One row per attempt, newest first. An attempt is the unit, so a Temporal retry is
                  addressable as <span className="iz-mono">#2</span> without reading timestamps.
                  Provenance comes from the adapter&rsquo;s own <span className="iz-mono">simulated</span>{' '}
                  field — never from the runtime id.
                </>
              }
              flush
            >
              {history.attempts.ok ? (
                history.attempts.value.length === 0 ? (
                  <EmptyState
                    title="No attempt has been recorded"
                    description={
                      <>
                        This task has never been run, or its history was removed. An attempt appears
                        when a workflow reaches the execution activity and reports a result. Nothing
                        is shown as <span className="iz-mono">0</span>, because nothing has been
                        measured. Use <span className="iz-mono">POST /run</span> on the task to
                        start one.
                      </>
                    }
                  />
                ) : (
                  <AttemptTable
                    attempts={history.attempts.value}
                    selectedId={effectiveSelectedId}
                    onSelect={setSelectedId}
                    now={now}
                    detailId={DETAIL_ID}
                  />
                )
              ) : (
                <ExecutionsRegionError error={attemptsError} onRetry={refresh} />
              )}
            </Panel>

            {effectiveSelectedId !== null ? (
              <AttemptDetail
                id={DETAIL_ID}
                detail={detailState.status === 'ready' ? detailState.detail : null}
                loading={detailLoading}
                error={detailState.status === 'failed' ? detailState.error : null}
                now={now}
                onRetry={() => setDetailNonce((nonce) => nonce + 1)}
                onDownload={download}
              />
            ) : null}
          </div>

          <p className="iz-sr-only" role="status" aria-live="polite">
            {announcement}
          </p>
        </>
      )}
    </>
  );
}
