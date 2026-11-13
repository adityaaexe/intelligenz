/**
 * Display formatters. Pure functions, no DOM, unit-tested.
 *
 * These implement DESIGN.md §5.3 exactly, because a duration that renders
 * `00:14:22` or a token count that renders `1193562` is a defect in this
 * product, not a matter of taste.
 */

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

function pad2(value: number): string {
  return value < 10 ? `0${value}` : String(value);
}

/** `412ms` · `8.4s` · `14m 22s` · `1h 04m`. Never `00:14:22`. */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return '—';
  }
  if (ms < MS_PER_SECOND) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < MS_PER_MINUTE) {
    return `${(ms / MS_PER_SECOND).toFixed(1)}s`;
  }
  if (ms < MS_PER_HOUR) {
    const minutes = Math.floor(ms / MS_PER_MINUTE);
    const seconds = Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND);
    return `${minutes}m ${pad2(seconds)}s`;
  }
  const hours = Math.floor(ms / MS_PER_HOUR);
  const minutes = Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE);
  return `${hours}h ${pad2(minutes)}m`;
}

/** Elapsed time between two ISO timestamps, or `—` when either is missing. */
export function durationBetween(startIso: string | null, endIso: string | null): string {
  if (startIso === null || endIso === null) {
    return '—';
  }
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return '—';
  }
  return formatDuration(end - start);
}

/** `942` · `1.2k` · `184.3k` · `1.42M` — one decimal below a million. */
export function formatTokenCount(tokens: number | null | undefined): string {
  if (tokens === null || tokens === undefined || !Number.isFinite(tokens)) {
    return '—';
  }
  const value = Math.max(0, tokens);
  if (value < 1000) {
    return String(Math.round(value));
  }
  if (value < 1_000_000) {
    const thousands = value / 1000;
    return thousands >= 100 ? `${thousands.toFixed(0)}k` : `${thousands.toFixed(1)}k`;
  }
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * `$2.14` · `$0.44` · `$0.0083` · `$0.00`.
 *
 * Sub-cent costs keep four decimals so a real cost never renders as `$0.00`
 * (DESIGN.md §5.3). A genuine zero is `$0.00` and the caller is responsible for
 * labelling it as reported-by-a-simulated-runtime where that applies.
 */
export function formatCost(usd: number | string | null | undefined): string {
  if (usd === null || usd === undefined || usd === '') {
    return '—';
  }
  const value = typeof usd === 'string' ? Number.parseFloat(usd) : usd;
  if (!Number.isFinite(value)) {
    return '—';
  }
  const absolute = Math.abs(value);
  if (absolute === 0) {
    return '$0.00';
  }
  if (absolute < 0.01) {
    return `$${value.toFixed(4)}`;
  }
  return `$${value.toFixed(2)}`;
}

/** `1,165` — thousands separators, no locale dependency in output. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  let out = '';
  for (let index = 0; index < digits.length; index += 1) {
    const fromEnd = digits.length - index;
    out += digits[index];
    if (fromEnd > 1 && fromEnd % 3 === 1) {
      out += ',';
    }
  }
  return `${sign}${out}`;
}

/** `3m ago` · `1h 04m ago` · `2d ago`. Absolute value belongs in `title`. */
export function formatRelative(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) {
    return '—';
  }
  const delta = Math.max(0, now - then);
  if (delta < 45 * MS_PER_SECOND) {
    return 'just now';
  }
  if (delta < MS_PER_MINUTE) {
    return `${Math.round(delta / MS_PER_SECOND)}s ago`;
  }
  if (delta < MS_PER_HOUR) {
    return `${Math.floor(delta / MS_PER_MINUTE)}m ago`;
  }
  if (delta < MS_PER_DAY) {
    const hours = Math.floor(delta / MS_PER_HOUR);
    const minutes = Math.floor((delta % MS_PER_HOUR) / MS_PER_MINUTE);
    return `${hours}h ${pad2(minutes)}m ago`;
  }
  return `${Math.floor(delta / MS_PER_DAY)}d ago`;
}

/** `2026-11-13 04:18:22Z` — audit surfaces use absolute time only. */
export function formatAbsoluteUtc(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) {
    return '—';
  }
  const date = `${parsed.getUTCFullYear()}-${pad2(parsed.getUTCMonth() + 1)}-${pad2(parsed.getUTCDate())}`;
  const time = `${pad2(parsed.getUTCHours())}:${pad2(parsed.getUTCMinutes())}:${pad2(parsed.getUTCSeconds())}`;
  return `${date} ${time}Z`;
}

/**
 * A relative timestamp is the visible text; the absolute value is the accessible
 * name and the `title` (DESIGN.md §5.3). One helper so both agree.
 */
export function timestampParts(iso: string, now: number = Date.now()): {
  readonly text: string;
  readonly absolute: string;
  readonly dateTime: string;
  readonly accessibleLabel: string;
} {
  const parsed = new Date(iso);
  const absolute = formatAbsoluteUtc(iso);
  return {
    text: formatRelative(iso, now),
    absolute,
    dateTime: Number.isNaN(parsed.getTime()) ? iso : parsed.toISOString(),
    accessibleLabel: Number.isNaN(parsed.getTime()) ? 'Not reported' : `${absolute} UTC`,
  };
}
