import type { ReactNode, SVGProps } from 'react';

/**
 * Inline SVG glyphs, 16×16 grid, 1.5 stroke, `currentColor` only (DESIGN.md §9).
 *
 * No icon font, no sprite fetch, no dependency. A glyph that is intentionally
 * solid (status dots) says so locally. An icon never hardcodes a hue, so the
 * same glyph works on canvas and on chrome.
 */

export type IconName =
  // navigation
  | 'overview'
  | 'approvals'
  | 'agents'
  | 'projects'
  | 'code'
  | 'design'
  | 'creative'
  | 'workflows'
  | 'schedules'
  | 'research'
  | 'models'
  | 'knowledge'
  | 'security'
  | 'reports'
  | 'integrations'
  | 'marketplace'
  // status
  | 'status-active'
  | 'status-queued'
  | 'status-completed'
  | 'status-failed'
  | 'status-awaiting'
  | 'status-degraded'
  | 'status-offline'
  | 'status-neutral'
  // ui
  | 'chevron-down'
  | 'chevron-up'
  | 'chevron-right'
  | 'chevron-left'
  | 'arrow-right'
  | 'check'
  | 'x'
  | 'warning'
  | 'info'
  | 'refresh'
  | 'copy'
  | 'external'
  | 'lock'
  | 'search'
  | 'more-horizontal'
  | 'plus'
  | 'dot'
  | 'stop'
  | 'clock'
  | 'rail'
  | 'signout';

