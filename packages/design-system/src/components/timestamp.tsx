import { timestampParts } from '../lib/format';

/**
 * `<time datetime>` with an accessible absolute value (DESIGN.md §5.3, §12.3).
 *
 * Lists show relative time (`3m ago`); audit surfaces show absolute time only.
 * Both carry the full timestamp: `title` for a pointer, `aria-label` for a
 * screen reader. `now` is passed in rather than read from the clock so that a
 * whole refresh renders consistent ages and hydration cannot disagree.
 */
export interface TimestampProps {
  readonly iso: string;
  readonly mode?: 'relative' | 'absolute';
  /** Reference instant for relative output. Defaults to the current clock. */
  readonly now?: number;
  readonly className?: string;
}

export function Timestamp({ iso, mode = 'relative', now, className }: TimestampProps) {
  const parts = timestampParts(iso, now);
  const visible = mode === 'absolute' ? parts.absolute : parts.text;
  const needsSpokenForm = visible !== parts.accessibleLabel;
  return (
    <time className={className} dateTime={parts.dateTime} title={parts.absolute}>
      {needsSpokenForm ? (
        <>
          {/*
           * `aria-label` on a `<time>` (no role) is not reliably announced — axe
           * reports it as `aria-prohibited-attr`. The spoken absolute value is
           * therefore real text, and the visual short form is hidden from AT so
           * the value is announced once, in full.
           */}
          <span className="iz-sr-only">{parts.accessibleLabel}</span>
          <span aria-hidden="true">{visible}</span>
        </>
      ) : (
        visible
      )}
    </time>
  );
}
