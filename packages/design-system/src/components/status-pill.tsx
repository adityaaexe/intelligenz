import { Icon } from './icon';
import { describeStatus, glyphForTone } from '../lib/status';
import type { StatusTone } from '../lib/status';

/**
 * Status is encoded three ways — colour, glyph, and text — and the text is
 * always present (DESIGN.md §4.4, §12.3).
 *
 * Accessibility: the accessible name is `Status: Running`, never `Running`
 * alone, via a visually hidden prefix. A greyscale screenshot still reads
 * correctly, and so does a screen reader.
 */
export interface StatusPillProps {
  /** Any wire status. Unknown values render as a labelled neutral state. */
  readonly status: string;
  /** Override the vocabulary label without changing the tone. */
  readonly label?: string;
  /** Render with the degraded stem regardless of the mapped tone. */
  readonly tone?: StatusTone;
  readonly size?: 'sm' | 'md';
  readonly className?: string;
}

export function StatusPill({ status, label, tone, size = 'md', className }: StatusPillProps) {
  const descriptor = describeStatus(status);
  const resolvedTone = tone ?? descriptor.tone;
  const text = label ?? descriptor.label;
  return (
    <span
      className={['iz-pill', className].filter(Boolean).join(' ')}
      data-tone={resolvedTone}
      data-size={size}
    >
      <Icon className="iz-pill__glyph" name={glyphForTone(resolvedTone)} size={12} />
      <span className="iz-pill__label">
        <span className="iz-sr-only">Status: </span>
        {text}
      </span>
    </span>
  );
}
