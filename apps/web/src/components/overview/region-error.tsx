'use client';

import { Button } from '@intelligenz/design-system';

import type { ApiError } from '../../lib/api';

/**
 * A region that failed, with the reason and a retry. Each of the eight regions
 * owns its own failure: one 503 must never blank the page (Overview §6).
 */
export function RegionError({
  headline,
  error,
  onRetry,
}: {
  readonly headline: string;
  readonly error: ApiError;
  readonly onRetry: () => void;
}) {
  return (
    <div className="iz-empty">
      <h3 className="iz-empty__title">{headline}</h3>
      <p className="iz-empty__body">
        {error.message}
        {error.correlationId !== null ? (
          <>
            {' '}
            <span className="iz-mono">Correlation {error.correlationId}</span>
          </>
        ) : null}
      </p>
      <p className="iz-field__hint">
        Code <span className="iz-mono">{error.code}</span> · HTTP {error.status}
      </p>
      <div className="iz-empty__actions">
        <Button size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}
