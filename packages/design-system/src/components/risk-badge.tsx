/**
 * Risk is a different visual form from status — four filled segments plus the
 * word — so the two dimensions cannot be confused when they sit side by side in
 * a row (DESIGN.md §4.5). A risk badge is never pill-shaped and never relies on
 * hue alone: the segment count carries the level, and the label names it.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';

const FILLED: Readonly<Record<RiskLevel, number>> = {
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
  CRITICAL: 4,
};

const LABELS: Readonly<Record<RiskLevel, string>> = {
  LOW: 'Low',
  MEDIUM: 'Medium',
  HIGH: 'High',
  CRITICAL: 'Critical',
};

const SEGMENTS = [0, 1, 2, 3] as const;

export interface RiskBadgeProps {
  readonly level: RiskLevel;
  /** Composite score 0–100. Shown numerically beside the label when known. */
  readonly score?: number;
  readonly className?: string;
}

export function RiskBadge({ level, score, className }: RiskBadgeProps) {
  const filled = FILLED[level];
  const label = LABELS[level];
  return (
    <span
      className={['iz-risk', className].filter(Boolean).join(' ')}
      data-level={level.toLowerCase()}
    >
      <span className="iz-risk__segments" aria-hidden="true">
        {SEGMENTS.map((index) => (
          <span
            className="iz-risk__segment"
            data-filled={index < filled ? 'true' : 'false'}
            key={index}
          />
        ))}
      </span>
      <span>
        <span className="iz-sr-only">Risk: </span>
        {label}
        {score !== undefined ? <span className="iz-risk__score"> · {score}</span> : null}
      </span>
    </span>
  );
}

/** Wire value → level. Unknown values are never silently coerced to Low. */
export function riskFromWire(value: string): RiskLevel | null {
  const upper = value.toUpperCase();
  if (upper === 'LOW' || upper === 'MEDIUM' || upper === 'HIGH' || upper === 'CRITICAL') {
    return upper;
  }
  return null;
}
