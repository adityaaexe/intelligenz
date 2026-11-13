import { formatAbsoluteUtc } from '@intelligenz/design-system';

import { shortCommit, workspaceStateLabel } from '../../lib/execution-state';
import { NotReported } from './a11y-values';
import type { ExecutionWorkspace } from '../../lib/types';

/**
 * The filesystem boundary this attempt ran inside, as the API describes it.
 *
 * `rootPath` is deliberately absent from the wire contract ("a host path names a
 * filesystem layout that the caller has no business knowing"), so it is absent
 * here too. `workspace.id` is the handle; the commit and branch are the
 * reproducibility facts an operator actually needs.
 *
 * `null` is a fact, not a gap: a simulated run has no filesystem boundary, and an
 * attempt that failed before provisioning also has none. It is stated in words
 * rather than rendered as a row of dashes.
 */
export function WorkspacePanel({ workspace }: { readonly workspace: ExecutionWorkspace | null }) {
  if (workspace === null) {
    return (
      <div className="ex-workspace-empty">
        <p className="ex-workspace-empty__title">No workspace was provisioned.</p>
        <p className="ex-workspace-empty__body">
          A simulated run has no filesystem boundary, and an attempt that failed before the
          workspace was created has none either. Nothing is shown as a blank value because there is
          no workspace to describe.
        </p>
      </div>
    );
  }

  const commit = shortCommit(workspace.baseCommit);

  return (
    <dl className="ex-kv">
      <div className="ex-kv__row">
        <dt>Workspace state</dt>
        <dd>{workspaceStateLabel(workspace.state)}</dd>
      </div>
      <div className="ex-kv__row">
        <dt>Source</dt>
        <dd>
          <span className="iz-mono">{workspace.sourceKind}</span>
        </dd>
      </div>
      <div className="ex-kv__row">
        <dt>Base commit</dt>
        <dd>
          {commit === null ? (
            <NotReported />
          ) : (
            <span className="iz-mono" title={workspace.baseCommit ?? undefined}>
              {commit}
            </span>
          )}
        </dd>
      </div>
      <div className="ex-kv__row">
        <dt>Branch</dt>
        <dd>
          {workspace.branch === null ? (
            <NotReported />
          ) : (
            <span className="iz-mono">{workspace.branch}</span>
          )}
        </dd>
      </div>
      <div className="ex-kv__row">
        <dt>Ready</dt>
        <dd>
          {workspace.readyAt === null ? (
            <NotReported />
          ) : (
            <time dateTime={workspace.readyAt} title={formatAbsoluteUtc(workspace.readyAt)}>
              {formatAbsoluteUtc(workspace.readyAt)}
            </time>
          )}
        </dd>
      </div>
      <div className="ex-kv__row">
        <dt>Cleaned</dt>
        <dd>
          {workspace.cleanedAt === null ? (
            <span className="ex-muted">
              Not yet cleaned
            </span>
          ) : (
            <time dateTime={workspace.cleanedAt} title={formatAbsoluteUtc(workspace.cleanedAt)}>
              {formatAbsoluteUtc(workspace.cleanedAt)}
            </time>
          )}
        </dd>
      </div>
      <div className="ex-kv__row">
        <dt>Workspace id</dt>
        <dd>
          <span className="iz-mono ex-kv__id">{workspace.id}</span>
        </dd>
      </div>
    </dl>
  );
}
