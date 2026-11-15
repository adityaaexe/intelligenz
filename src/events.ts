/**
 * The event vocabulary a journal may contain.
 *
 * This is deliberately small and closed: a journal that accepts arbitrary
 * event names cannot be validated or replayed meaningfully.
 */
export const EVENT_TYPES = [
  'run.start',
  'agent.spawn',
  'agent.message',
  'tool.call',
  'tool.result',
  'decision',
  'run.error',
  'run.end',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export type Payload = Record<string, unknown>;

export interface JournalEntry {
  /** Zero-based, strictly increasing position in the journal. */
  readonly seq: number;
  /** ISO-8601 timestamp recorded at append time. */
  readonly ts: string;
  readonly type: EventType;
  readonly payload: Payload;
  /** Hash of the previous entry, or GENESIS_HASH for the first. */
  readonly prev: string;
  /** Hash of this entry's content including `prev`. */
  readonly hash: string;
}

const EVENT_TYPE_SET: ReadonlySet<string> = new Set(EVENT_TYPES);

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && EVENT_TYPE_SET.has(value);
}

export function assertPlainObject(value: unknown, label: string): Payload {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${label} must be a plain object`);
  }
  return value as Payload;
}
