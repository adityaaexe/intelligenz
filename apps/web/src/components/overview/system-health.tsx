import { NotInstrumented, Panel, StatusPill } from '@intelligenz/design-system';

import type { OverviewSnapshot } from '../../lib/overview';
import { RegionError } from './region-error';

/**
 * System health — source: `GET /health/ready` (contract §15 A6).
 *
 * The endpoint answers with a per-dependency document at both 200 and 503, so a
 * `not_ready` body is data, not an error. A truly unreachable API is a different
 * state and is handled before this panel renders: the page must never show a
 * stale "healthy".
 */
export function SystemHealth({
  snapshot,
  onRetry,
}: {
  readonly snapshot: OverviewSnapshot;
  readonly onRetry: () => void;
}) {
  const { health } = snapshot;

  if (!health.ok) {
    return (
      <Panel
        title="System health"
        meta="GET /health/ready"
        note="This panel reports the API's own readiness document. No cached or inferred value is shown."
      >
        <RegionError
          headline={
            health.error.isNetwork
              ? 'The API is unreachable.'
              : 'Readiness could not be read.'
          }
          error={health.error}
          onRetry={onRetry}
        />
      </Panel>
    );
  }

  const entries = Object.entries(health.value.checks);
  const down = entries.filter(([, check]) => check.status !== 'up').map(([name]) => name);

  return (
    <Panel
      title="System health"
      meta="GET /health/ready"
      note={
        down.length === 0
          ? 'Both dependencies answered up on the last read. This panel is the only source of a health claim on this page.'
          : `Not ready: ${down.join(', ')}. Reads that depend on those services may fail or queue.`
      }
    >
      {entries.length === 0 ? (
        <NotInstrumented
          reason="The readiness endpoint answered without a per-dependency document, so no dependency status can be shown."
          source="GET /health/ready → checks{postgres, temporal}"
        />
      ) : (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {entries.map(([name, check]) => (
            <li className="ov-health-row" key={name}>
              <span className="ov-health-row__name">{name}</span>
              <span className="ov-health-row__meta">
                <span className="iz-num">{check.latencyMs}ms</span>
                {check.detail !== undefined ? <span className="iz-mono">{check.detail}</span> : null}
                <StatusPill status={check.status} size="sm" />
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="iz-field__hint" style={{ marginTop: 'var(--iz-space-8)' }}>
        Service <span className="iz-mono">{health.value.service}</span> reported{' '}
        <span className="iz-mono">{health.value.status}</span>.
      </p>
    </Panel>
  );
}
