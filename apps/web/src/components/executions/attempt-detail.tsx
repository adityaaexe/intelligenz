import {
  Banner,
  Button,
  Icon,
  formatAbsoluteUtc,
  formatCount,
  formatDuration,
  formatTokenCount,
} from '@intelligenz/design-system';

import type { ApiError } from '../../lib/api';
import type { ArtifactDownload } from '../../lib/api';
import {
  describeAttemptError,
  describeDuration,
  elapsedMs,
  formatProviderCost,
  provenanceMismatch,
  provenanceOf,
  runStateDescriptor,
} from '../../lib/execution-state';
import type { ExecutionAttemptDetail } from '../../lib/types';
import { ArtifactTable } from './artifact-table';
import { NotReported, SpokenValue } from './a11y-values';
import { ProvenanceBadge, RunStateBadge } from './execution-badges';
import { ToolTimeline } from './tool-timeline';
import { WorkspacePanel } from './workspace-panel';

/**
 * One attempt, in full: identity, trace, artifacts, workspace.
 *
 * Three honesty rules are implemented here rather than left to a component:
 *
 * 1. **No invented progress.** An open attempt shows elapsed time measured from
 *    `startedAt`. There is no percentage because the API reports no step total,
 *    and a bar that fills on a timer is a fabricated measurement.
 * 2. **Cost is the provider's number or `—`.** No estimate, no arithmetic over
 *    tokens, no "~" prefix.
 * 3. **A provenance mismatch is stated.** The badge renders what `simulated`
 *    said; if that contradicts the adapter id, the contradiction is shown beside
 *    it instead of being silently resolved.
 */
