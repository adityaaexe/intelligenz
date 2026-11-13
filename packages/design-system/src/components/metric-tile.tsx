import type { ReactNode } from 'react';

/**
 * A posture metric: label, value, unit, hint.
 *
 * §5.3 rules that live here rather than at the call site: tabular figures, the
 * unit at 0.85em in ink-3 with a 2px gap, and `—` with an accessible
 * "Not reported" for a missing value. `0` is never substituted for absent data
 * (DESIGN.md §3 principle 6).
 */
export interface MetricTileProps {
  readonly label: string;
  /** Pre-formatted value. `null`/`undefined` renders the not-reported dash. */
  readonly value: string | number | null | undefined;
  readonly unit?: string;
  readonly hint?: ReactNode;
  readonly tone?: 'neutral' | 'active' | 'failed' | 'awaiting' | 'degraded';
  readonly size?: 'lg' | 'md';
  readonly className?: string;
  readonly href?: string;
}

export function MetricTile({
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
  size = 'lg',
  className,
  href,
}: MetricTileProps) {
  const missing = value === null || value === undefined || value === '';
  const display = missing ? '—' : String(value);
  const body = (
    <>
      <span className="iz-metric__label">{label}</span>
      <span
        className="iz-metric__value"
        data-size={size === 'md' ? 'md' : undefined}
        data-tone={tone === 'neutral' ? undefined : tone}
      >
        {missing ? (
          <span aria-label="Not reported">—</span>
        ) : (
          <>
            {display}
            {unit !== undefined ? <span className="iz-unit">{unit}</span> : null}
          </>
        )}
      </span>
      {hint !== undefined ? <span className="iz-metric__hint">{hint}</span> : null}
    </>
  );

  if (href !== undefined) {
    return (
      <a className={['iz-metric', className].filter(Boolean).join(' ')} href={href}>
        {body}
      </a>
    );
  }

  return <div className={['iz-metric', className].filter(Boolean).join(' ')}>{body}</div>;
}
