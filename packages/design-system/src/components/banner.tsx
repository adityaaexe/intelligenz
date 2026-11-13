import type { ReactNode } from 'react';

import { Icon } from './icon';
import type { IconName } from './icon';

/**
 * System-state banners (DESIGN.md §13 "Degraded banners"): name the dependency,
 * the impact, and the workaround. Never a bare code and never a toast — a
 * degraded dependency is a fact the operator must be able to re-read, so it
 * lives in the document, not in a transient surface.
 *
 * `role="alert"` is reserved for the error variant (a failed request); degraded
 * and offline are `role="status"` so they announce politely once.
 */
export type BannerVariant = 'degraded' | 'offline' | 'permission' | 'error' | 'info';

const ICONS: Readonly<Record<BannerVariant, IconName>> = {
  degraded: 'status-degraded',
  offline: 'status-offline',
  permission: 'lock',
  error: 'status-failed',
  info: 'info',
};

export interface BannerProps {
  readonly variant: BannerVariant;
  readonly title: string;
  readonly children?: ReactNode;
  readonly action?: ReactNode;
  readonly className?: string;
  /** Override the live-region role. Omit for a static, always-present banner. */
  readonly announce?: boolean;
}

export function Banner({ variant, title, children, action, className, announce = false }: BannerProps) {
  const isAlert = variant === 'error';
  return (
    <div
      className={['iz-banner', className].filter(Boolean).join(' ')}
      data-variant={variant}
      role={announce ? (isAlert ? 'alert' : 'status') : undefined}
      aria-live={announce ? (isAlert ? 'assertive' : 'polite') : undefined}
    >
      <span className="iz-banner__icon">
        <Icon name={ICONS[variant]} size={16} />
      </span>
      <div className="iz-banner__text">
        <span className="iz-banner__title">{title}</span>
        {children !== undefined ? <> {children}</> : null}
      </div>
      {action !== undefined ? <div className="iz-banner__actions">{action}</div> : null}
    </div>
  );
}