const PATHS: Readonly<Record<IconName, ReactNode>> = {
  overview: (
    <>
      <rect x="2.5" y="2.5" width="4.5" height="4.5" />
      <rect x="9" y="2.5" width="4.5" height="4.5" />
      <rect x="2.5" y="9" width="4.5" height="4.5" />
      <rect x="9" y="9" width="4.5" height="4.5" />
    </>
  ),
  approvals: (
    <>
      <path d="M3 3.4h10v5.1c0 2.4-2 4.1-5 5.5-3-1.4-5-3.1-5-5.5z" />
      <path d="M6 7.5 7.4 8.9 10.3 5.8" />
    </>
  ),
  agents: (
    <>
      <path d="M8 2.2 13 5v6l-5 2.8L3 11V5z" />
      <circle cx="8" cy="8" r="1.6" />
    </>
  ),
  projects: <path d="M2.5 4.4h4l1.2 1.7h5.8v6.5h-11z" />,
  code: <path d="M6 4.4 3 8l3 3.6M10 4.4 13 8l-3 3.6" />,
  design: (
    <>
      <path d="M3 13.2l1-3.3 6.2-6.2 2.3 2.3-6.2 6.2z" />
      <path d="M9.4 4.6 11.7 6.9" />
    </>
  ),
  creative: (
    <path d="M8 2.4c.6 3.1 1.9 4.4 5 5-3.1.6-4.4 1.9-5 5-.6-3.1-1.9-4.4-5-5 3.1-.6 4.4-1.9 5-5Z" />
  ),
  workflows: (
    <>
      <circle cx="4" cy="4" r="1.8" />
      <circle cx="12" cy="8" r="1.8" />
      <circle cx="4" cy="12" r="1.8" />
      <path d="M5.5 4.9 10.5 7.2M10.5 8.8 5.5 11.1" />
    </>
  ),
  schedules: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.4 1.7" />
    </>
  ),
  research: (
    <>
      <path d="M6.4 2.5h3.2M8 2.5v4.3L4.4 12.5h7.2L8 6.8" />
      <path d="M5.6 9.7h4.8" />
    </>
  ),
  models: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="2" />
      <path d="M8 2.5v2M8 11.5v2M2.5 8h2M11.5 8h2" />
    </>
  ),
  knowledge: <path d="M2.8 3.4h4.4L8 4.7l.8-1.3h4.4v9.2H8.8L8 13.9l-.8-1.3H2.8z" />,
  security: <path d="M8 2.3 12.8 4v4.1c0 2.6-1.9 4.6-4.8 5.6-2.9-1-4.8-3-4.8-5.6V4z" />,
  reports: (
    <>
      <path d="M3.5 2.5h5.8l3.2 3.2v7.8H3.5z" />
      <path d="M9.1 2.6v3.3h3.2M5.7 8.6h4.6M5.7 11h3.3" />
    </>
  ),
  integrations: (
    <>
      <path d="M5.6 2.6v2.4M10.4 2.6v2.4" />
      <path d="M4 5h8v2.6a4 4 0 0 1-8 0z" />
      <path d="M8 11.6v1.8" />
    </>
  ),
  marketplace: (
    <>
      <path d="M3 5.4h10l-.8 8.1H3.8z" />
      <path d="M6 5.4V4.3a2 2 0 0 1 4 0v1.1" />
    </>
  ),

  'status-active': (
    <>
      <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />
      <path d="M13 8A5 5 0 0 0 8 3" />
    </>
  ),
  'status-queued': (
    <>
      <path d="M3.5 4.2h9" strokeDasharray="2.2 2.2" />
      <path d="M3.5 8h9M3.5 11.8h9" />
    </>
  ),
  'status-completed': (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.6 8.2 7.3 9.9 10.5 6.3" />
    </>
  ),
  'status-failed': (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.2 6.2l3.6 3.6M9.8 6.2l-3.6 3.6" />
    </>
  ),
  'status-awaiting': (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M6.8 6v4M9.2 6v4" />
    </>
  ),
  'status-degraded': (
    <>
      <path d="M8 2.6 13.4 8 8 13.4 2.6 8z" />
      <path d="M8 13.4 13.4 8 8 2.6z" fill="currentColor" stroke="none" />
    </>
  ),
  'status-offline': (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M4.6 11.4 11.4 4.6" />
    </>
  ),
  'status-neutral': (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M5.9 8h4.2" />
    </>
  ),

  'chevron-down': <path d="M4.6 6.4 8 9.9l3.4-3.5" />,
  'chevron-up': <path d="M4.6 9.6 8 6.1l3.4 3.5" />,
  'chevron-right': <path d="M6.4 4.6 9.9 8l-3.5 3.4" />,
  'chevron-left': <path d="M9.6 4.6 6.1 8l3.5 3.4" />,
  'arrow-right': <path d="M3 8h9.4M9.4 4.6 12.9 8l-3.5 3.4" />,
  check: <path d="M3.4 8.5 6.3 11.4 12.6 4.8" />,
  x: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  warning: (
    <>
      <path d="M8 2.7 14 13H2z" />
      <path d="M8 6.4v3.1" />
      <circle cx="8" cy="11.3" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  info: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 7.2v3.6" />
      <circle cx="8" cy="5.4" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  refresh: (
    <>
      <path d="M13.2 8a5.2 5.2 0 1 1-1.7-3.9" />
      <path d="M13.2 2.9v3.5h-3.5" />
    </>
  ),
  copy: (
    <>
      <rect x="5.6" y="5.6" width="7" height="7" rx="1" />
      <path d="M10.4 5.6V3.6a.8.8 0 0 0-.8-.8H3.4a.8.8 0 0 0-.8.8v6.2c0 .4.4.8.8.8h2" />
    </>
  ),
  external: (
    <>
      <path d="M9.6 2.9h3.5v3.5M12.9 2.9 7.6 8.2" />
      <path d="M11.8 9.6v3.2H3.2V3.4h3.2" />
    </>
  ),
  lock: (
    <>
      <rect x="4.2" y="7" width="7.6" height="6.1" rx="1" />
      <path d="M6 7V5.3a2 2 0 0 1 4 0V7" />
    </>
  ),
  search: (
    <>
      <circle cx="7.4" cy="7.4" r="4.1" />
      <path d="M10.4 10.4 13.4 13.4" />
    </>
  ),
  'more-horizontal': (
    <>
      <circle cx="3.4" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="8" cy="8" r="0.9" fill="currentColor" stroke="none" />
      <circle cx="12.6" cy="8" r="0.9" fill="currentColor" stroke="none" />
    </>
  ),
  plus: <path d="M8 3.2v9.6M3.2 8h9.6" />,
  dot: <circle cx="8" cy="8" r="2.6" fill="currentColor" stroke="none" />,
  stop: <rect x="4.6" y="4.6" width="6.8" height="6.8" rx="1" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 4.8V8l2.4 1.7" />
    </>
  ),
  rail: <path d="M2.6 4.2h10.8M2.6 8h10.8M2.6 11.8h10.8" />,
  signout: (
    <>
      <path d="M6.2 3.4H3.4v9.2h2.8" />
      <path d="M9.2 5.6 11.6 8l-2.4 2.4M6.6 8h5" />
    </>
  ),
};

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'name'> {
  readonly name: IconName;
  /**
   * Optical size, authored — never a scaled copy of another size.
   * 16 is the dense-UI/table size and 20 the sidebar/header size (DESIGN.md §9);
   * 12 exists only for a glyph that sits inside a 12px pill or chip label, where
   * a 16px glyph would exceed the pill's own type size by 33%.
   */
  readonly size?: 12 | 16 | 20;
  /** Provide only for a standalone icon that carries meaning; otherwise the
   *  control that owns the icon supplies the accessible name. */
  readonly label?: string;
}

export function Icon({ name, size = 16, label, ...rest }: IconProps) {
  const decorative = label === undefined;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={decorative ? true : undefined}
      role={decorative ? undefined : 'img'}
      focusable="false"
      {...rest}
    >
      {label !== undefined ? <title>{label}</title> : null}
      {PATHS[name]}
    </svg>
  );
}
