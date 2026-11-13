import type { ReactNode } from 'react';

/**
 * Empty is a state, not a blank (DESIGN.md §13): state what would appear here,
 * why it is empty, and the one action that changes it. Absence of data is
 * rendered as absence — never as a zero and never as an empty cell.
 */
export interface EmptyStateProps {
  readonly title: string;
  readonly description: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  /** Heading level for the empty-state title; 3 inside a panel with an h2. */
  readonly headingLevel?: 2 | 3;
}

export function EmptyState({
  title,
  description,
  action,
  className,
  headingLevel = 3,
}: EmptyStateProps) {
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  return (
    <div className={['iz-empty', className].filter(Boolean).join(' ')}>
      <Heading className="iz-empty__title">{title}</Heading>
      <p className="iz-empty__body">{description}</p>
      {action !== undefined ? <div className="iz-empty__actions">{action}</div> : null}
    </div>
  );
}
