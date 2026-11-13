'use client';

import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Banner, Button, Panel, SkeletonStack, SkeletonTable, formatAbsoluteUtc } from '@intelligenz/design-system';

import { ApiClient } from '../../lib/api';
import type { ApiError } from '../../lib/api';
import { moduleHref } from '../../lib/nav';
import type { OverviewSnapshot } from '../../lib/overview';
import { loadOverview } from '../../lib/overview';
import { clearSession, readSession, resolveScope, sessionExpired } from '../../lib/session';
import { AgentActivity } from './agent-activity';
import { AwaitingApprovals } from './awaiting-approvals';
import { CriticalAlerts } from './critical-alerts';
import { ConstraintsLine, PostureStrip } from './posture-strip';
import { SystemHealth } from './system-health';
import { TaskQueues } from './task-queues';
import { UsageCost } from './usage-cost';
import { ActiveWorkflowsRegion, RecentDecisionsRegion } from './uninstrumented-regions';

/**
 * Overview — the only screen with behaviour in Phase 2.
 *
 * Why this is a client component (and not an RSC fetch): the access token lives
 * in this tab, not in a cookie the server could read (`lib/session.ts` explains
 * why), so every authenticated read has to happen where the token is. RSC still
 * owns the route, the metadata and the shell; the data pass is client-side.
 *
 * Regions fail independently. A region that has no source says `Not instrumented`;
 * a region whose read failed says what failed with its correlation id and a
 * retry. Nothing on this page is a fixture.
 */

type ScreenState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly snapshot: OverviewSnapshot; readonly workspaceName: string }
  | { readonly status: 'no-scope' };

