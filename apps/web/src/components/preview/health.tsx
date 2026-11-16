import { Panel, StatusPill } from '@intelligenz/design-system';
import type { StatusTone } from '@intelligenz/design-system';

import type { PreviewDependencyHealth, PreviewHealth } from '../../lib/preview-data';
import { formatUtc } from '../../lib/preview-data';

/**
 * F. Health — what the API actually answered, and what nothing answered.
 *
 * Three rules make this section honest rather than reassuring:
 *
 *   - A probe that failed or timed out is `UNAVAILABLE`, never "healthy".
 *   - redis is `NOT CHECKED` because `GET /health/ready` does not report it.
 *     An absent check is not a passing check.
 *   - The worker has no heartbeat endpoint, so its state is `UNKNOWN`. This page
 *     renders no green light it cannot source.
 */

function apiState(health: PreviewHealth): { readonly label: string; readonly tone: StatusTone } {
  if (health.api === 'ready') return { label: 'Ready', tone: 'completed' };
  if (health.api === 'not_ready') return { label: 'Not ready', tone: 'degraded' };
  return { label: 'UNAVAILABLE', tone: 'offline' };
}

function dependencyState(dependency: PreviewDependencyHealth): {
  readonly label: string;
  readonly tone: StatusTone;
} {
  if (dependency.status === 'up') return { label: 'Up', tone: 'completed' };
  if (dependency.status === 'down') return { label: 'Down', tone: 'failed' };
  if (dependency.status === 'unavailable') return { label: 'UNAVAILABLE', tone: 'offline' };
  return { label: 'Not reported', tone: 'neutral' };
}

export function HealthSection({
  health,
  snapshotAt,
}: {
  readonly health: PreviewHealth;
  readonly snapshotAt: string;
}) {
  const api = apiState(health);

  return (
    <Panel
      title="Health"
      meta={`Snapshot ${formatUtc(health.checkedAt)} (server clock)`}
      footer={
        <p className="pv-footnote">
          API readiness and both dependency checks were read once, from the web server, at{' '}
          {formatUtc(snapshotAt)}. A failed or timed-out probe is shown as{' '}
          <strong>UNAVAILABLE</strong>, never as healthy.
        </p>
      }
    >
      <ul className="pv-health">
        <li className="pv-health__row">
          <div className="pv-health__name">
            API readiness
            <span className="pv-health__source">GET /health/ready</span>
          </div>
          <div className="pv-health__state">
            <StatusPill status={health.api} label={api.label} tone={api.tone} />
          </div>
          <div className="pv-health__detail">
            {health.api === 'unavailable'
              ? (health.note ?? 'the probe did not answer')
              : 'the API answered with a readiness document'}
          </div>
        </li>

        {health.dependencies.map((dependency) => {
          const state = dependencyState(dependency);
          return (
            <li className="pv-health__row" key={dependency.name}>
              <div className="pv-health__name">
                {dependency.name}
                <span className="pv-health__source">dependency check</span>
              </div>
              <div className="pv-health__state">
                <StatusPill status={dependency.status} label={state.label} tone={state.tone} />
              </div>
              <div className="pv-health__detail pv-figure">
                {dependency.latencyMs === null ? '—' : `${dependency.latencyMs} ms`}
              </div>
            </li>
          );
        })}

        <li className="pv-health__row">
          <div className="pv-health__name">
            redis
            <span className="pv-health__source">not reported by the endpoint</span>
          </div>
          <div className="pv-health__state">
            <span className="pv-flag">NOT CHECKED</span>
          </div>
          <div className="pv-health__detail">
            The readiness endpoint does not report redis, so this page does not either.
          </div>
        </li>

        <li className="pv-health__row">
          <div className="pv-health__name">
            worker
            <span className="pv-health__source">no heartbeat source</span>
          </div>
          <div className="pv-health__state">
            <span className="pv-flag">UNKNOWN — no heartbeat endpoint</span>
          </div>
          <div className="pv-health__detail">
            Nothing exposes worker liveness to the web server, so worker health is unknown rather
            than assumed.
          </div>
        </li>
      </ul>
    </Panel>
  );
}
