import type { ReactNode } from 'react';

/**
 * Two tiny presentational helpers for one accessibility rule.
 *
 * `aria-label` on a `<span>` or `<time>` with no role is not reliably announced
 * (axe reports it as `aria-prohibited-attr`), so a value whose spoken form
 * differs from its visible form is rendered as a visually hidden string plus an
 * `aria-hidden` visual form. That is the pattern DESIGN.md §12.3 describes
 * ("`14m 22s` … plus a visually hidden expansion"), implemented as markup
 * instead of an attribute browsers may ignore.
 */

/** The visible glyph is `—`; the spoken value is "Not reported", never "zero". */
export function NotReported({ label = 'Not reported' }: { readonly label?: string }) {
  return (
    <>
      <span className="iz-sr-only">{label}</span>
      <span aria-hidden="true">—</span>
    </>
  );
}

/** A value read aloud in one form and shown in another (`16.4s` / "16 seconds"). */
export function SpokenValue({
  spoken,
  children,
}: {
  readonly spoken: string;
  readonly children: ReactNode;
}) {
  return (
    <>
      <span className="iz-sr-only">{spoken}</span>
      <span aria-hidden="true">{children}</span>
    </>
  );
}
