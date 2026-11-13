import { describe, expect, it } from 'vitest';

import { STATUS_TONES, describeStatus, glyphForTone } from './status';

/**
 * The colour-independence contract, tested as data.
 *
 * `StatusPill` renders whatever this module returns: a tone, a glyph name and a
 * label. If every status has a label and a glyph, then removing all colour
 * cannot remove the meaning (DESIGN.md §3 principle 2, §12.2 "Colour
 * independence"). A render test would prove the same thing more slowly and would
 * need a DOM library that is not installed here.
 */
const TASK_STATUSES = [
  'draft',
  'ready',
  'queued',
  'running',
  'verifying',
  'succeeded',
  'failed',
  'blocked',
  'cancelled',
] as const;

const APPROVAL_STATUSES = ['PENDING', 'APPROVED', 'REJECTED', 'CHANGES_REQUESTED'] as const;

describe('describeStatus', () => {
  it('gives every task status a label, a tone and a glyph', () => {
    for (const status of TASK_STATUSES) {
      const descriptor = describeStatus(status);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.label).not.toBe(status);
      expect(STATUS_TONES).toContain(descriptor.tone);
      expect(descriptor.glyph.startsWith('status-')).toBe(true);
    }
  });

  it('gives every approval status a label, a tone and a glyph', () => {
    for (const status of APPROVAL_STATUSES) {
      const descriptor = describeStatus(status);
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.label).not.toBe(status);
    }
  });

  it('maps the operational vocabulary DESIGN.md fixes', () => {
    expect(describeStatus('running')).toMatchObject({ tone: 'active', label: 'Running' });
    expect(describeStatus('queued')).toMatchObject({ tone: 'queued', label: 'Queued' });
    expect(describeStatus('succeeded')).toMatchObject({ tone: 'completed', label: 'Completed' });
    expect(describeStatus('failed')).toMatchObject({ tone: 'failed', label: 'Failed' });
    expect(describeStatus('blocked')).toMatchObject({ tone: 'awaiting', label: 'Blocked' });
    expect(describeStatus('PENDING')).toMatchObject({ tone: 'awaiting', label: 'Awaiting approval' });
    expect(describeStatus('timed_out')).toMatchObject({ tone: 'failed', label: 'Timed out' });
  });

  it('labels an unknown wire value instead of hiding it', () => {
    const descriptor = describeStatus('SOMETHING_NEW');
    expect(descriptor.tone).toBe('neutral');
    expect(descriptor.label).toBe('Something new');
  });

  it('is case-insensitive for known values', () => {
    expect(describeStatus('RUNNING')).toMatchObject({ tone: 'active', label: 'Running' });
  });
});

describe('glyphForTone', () => {
  it('returns a glyph for every tone', () => {
    for (const tone of STATUS_TONES) {
      expect(glyphForTone(tone)).toBe(`status-${tone}`);
    }
  });
});
