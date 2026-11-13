import type { ReactNode } from 'react';

import { Icon } from './icon';
import type { IconName } from './icon';

/**
 * A neutral label chip. Used for the states this product must never imply:
 * `Simulated` (a runtime, not a real agent), `Derived` (a number computed
 * client-side from records that do exist), `Not instrumented` (no source).
 */
export interface ChipProps {
  readonly children: ReactNode;
  readonly tone?: 'neutral' | 'simulated' | 'derived' | 'seal';
  readonly icon?: IconName;
  readonly className?: string;
  /** Spoken prefix when the visible text is too terse on its own. */
  readonly srPrefix?: string;
}

export function Chip({ children, tone = 'neutral', icon, className, srPrefix }: ChipProps) {
  return (
    <span className={['iz-chip', className].filter(Boolean).join(' ')} data-tone={tone}>
      {icon !== undefined ? <Icon name={icon} size={12} /> : null}
      {srPrefix !== undefined ? <span className="iz-sr-only">{srPrefix}</span> : null}
      {children}
    </span>
  );
}
