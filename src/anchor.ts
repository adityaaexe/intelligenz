import { existsSync, readFileSync } from 'node:fs';

import { GENESIS_HASH } from './hash.js';
import { parseJournal, verifyJournal } from './journal.js';

/**
 * A small, publishable record of a journal's head at a point in time.
 *
 * The anchor is what turns a self-consistent hash chain into evidence: a chain
 * can always be recomputed from scratch, but a head hash published somewhere
 * else cannot be rewritten without also rewriting that somewhere else.
 */
export interface Anchor {
  readonly version: 1;
  /** How many entries the anchor covers, counted from seq 0. */
  readonly entries: number;
  /** Hash of entry `entries - 1`, or GENESIS_HASH when `entries` is 0. */
  readonly head: string;
  /** ISO-8601 timestamp recorded when the anchor was created. */
  readonly at: string;
}

export interface AnchorVerifyResult {
  readonly ok: boolean;
  readonly anchored: number;
  readonly total: number;
  /** Entries appended after the anchor was taken. Growth is allowed. */
  readonly appended: number;
  readonly error?: string;
}

/**
 * Build an anchor covering every entry currently in the journal.
 *
 * Anchoring an empty journal is legal and yields the genesis head; it commits
 * to "nothing yet", which then detects any later attempt to backdate entries.
 */
export function createAnchor(path: string, at: string = new Date().toISOString()): Anchor {
  const check = verifyJournal(path);
  if (!check.ok) {
    throw new Error(`refusing to anchor unverified journal: ${check.error} at seq ${check.brokenAt}`);
  }

  const entries = parseJournal(readFileSync(path, 'utf8'));
  const head = entries.at(-1)?.hash ?? GENESIS_HASH;

  return { version: 1, entries: entries.length, head, at };
}

export function readAnchor(path: string): Anchor {
  if (!existsSync(path)) {
    throw new Error(`anchor not found: ${path}`);
  }

  const decoded: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (decoded === null || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new TypeError('anchor must be a JSON object');
  }

  const record = decoded as Record<string, unknown>;
  const entries = Number(record['entries']);

  if (record['version'] !== 1) throw new Error(`unsupported anchor version: ${String(record['version'])}`);
  if (!Number.isInteger(entries) || entries < 0) throw new Error('anchor.entries must be a non-negative integer');
  if (typeof record['head'] !== 'string' || !/^[0-9a-f]{64}$/.test(record['head'])) {
    throw new Error('anchor.head must be a 64-character lowercase hex digest');
  }
  if (typeof record['at'] !== 'string') throw new Error('anchor.at must be an ISO-8601 string');

  return { version: 1, entries, head: record['head'], at: record['at'] };
}

/**
 * Check a journal against an anchor.
 *
 * Additional entries after the anchored prefix are accepted — a run may
 * legitimately continue. Mutating, truncating, or rewriting any anchored entry
 * is not.
 */
export function verifyAnchor(path: string, anchor: Anchor): AnchorVerifyResult {
  const check = verifyJournal(path);
  if (!check.ok) {
    return {
      ok: false,
      anchored: anchor.entries,
      total: check.count,
      appended: Math.max(0, check.count - anchor.entries),
      error: `journal chain is broken: ${check.error} at seq ${check.brokenAt}`,
    };
  }

  const entries = parseJournal(readFileSync(path, 'utf8'));

  if (entries.length < anchor.entries) {
    return {
      ok: false,
      anchored: anchor.entries,
      total: entries.length,
      appended: 0,
      error: `journal has ${entries.length} entries but the anchor covers ${anchor.entries} (truncated)`,
    };
  }

  const coveredHead = anchor.entries === 0 ? GENESIS_HASH : (entries[anchor.entries - 1]?.hash ?? '');
  if (coveredHead !== anchor.head) {
    return {
      ok: false,
      anchored: anchor.entries,
      total: entries.length,
      appended: entries.length - anchor.entries,
      error: `anchored prefix was rewritten: entry ${anchor.entries - 1} hashes to ${coveredHead}`,
    };
  }

  return {
    ok: true,
    anchored: anchor.entries,
    total: entries.length,
    appended: entries.length - anchor.entries,
  };
}
