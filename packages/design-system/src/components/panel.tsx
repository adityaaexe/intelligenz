import type { ReactNode } from 'react';

/**
 * A region of the ledger: a 1px rule, a heading, no card, no shadow
 * (DESIGN.md §8 — "no static content ever carries a shadow").
 *
 * Rendered as `<section aria-labelledby>` so the panel is a landmark a screen
 * reader can jump to, and so the heading is programmatically bound to it
 * (DESIGN.md §12.2 "Semantic structure").
 */
export interface PanelProps {
  readonly title: string;
  readonly meta?: ReactNode;
  readonly note?: ReactNode;
  readonly actions?: ReactNode;
  readonly footer?: ReactNode;
  /** Flush removes the body padding — use for tables that run edge to edge. */
  readonly flush?: boolean;
  readonly children: ReactNode;
  readonly className?: string;
  readonly bodyClassName?: string;
  readonly id?: string;
}

export function Panel({
  title,
  meta,
  note,
  actions,
  footer,
  flush = false,
  children,
  className,
  bodyClassName,
  id,
}: PanelProps) {
  const headingId = `${id ?? slug(title)}-heading`;
  return (
    <section className={['iz-panel', className].filter(Boolean).join(' ')} aria-labelledby={headingId} id={id}>
      <header className="iz-panel__head">
        <div className="iz-panel__heading">
          <h2 className="iz-panel__title" id={headingId}>
            {title}
          </h2>
          {meta !== undefined ? <span className="iz-panel__meta">{meta}</span> : null}
        </div>
        {actions !== undefined ? <div className="iz-panel__actions">{actions}</div> : null}
      </header>
      {note !== undefined ? <div className="iz-panel__note">{note}</div> : null}
      <div
        className={['iz-panel__body', flush ? 'iz-panel__body--flush' : null, bodyClassName]
          .filter(Boolean)
          .join(' ')}
      >
        {children}
      </div>
      {footer !== undefined ? <div className="iz-panel__foot">{footer}</div> : null}
    </section>
  );
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}
