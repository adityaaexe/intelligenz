import type { Metadata, Viewport } from 'next';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: {
    default: 'INTELLIGENZ Control Centre',
    template: '%s · INTELLIGENZ',
  },
  description:
    'Operational control centre: system posture, approvals, agent runs and spend in one scan.',
  applicationName: 'INTELLIGENZ',
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

/**
 * Light canvas is the document; dark is the on-call override (DESIGN.md §4.8),
 * selected by `:root[data-theme="dark"]`. Phase 2 ships no theme switcher, so no
 * attribute is set and the canvas theme applies — the dark block in `tokens.css`
 * is ready for the unit that adds the control.
 */
export default function RootLayout({ children }: { readonly children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
