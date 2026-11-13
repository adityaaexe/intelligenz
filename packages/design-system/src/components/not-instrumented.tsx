import type { ReactNode } from 'react';

import { Chip } from './chip';

/**
 * The honest "no data source exists" state (contract §15 A6).
 *
 * This is deliberately not an `EmptyState`: an empty state says "there is
 * nothing here yet", which implies the system looked. `NotInstrumented` says
 * the system *cannot* look, names the missing source, and states what would
 * make the region real. A full dashboard built on fixtures is a lie; this is the
 * alternative.
 */
export interface NotInstrumentedProps {
  readonly reason: ReactNode;
  /** The endpoint, table, or model that does not exist yet. */
  readonly source?: string;
  /** What would make the region real. */
  readonly unblockedBy?: ReactNode;
  readonly className?: string;
}

export function NotInstrumented({ reason, source, unblockedBy, className }: NotInstrumentedProps) {
  return (
    <div className={['iz-ni', className].filter(Boolean).join(' ')}>
      <Chip tone="neutral" icon="info">
        Not instrumented
      </Chip>
      <p className="iz-ni__reason">{reason}</p>
      {source !== undefined ? <p className="iz-ni__source">Missing source: {source}</p> : null}
      {unblockedBy !== undefined ? <p className="iz-ni__reason">{unblockedBy}</p> : null}
    </div>
  );
}
