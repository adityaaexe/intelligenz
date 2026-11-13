/**
 * Status vocabulary — the single mapping from a wire value to a visual encoder.
 *
 * DESIGN.md §4.4: seven operational states, fixed vocabulary, each shipping a
 * glyph, an always-present text label, and a colour pair. Colour is the third
 * channel, never the only one. This module is what makes that enforceable:
 * a caller cannot render a status without a tone *and* a label, and an unknown
 * wire value degrades to a visible, labelled `neutral` state instead of an
 * unstyled blank.
 */

export type StatusTone =
  | 'active'
  | 'queued'
  | 'completed'
  | 'failed'
  | 'awaiting'
  | 'degraded'
  | 'offline'
  | 'neutral';

export type GlyphName =
  | 'status-active'
  | 'status-queued'
  | 'status-completed'
  | 'status-failed'
  | 'status-awaiting'
  | 'status-degraded'
  | 'status-offline'
  | 'status-neutral';

export interface StatusDescriptor {
  readonly tone: StatusTone;
  readonly label: string;
  readonly glyph: GlyphName;
}

/**
 * `TaskStatus` (lower-case) and `ApprovalStatus` (upper-case) are both accepted
 * because both appear in the Overview. The identity enums are upper-case in the
 * storage contract, the workflow enums lower-case — that asymmetry is in the
 * wire contract, not something the UI may normalise away.
 */
const DESCRIPTORS: Readonly<Record<string, StatusDescriptor>> = {
  // Task state machine (contract §6)
  draft: { tone: 'queued', label: 'Draft', glyph: 'status-queued' },
  ready: { tone: 'queued', label: 'Ready', glyph: 'status-queued' },
  queued: { tone: 'queued', label: 'Queued', glyph: 'status-queued' },
  running: { tone: 'active', label: 'Running', glyph: 'status-active' },
  verifying: { tone: 'active', label: 'Verifying', glyph: 'status-active' },
  succeeded: { tone: 'completed', label: 'Completed', glyph: 'status-completed' },
  failed: { tone: 'failed', label: 'Failed', glyph: 'status-failed' },
  blocked: { tone: 'awaiting', label: 'Blocked', glyph: 'status-awaiting' },
  cancelled: { tone: 'offline', label: 'Cancelled', glyph: 'status-offline' },

  // RunStatus extras (agent runtime)
  timed_out: { tone: 'failed', label: 'Timed out', glyph: 'status-failed' },

  // ApprovalStatus
  PENDING: { tone: 'awaiting', label: 'Awaiting approval', glyph: 'status-awaiting' },
  APPROVED: { tone: 'completed', label: 'Approved', glyph: 'status-completed' },
  REJECTED: { tone: 'failed', label: 'Rejected', glyph: 'status-failed' },
  CHANGES_REQUESTED: {
    tone: 'awaiting',
    label: 'Changes requested',
    glyph: 'status-awaiting',
  },

  // Dependency health (`GET /health/ready`)
  up: { tone: 'completed', label: 'Up', glyph: 'status-completed' },
  down: { tone: 'failed', label: 'Down', glyph: 'status-failed' },
};

const TONE_GLYPHS: Readonly<Record<StatusTone, GlyphName>> = {
  active: 'status-active',
  queued: 'status-queued',
  completed: 'status-completed',
  failed: 'status-failed',
  awaiting: 'status-awaiting',
  degraded: 'status-degraded',
  offline: 'status-offline',
  neutral: 'status-neutral',
};

/** `CHANGES_REQUESTED` → `changes requested`; a label, never a raw enum dump. */
function humanise(value: string): string {
  const spaced = value.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Unknown values are labelled, not hidden. A consumer must tolerate unknown
 * `eventType`/status values (contract §7); the UI does the same rather than
 * rendering an empty pill.
 */
export function describeStatus(status: string): StatusDescriptor {
  const known = DESCRIPTORS[status];
  if (known !== undefined) {
    return known;
  }
  const lower = status.toLowerCase();
  const knownLower = DESCRIPTORS[lower];
  if (knownLower !== undefined) {
    return knownLower;
  }
  return { tone: 'neutral', label: humanise(status), glyph: TONE_GLYPHS.neutral };
}

export function glyphForTone(tone: StatusTone): GlyphName {
  return TONE_GLYPHS[tone];
}

export const STATUS_TONES: readonly StatusTone[] = [
  'active',
  'queued',
  'completed',
  'failed',
  'awaiting',
  'degraded',
  'offline',
  'neutral',
];
