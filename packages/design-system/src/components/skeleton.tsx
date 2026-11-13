/**
 * Skeletons hold the final dimensions of their region, so nothing moves when
 * data arrives (DESIGN.md §12.2, Overview §6 "No layout shift on resolve").
 * The shimmer is removed entirely under `prefers-reduced-motion`.
 */
export interface SkeletonProps {
  readonly width?: number | string;
  readonly height?: number | string;
  readonly className?: string;
  /** Rounded to a line rather than a block. */
  readonly variant?: 'block' | 'line';
}

export function Skeleton({ width = '100%', height = 12, className, variant = 'block' }: SkeletonProps) {
  return (
    <span
      aria-hidden="true"
      className={['iz-skel', className].filter(Boolean).join(' ')}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: variant === 'line' ? 'var(--iz-radius-xs)' : 'var(--iz-radius-sm)',
      }}
    />
  );
}

export interface SkeletonStackProps {
  readonly rows?: number;
  readonly rowHeight?: number;
  readonly label?: string;
}

export function SkeletonStack({ rows = 3, rowHeight = 12, label = 'Loading' }: SkeletonStackProps) {
  return (
    <div className="iz-skel-stack" role="status" aria-live="polite" aria-busy="true">
      <span className="iz-sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <Skeleton key={index} height={rowHeight} width={index === rows - 1 ? '60%' : '100%'} />
      ))}
    </div>
  );
}

export interface SkeletonTableProps {
  readonly rows?: number;
  readonly columns?: number;
  readonly label?: string;
}

/** Table-shaped placeholder: same row height as the real table, no reflow. */
export function SkeletonTable({ rows = 8, columns = 5, label = 'Loading table' }: SkeletonTableProps) {
  return (
    <div role="status" aria-live="polite" aria-busy="true" style={{ padding: 'var(--iz-space-12) 0' }}>
      <span className="iz-sr-only">{label}</span>
      {Array.from({ length: rows }, (_, rowIndex) => (
        <div
          key={rowIndex}
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
            gap: 'var(--iz-space-12)',
            padding: 'var(--iz-space-8) var(--iz-space-12)',
            borderBottom: '1px solid var(--iz-border-subtle)',
          }}
        >
          {Array.from({ length: columns }, (_, columnIndex) => (
            <Skeleton key={columnIndex} height={10} width={columnIndex === 0 ? '70%' : '90%'} />
          ))}
        </div>
      ))}
    </div>
  );
}