export function OverviewScreen({ workspace }: { readonly workspace: string }) {
  const router = useRouter();
  const [state, setState] = useState<ScreenState>({ status: 'loading' });
  const [refreshing, setRefreshing] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const inFlight = useRef(false);

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
        router.replace(`/login?next=${encodeURIComponent(`/${workspace}/overview`)}`);
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
          router.replace(`/login?next=${encodeURIComponent(`/${workspace}/overview`)}`);
        },
      });

      const snapshot = await loadOverview({
        client,
        orgId: scope.membership.orgId,
        workspaceId: scope.workspace.id,
      });

      setState({ status: 'ready', snapshot, workspaceName: scope.workspace.name });
      setRefreshing(false);
      inFlight.current = false;
      setAnnouncement(
        `Data refreshed at ${formatAbsoluteUtc(new Date(snapshot.fetchedAt).toISOString())}.`,
      );
    },
    [router, workspace],
  );

  useEffect(() => {
    void load(true);
  }, [load]);

  const refresh = useCallback(() => {
    void load(false);
  }, [load]);

  if (state.status === 'no-scope') {
    const session = readSession();
    const available = session?.memberships.flatMap((membership) => membership.workspaces) ?? [];
    return (
      <>
        <PageHeader workspaceName={null} fetchedAt={null} refreshing={false} onRefresh={refresh} />
        <div className="ov-grid" style={{ marginTop: 'var(--iz-space-16)' }}>
          <div className="ov-grid__full">
            <Panel title="This workspace is not available to your account">
              <p className="iz-empty__body">
                <span className="iz-mono">{workspace}</span> is not one of the workspaces your
                memberships include. Nothing was requested, and no data is shown.
              </p>
              {available.length > 0 ? (
                <ul className="iz-empty__body" style={{ paddingLeft: 'var(--iz-space-16)' }}>
                  {available.map((entry) => (
                    <li key={entry.id}>
                      <a className="iz-link" href={moduleHref(entry.slug, 'overview')}>
                        {entry.name}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="iz-empty__body">Your account has no workspace membership.</p>
              )}
            </Panel>
          </div>
        </div>
      </>
    );
  }

  if (state.status === 'loading') {
    return (
      <>
        <PageHeader workspaceName={null} fetchedAt={null} refreshing onRefresh={refresh} />
        <div className="iz-hairlines ov-posture" aria-busy="true">
          {Array.from({ length: 5 }, (_, index) => (
            <div key={index} style={{ padding: 'var(--iz-space-12) var(--iz-space-16)' }}>
              <SkeletonStack rows={3} rowHeight={index === 0 ? 20 : 14} label="Loading posture" />
            </div>
          ))}
        </div>
        <div className="ov-grid">
          <div className="ov-grid__full" style={{ padding: 'var(--iz-space-16)' }}>
            <SkeletonStack rows={3} rowHeight={16} label="Loading system health" />
          </div>
          <div className="ov-grid__two">
            <SkeletonTable rows={8} columns={4} />
          </div>
          <div style={{ padding: 'var(--iz-space-16)' }}>
            <SkeletonStack rows={5} rowHeight={24} label="Loading approvals" />
          </div>
        </div>
      </>
    );
  }

  const { snapshot, workspaceName } = state;
  const errors: ApiError[] = [];
  for (const region of [
    snapshot.health,
    snapshot.approvals,
    snapshot.projects,
    snapshot.tasks,
    snapshot.agentRuns,
  ]) {
    if (!region.ok) {
      errors.push(region.error);
    }
  }
  const forbidden = errors.find((error) => error.isForbidden);
  const unreachable = errors.find((error) => error.isNetwork);
  const degraded =
    snapshot.health.ok && snapshot.health.value.status !== 'ready'
      ? Object.entries(snapshot.health.value.checks)
          .filter(([, check]) => check.status !== 'up')
          .map(([name, check]) => ({ name, detail: check.detail ?? 'not up' }))
      : [];

  return (
    <>
      <PageHeader
        workspaceName={workspaceName}
        fetchedAt={snapshot.fetchedAt}
        refreshing={refreshing}
        onRefresh={refresh}
      />

      {unreachable !== undefined ? (
        <div className="mt-12">
          <Banner variant="offline" title="The API could not be reached." announce>
            No value on this page is live and nothing is served from a cache. Every region below
            shows what it could not read, and Retry re-runs the whole refresh.
          </Banner>
        </div>
      ) : null}

      {degraded.length > 0 ? (
        <div className="mt-12">
          <Banner variant="degraded" title="The API reports itself not ready." announce>
            {degraded.map((entry) => `${entry.name} (${entry.detail})`).join(', ')} did not answer
            up. Reads that depend on them may fail; nothing is silently retried.
          </Banner>
        </div>
      ) : null}

      {forbidden !== undefined ? (
        <div className="mt-12">
          <Banner variant="permission" title="Your role does not permit this read.">
            {forbidden.message} Nothing was returned for the affected regions. Ask an owner of this
            organisation to raise your role.
          </Banner>
        </div>
      ) : null}

      <PostureStrip snapshot={snapshot} />
      <ConstraintsLine />

      <div className="ov-grid">
        <div className="ov-grid__full">
          <SystemHealth snapshot={snapshot} onRetry={refresh} />
        </div>
        <div className="ov-grid__two">
          <TaskQueues snapshot={snapshot} workspace={workspace} onRetry={refresh} />
        </div>
        <AwaitingApprovals snapshot={snapshot} onRetry={refresh} />
        <UsageCost snapshot={snapshot} onRetry={refresh} />
        <AgentActivity snapshot={snapshot} onRetry={refresh} />
        <CriticalAlerts snapshot={snapshot} onRetry={refresh} />
        <div className="ov-grid__two">
          <ActiveWorkflowsRegion />
        </div>
        <RecentDecisionsRegion />
      </div>

      <p className="iz-sr-only" role="status" aria-live="polite">
        {announcement}
      </p>

    </>
  );
}

function PageHeader({
  workspaceName,
  fetchedAt,
  refreshing,
  onRefresh,
}: {
  readonly workspaceName: string | null;
  readonly fetchedAt: number | null;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const iso = fetchedAt === null ? null : new Date(fetchedAt).toISOString();
  return (
    <header className="app-page-header">
      <div className="app-page-header__text">
        <h1 className="app-page-title">Overview</h1>
        <p className="app-page-subtitle">
          {workspaceName ?? '—'} › all projects › all environments
        </p>
      </div>
      <div className="app-page-actions">
        {iso !== null ? (
          <span className="app-asof">
            Data as of <time dateTime={iso}>{formatAbsoluteUtc(iso)}</time>
          </span>
        ) : (
          <span className="app-asof">Reading…</span>
        )}
        <Button size="sm" onClick={onRefresh} loading={refreshing}>
          Refresh
        </Button>
      </div>
    </header>
  );
}
