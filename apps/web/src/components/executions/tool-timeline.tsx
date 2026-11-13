import { EmptyState, formatAbsoluteUtc } from '@intelligenz/design-system';

import { clockUtc, isCommandSummary } from '../../lib/execution-state';
import { timelineMayBeTruncated } from '../../lib/executions';
import type { ToolInvocation } from '../../lib/types';

/**
 * The tool trace, as an ordered list.
 *
 * An execution timeline is a genuine ordered sequence, so it is an `<ol>` — not
 * a stack of `<div>`s (DESIGN.md §12.2, and the one place numbered markers are
 * allowed: §5.4 "No numbered section markers outside a genuine ordered
 * sequence"). The number rendered is the persisted `sequence`, not the DOM
 * index: if the API ever returns a gap, the gap is visible instead of being
 * renumbered away.
 *
 * Time is absolute (`14:02:48` UTC) with the full value in `title` and the
 * accessible name. A trace is an audit surface; relative ages would make two
 * rows read identically and hide the ordering.
 *
 * The summary is already redacted by the adapter and capped at 500 characters by
 * the database, so it is rendered as data, never as markup.
 */
export function ToolTimeline({ invocations }: { readonly invocations: readonly ToolInvocation[] }) {
  if (invocations.length === 0) {
    return (
      <EmptyState
        title="No tool calls recorded"
        description="This attempt produced no tool invocation rows. A run that failed before dispatch, or a runtime that reports no tools, leaves this trace empty — nothing is inferred to fill it."
      />
    );
  }

  return (
    <>
      <ol className="ex-timeline" aria-label="Tool invocations, in sequence">
        {invocations.map((invocation) => (
          <li className="ex-timeline__item" key={invocation.id}>
            <span className="ex-timeline__seq iz-num">
              <span className="iz-sr-only">Step </span>
              {invocation.sequence}
            </span>
            <span className="ex-timeline__tool iz-mono">{invocation.tool}</span>
            <span
              className={
                isCommandSummary(invocation.tool)
                  ? 'ex-timeline__summary ex-timeline__summary--command iz-mono'
                  : 'ex-timeline__summary'
              }
            >
              {invocation.summary}
            </span>
            <time
              className="ex-timeline__time iz-num"
              dateTime={invocation.occurredAt}
              title={formatAbsoluteUtc(invocation.occurredAt)}
            >
              <span className="iz-sr-only">{formatAbsoluteUtc(invocation.occurredAt)} UTC</span>
              <span aria-hidden="true">{clockUtc(invocation.occurredAt)}</span>
            </time>
          </li>
        ))}
      </ol>
      {timelineMayBeTruncated(invocations.length) ? (
        <p className="ex-note">
          The trace reached the {invocations.length}-row display cap. The run may contain more
          calls than are listed here; the adapter records its own truncation in the run metadata,
          which this endpoint does not return.
        </p>
      ) : null}
    </>
  );
}