export function AttemptDetail({
  id,
  detail,
  loading,
  error,
  now,
  onRetry,
  onDownload,
}: {
  /** The element the attempt rows disclose — `aria-controls` on each select button. */
  readonly id: string;
  readonly detail: ExecutionAttemptDetail | null;
  readonly loading: boolean;
  readonly error: ApiError | null;
  readonly now: number;
  readonly onRetry: () => void;
  readonly onDownload: (artifactId: string) => Promise<ArtifactDownload>;
}) {
  const headingId = `${id}-heading`;

  if (loading || (detail === null && error === null)) {
    return (
      <section className="ex-detail" id={id} aria-labelledby={headingId} tabIndex={-1}>
        <h2 className="ex-detail__title" id={headingId}>
          Attempt detail
        </h2>
        <p className="ex-detail__body" role="status" aria-live="polite">
          Reading the attempt…
        </p>
      </section>
    );
  }

  if (error !== null || detail === null) {
    return (
      <section className="ex-detail" id={id} aria-labelledby={headingId} tabIndex={-1}>
        <h2 className="ex-detail__title" id={headingId}>
          Attempt detail
        </h2>
        <div className="ex-detail__body">
          <p className="ex-detail__error" role="alert">
            <Icon name="status-failed" size={16} /> The attempt could not be read.{' '}
            {error?.message ?? 'The API returned no attempt.'}
          </p>
          {error !== null ? (
            <p className="ex-detail__meta">
              Code <span className="iz-mono">{error.code}</span> · HTTP {error.status}
              {error.correlationId !== null ? (
                <>
                  {' '}
                  · <span className="iz-mono">Correlation {error.correlationId}</span>
                </>
              ) : null}
            </p>
          ) : null}
          <Button size="sm" onClick={onRetry}>
            Retry
          </Button>
        </div>
      </section>
    );
  }

  const { attempt, toolInvocations, artifacts } = detail;
  const provenance = provenanceOf(attempt);
  const state = runStateDescriptor(attempt.status);
  const mismatch = provenanceMismatch(attempt);
  const wallTime = elapsedMs(attempt, now);
  const running = attempt.startedAt !== null && attempt.finishedAt === null;
  const attemptError = describeAttemptError(attempt.error);
  const cost = formatProviderCost(attempt.costUsd);

  return (
    <section className="ex-detail" id={id} aria-labelledby={headingId} tabIndex={-1}>
      <header className="ex-detail__head">
        <h2 className="ex-detail__title" id={headingId}>
          Attempt <span className="iz-mono">#{attempt.attemptNumber}</span>
        </h2>
        <div className="ex-detail__badges">
          <ProvenanceBadge provenance={provenance} />
          <RunStateBadge status={attempt.status} />
        </div>
      </header>

      {mismatch !== null ? (
        <div className="ex-detail__banner">
          <Banner
            variant={mismatch.loud ? 'degraded' : 'info'}
            title={mismatch.title}
            announce={mismatch.loud}
          >
            {mismatch.message}
          </Banner>
        </div>
      ) : null}

      <dl className="ex-kv ex-kv--grid">
        <div className="ex-kv__row">
          <dt>Runtime</dt>
          <dd>
            <span className="iz-mono">{attempt.runtimeId}</span>
            {attempt.runtimeVersion !== null ? (
              <span className="iz-mono ex-muted"> {attempt.runtimeVersion}</span>
            ) : (
              <span className="ex-muted">
                {' '}
                · <NotReported label="Version not reported" />
              </span>
            )}
          </dd>
        </div>
        <div className="ex-kv__row">
          <dt>Model</dt>
          <dd title="The executions response does not include a model or provider metadata.">
            <NotReported />
          </dd>
        </div>
        <div className="ex-kv__row">
          <dt>Status</dt>
          <dd>
            {state.label}
            {state.qualifier !== null ? <span className="ex-muted"> · {state.qualifier}</span> : null}
          </dd>
        </div>
        <div className="ex-kv__row">
          <dt>{running ? 'Elapsed' : 'Wall time'}</dt>
          <dd>
            <span className="iz-num">
              <SpokenValue spoken={`${describeDuration(wallTime)}${running ? ', elapsed so far' : ''}`}>
                {formatDuration(wallTime)}
              </SpokenValue>
            </span>
            {running ? <span className="ex-muted"> elapsed</span> : null}
          </dd>
        </div>
        <div className="ex-kv__row">
          <dt>Started</dt>
          <dd>{attempt.startedAt === null ? <NotReported /> : <UtcTime iso={attempt.startedAt} />}</dd>
        </div>        <div className="ex-kv__row">
          <dt>Finished</dt>
          <dd>
            {attempt.finishedAt === null ? (
              <span className="ex-muted">{running ? 'Still open' : 'Not reported'}</span>
            ) : (
              <UtcTime iso={attempt.finishedAt} />
            )}
          </dd>
        </div>
        <div className="ex-kv__row">
          <dt>Tokens</dt>
          <dd>
            <span className="iz-num">{formatTokenCount(attempt.tokensIn)}</span>
            <span className="ex-muted"> in</span>
            <span className="ex-muted"> · </span>
            <span className="iz-num">{formatTokenCount(attempt.tokensOut)}</span>
            <span className="ex-muted"> out</span>
          </dd>
        </div>
        <div className="ex-kv__row">
          <dt>Cost</dt>
          <dd>
            {cost === '—' ? (
              <NotReported label="Not reported by the provider" />
            ) : (
              <span className="iz-num" title="Reported by the runtime; not an estimate.">
                {cost}
              </span>
            )}
          </dd>
        </div>
        <div className="ex-kv__row">
          <dt>Attempt id</dt>
          <dd>
            <span className="iz-mono ex-kv__id">{attempt.id}</span>
          </dd>
        </div>
        <div className="ex-kv__row">
          <dt>Workflow run</dt>
          <dd>
            <span className="iz-mono ex-kv__id">{attempt.workflowRunId}</span>
          </dd>
        </div>
      </dl>

      {attemptError !== null ? (
        <div className="ex-detail__failure" data-state={attempt.status}>
          <p className="ex-detail__failure-title">
            <Icon name="status-failed" size={16} /> The runtime reported an error.
          </p>
          <p className="ex-detail__body">{attemptError}</p>
          <p className="ex-detail__meta">
            The error text is stored verbatim by the worker; it is shown as reported and was not
            rewritten here.
          </p>
        </div>
      ) : null}

      <section className="ex-detail__section" aria-labelledby={`${id}-timeline`}>
        <div className="ex-detail__section-head">
          <h3 className="ex-detail__subtitle" id={`${id}-timeline`}>
            Tool invocations
          </h3>
          <span className="ex-detail__count">{formatCount(toolInvocations.length)}</span>
        </div>
        <p className="ex-detail__meta">
          Redacted by the adapter before storage. Absolute times, UTC.
        </p>
        <ToolTimeline invocations={toolInvocations} />
      </section>

      <section className="ex-detail__section" aria-labelledby={`${id}-artifacts`}>
        <div className="ex-detail__section-head">
          <h3 className="ex-detail__subtitle" id={`${id}-artifacts`}>
            Artifacts
          </h3>
          <span className="ex-detail__count">{formatCount(artifacts.length)}</span>
        </div>
        <p className="ex-detail__meta">
          Integrity is computed by hashing the bytes on this request — never read from a stored
          flag. Attribution is by task, runtime and time window; the schema has no attempt column.
        </p>
        {artifacts.length === 0 ? (
          <p className="ex-detail__body">
            No artifact is attributed to this attempt. Evidence is written only when a run reaches
            the point of producing it, so an early failure has none — this is absence, not zero
            bytes.
          </p>
        ) : (
          <ArtifactTable artifacts={artifacts} download={onDownload} />
        )}
      </section>

      <section className="ex-detail__section" aria-labelledby={`${id}-workspace`}>
        <h3 className="ex-detail__subtitle" id={`${id}-workspace`}>
          Workspace
        </h3>
        <WorkspacePanel workspace={attempt.workspace} />
      </section>
    </section>
  );
}

function UtcTime({ iso }: { readonly iso: string }) {
  const absolute = formatAbsoluteUtc(iso);
  return (
    <time dateTime={iso} className="iz-mono" title={absolute}>
      {absolute}
    </time>
  );
}
