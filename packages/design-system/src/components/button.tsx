import type { ComponentPropsWithoutRef, ReactNode } from 'react';

/**
 * Buttons implement all eight interaction states (DESIGN.md §10). The pressed
 * state changes colour only — never size, never position — because a 1px shift
 * in a dense row is a layout bug the operator sees.
 *
 * `loading` replaces the label with a spinner and sets `aria-busy`; the width is
 * locked by the surrounding flex context (`min-width` on the label box), so a
 * 24px target never collapses to the width of a spinner.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps extends ComponentPropsWithoutRef<'button'> {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly loading?: boolean;
  /** Square control. The caller must supply `aria-label` when there is no text. */
  readonly iconOnly?: boolean;
  readonly children: ReactNode;
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  iconOnly = false,
  className,
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      {...rest}
      type={type}
      className={['iz-btn', className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly ? 'true' : undefined}
      data-loading={loading ? 'true' : undefined}
      aria-busy={loading ? true : undefined}
      disabled={disabled === true || loading}
    >
      {loading ? <span className="iz-spinner" aria-hidden="true" /> : null}
      <span className="iz-btn__label">{children}</span>
    </button>
  );
}

/**
 * A link styled as a button — same tokens, same states, correct semantics.
 * Exported so the app never fakes a button with an `<a>` and loses keyboard
 * behaviour, or fakes navigation with a `<button>` and loses the URL.
 */
export function ButtonLink({
  variant = 'secondary',
  size = 'md',
  iconOnly = false,
  className,
  children,
  ...rest
}: {
  readonly variant?: ButtonVariant;
  readonly size?: ButtonSize;
  readonly iconOnly?: boolean;
  readonly className?: string;
  readonly children: ReactNode;
  readonly href: string;
  readonly title?: string;
  readonly 'aria-label'?: string;
}) {
  return (
    <a
      {...rest}
      className={['iz-btn', className].filter(Boolean).join(' ')}
      data-variant={variant}
      data-size={size}
      data-icon-only={iconOnly ? 'true' : undefined}
    >
      <span className="iz-btn__label">{children}</span>
    </a>
  );
}
