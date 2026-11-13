import { Chip, EmptyState, Panel, formatCost, formatCount, formatTokenCount } from '@intelligenz/design-system';

import type { OverviewSnapshot } from '../../lib/overview';
import { sumUsage } from '../../lib/overview';
import { RegionError } from './region-error';

/**
 * Usage and cost — source: `AgentRun.usage` aggregate (contract §15 A6).
 *
 * The aggregate is over the runs this page actually read, not over the
 * organisation: there is no usage endpoint, so the scope is stated instead of
 * implied. A zero total is labelled `Simulated` because the only runtime in
 * Phase 2 reports zero — a real `$0.00` and a fabricated one would otherwise be
 * indistinguishable to the reader.
 */
export function UsageCost({
  snapshot,
  onRetry,
}: {
  readonly snapshot: OverviewSnapshot;
  readonly onRetry: () => void;
}) {
  const { agentRuns } = snapshot;

  if (!agentRuns.ok) {
    return (
      <Panel title="Usage and cost" meta="AgentRun usage">
        <RegionError headline="Usage could not be read." error={agentRuns.error} onRetry={onRetry} />
      </Panel>
    );
  }

  const usage = sumUsage(agentRuns.value);

  return (
    <Panel
      title="Usage and cost"
      meta={<Chip tone="derived">Derived</Chip>}
      note="Summed from the latest run of each of the most recently updated tasks — the API exposes no organisation-wide usage endpoint."
    >
      {usage.runs === 0 ? (
        <EmptyState
          title="No recorded usage"
          description="No agent run has been recorded for the tasks read on this page, so there is nothing to sum. Usage appears after a workflow executes."
        />
      ) : (
        <>
          <div className="ov-figure-row">
            <div>
              <span className="iz-metric__label">Recorded cost</span>
              <div className="ov-figure">{formatCost(usage.costUsd)}</div>
            </div>
            {usage.reportedZeroCost ? (
              <Chip tone="simulated" icon="info">
                Simulated
              </Chip>
            ) : null}
          </div>

          <div className="ov-kv">
            <span>Tokens in</span>
            <span className="ov-kv__value">{formatTokenCount(usage.tokensIn)}</span>
          </div>
          <div className="ov-kv">
            <span>Tokens out</span>
            <span className="ov-kv__value">{formatTokenCount(usage.tokensOut)}</span>
          </div>
          <div className="ov-kv">
            <span>Agent runs counted</span>
            <span className="ov-kv__value">{formatCount(usage.runs)}</span>
          </div>
          <div className="ov-kv">
            <span>Tasks contributing</span>
            <span className="ov-kv__value">{formatCount(usage.tasks)}</span>
          </div>
          <div className="ov-kv">
            <span>Runs from a simulated runtime</span>
            <span className="ov-kv__value">{formatCount(usage.simulatedRuns)}</span>
          </div>

          {usage.reportedZeroCost ? (
            <p className="iz-field__hint" style={{ marginTop: 'var(--iz-space-8)' }}>
              Every run reported <span className="iz-num">$0.00</span>. That is a recorded value from
              <span className="iz-mono"> LocalSimulatedRuntime</span>, not a missing one and not a
              price. Budget is advisory in this phase (contract §15 A7).
            </p>
          ) : null}
        </>
      )}
    </Panel>
  );
}
