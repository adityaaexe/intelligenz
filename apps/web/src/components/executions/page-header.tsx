import Link from 'next/link';

import { Button, formatAbsoluteUtc } from '@intelligenz/design-system';

import { moduleHref } from '../../lib/nav';

/**
 * The screen header for the execution detail route.
 *
 * One `<h1>` per screen (DESIGN.md §12.2), and it is the task's own title once
 * the task read lands — not a generic label — so the browser tab, the heading and
 * the breadcrumb all name the same object. While loading (or when the task cannot
 * be read) the generic label is the honest substitute.
 *
 * `readState` exists because "Data as of HH:MM" is a claim that data was read.
 * When every read failed, or no read was attempted (the URL names a workspace the
 * caller has no membership for), the header says that instead of stamping a time
 * on nothing.
 */
export type HeaderReadState = 'loading' | 'ok' | 'failed' | 'not-requested';

export function ExecutionPageHeader({
  workspace,
  workspaceName,
  taskTitle,
  readAt,
  readState,
  refreshing,
  onRefresh,
}: {
  readonly workspace: string;
  readonly workspaceName: string | null;
  readonly taskTitle: string | null;
  readonly readAt: number | null;
  readonly readState: HeaderReadState;
  readonly refreshing: boolean;
  readonly onRefresh: () => void;
}) {
  const iso = readAt === null ? null : new Date(readAt).toISOString();
  return (
    <header className="app-page-header">
      <div className="app-page-header__text">
        <h1 className="app-page-title">{taskTitle ?? 'Execution detail'}</h1>
        <p className="app-page-subtitle">
          Execution history · {workspaceName ?? workspace} ›{' '}
          <Link className="iz-link" href={moduleHref(workspace, 'overview')}>
            Overview
          </Link>
        </p>
      </div>
      <div className="app-page-actions">
        {iso !== null && readState === 'ok' ? (
          <span className="app-asof">
            Data as of <time dateTime={iso}>{formatAbsoluteUtc(iso)}</time>
          </span>
        ) : (
          <span className="app-asof">{READ_LABELS[readState]}</span>
        )}
        <Button size="sm" onClick={onRefresh} loading={refreshing}>
          Refresh
        </Button>
      </div>
    </header>
  );
}

const READ_LABELS: Readonly<Record<HeaderReadState, string>> = {
  loading: 'Reading…',
  ok: 'Reading…',
  failed: 'Read failed',
  'not-requested': 'Not requested',
};
