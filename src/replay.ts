import { readFileSync } from 'node:fs';

import type { EventType, JournalEntry } from './events.js';
import { parseJournal, verifyJournal } from './journal.js';

export type EventHandler = (entry: JournalEntry) => void | Promise<void>;

export interface ReplayHandlers {
  /** Receives every event, in order, before the type-specific handler. */
  readonly '*'?: EventHandler;
}

export type ReplayHandlerMap = ReplayHandlers & Partial<Record<EventType, EventHandler>>;

export interface ReplayResult {
  readonly events: number;
  readonly durationMs: number;
}

/**
 * Re-drive a recorded run through handlers, in recorded order.
 *
 * The journal is verified first: replaying an unverified journal would let a
 * tampered history masquerade as ground truth.
 */
export async function replay(path: string, handlers: ReplayHandlerMap): Promise<ReplayResult> {
  const check = verifyJournal(path);
  if (!check.ok) {
    throw new Error(`refusing to replay unverified journal: ${check.error} at seq ${check.brokenAt}`);
  }

  const entries = parseJournal(readFileSync(path, 'utf8'));
  const startedAt = Date.now();

  for (const entry of entries) {
    await handlers['*']?.(entry);
    await handlers[entry.type]?.(entry);
  }

  return { events: entries.length, durationMs: Date.now() - startedAt };
}
