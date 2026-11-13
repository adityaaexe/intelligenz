import { describe, expect, it } from 'vitest';

import {
  durationBetween,
  formatAbsoluteUtc,
  formatCost,
  formatCount,
  formatDuration,
  formatRelative,
  formatTokenCount,
  timestampParts,
} from './format';

/**
 * DESIGN.md §5.3 is a specification, not a preference. These cases are the spec
 * transcribed: a `00:14:22` duration or a `1193562` token count is a defect.
 *
 * No DOM is involved, so no renderer is needed (`@testing-library/react` is not
 * in this workspace's lockfile — see the report).
 */
describe('formatDuration', () => {
  it('renders sub-second as milliseconds', () => {
    expect(formatDuration(412)).toBe('412ms');
  });

  it('renders under a minute with one decimal', () => {
    expect(formatDuration(8_400)).toBe('8.4s');
  });

  it('renders minutes and zero-padded seconds', () => {
    expect(formatDuration(14 * 60_000 + 22_000)).toBe('14m 22s');
    expect(formatDuration(6 * 60_000 + 8_000)).toBe('6m 08s');
  });

  it('renders hours with zero-padded minutes and never a clock face', () => {
    expect(formatDuration(3_600_000 + 4 * 60_000)).toBe('1h 04m');
    expect(formatDuration(14 * 60_000 + 22_000)).not.toContain(':');
  });

  it('renders a missing duration as an em dash, not zero', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(undefined)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
  });
});

describe('durationBetween', () => {
  it('subtracts two ISO timestamps', () => {
    expect(durationBetween('2026-11-13T04:04:00.000Z', '2026-11-13T04:06:08.000Z')).toBe('2m 08s');
  });

  it('returns an em dash when either side is null', () => {
    expect(durationBetween(null, '2026-11-13T04:06:08.000Z')).toBe('—');
    expect(durationBetween('2026-11-13T04:04:00.000Z', null)).toBe('—');
  });
});

describe('formatTokenCount', () => {
  it('keeps small counts exact', () => {
    expect(formatTokenCount(942)).toBe('942');
  });

  it('uses one decimal in the thousands', () => {
    expect(formatTokenCount(1_562)).toBe('1.6k');
    expect(formatTokenCount(184_300)).toBe('184k');
  });

  it('uses two decimals in the millions', () => {
    expect(formatTokenCount(1_420_000)).toBe('1.42M');
  });

  it('never renders a raw seven-digit integer', () => {
    expect(formatTokenCount(1_193_562)).not.toBe('1193562');
  });
});

describe('formatCost', () => {
  it('uses two decimals from a cent upwards', () => {
    expect(formatCost(2.14)).toBe('$2.14');
    expect(formatCost('0.44')).toBe('$0.44');
    expect(formatCost(0.61)).toBe('$0.61');
  });

  it('keeps four decimals below a cent so a real cost never reads $0.00', () => {
    expect(formatCost(0.0083)).toBe('$0.0083');
  });

  it('renders a genuine zero as $0.00', () => {
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost('0')).toBe('$0.00');
  });

  it('renders an absent cost as an em dash', () => {
    expect(formatCost(null)).toBe('—');
    expect(formatCost(undefined)).toBe('—');
    expect(formatCost('')).toBe('—');
  });
});

describe('formatCount', () => {
  it('groups thousands', () => {
    expect(formatCount(1_165)).toBe('1,165');
    expect(formatCount(1_257_000)).toBe('1,257,000');
    expect(formatCount(14)).toBe('14');
  });
});

describe('formatRelative', () => {
  const now = Date.parse('2026-11-13T04:20:00.000Z');

  it('renders minutes', () => {
    expect(formatRelative('2026-11-13T04:17:00.000Z', now)).toBe('3m ago');
  });

  it('renders hours and padded minutes', () => {
    expect(formatRelative('2026-11-13T03:16:00.000Z', now)).toBe('1h 04m ago');
  });

  it('renders days', () => {
    expect(formatRelative('2026-11-11T04:20:00.000Z', now)).toBe('2d ago');
  });

  it('renders a very recent value as just now', () => {
    expect(formatRelative('2026-11-13T04:19:50.000Z', now)).toBe('just now');
  });
});

describe('formatAbsoluteUtc', () => {
  it('renders the audit format', () => {
    expect(formatAbsoluteUtc('2026-11-13T04:18:22.000Z')).toBe('2026-11-13 04:18:22Z');
  });

  it('renders an invalid date as an em dash', () => {
    expect(formatAbsoluteUtc('not-a-date')).toBe('—');
  });
});

describe('timestampParts', () => {
  it('pairs the relative text with an absolute accessible label', () => {
    const parts = timestampParts('2026-11-13T04:17:00.000Z', Date.parse('2026-11-13T04:20:00.000Z'));
    expect(parts.text).toBe('3m ago');
    expect(parts.absolute).toBe('2026-11-13 04:17:00Z');
    expect(parts.accessibleLabel).toBe('2026-11-13 04:17:00Z UTC');
    expect(parts.dateTime).toBe('2026-11-13T04:17:00.000Z');
  });
});
