import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { assertPlainObject, isEventType, type EventType, type JournalEntry, type Payload } from './events.js';
import { computeHash, GENESIS_HASH } from './hash.js';

export interface VerifyResult {
  readonly ok: boolean;
  readonly count: number;
  readonly error?: string;
  readonly brokenAt?: number;
}

/**
 * Parse newline-delimited JSON into entries. Blank lines are ignored so that a
 * trailing newline does not produce a phantom entry.
 */
export function parseJournal(raw: string): JournalEntry[] {
  const entries: JournalEntry[] = [];
  const lines = raw.split('\n');

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;

    let decoded: unknown;
    try {
      decoded = JSON.parse(line);
    } catch {
      throw new Error(`invalid JSON on line ${index + 1}`);
    }

    const record = assertPlainObject(decoded, `line ${index + 1}`);
    if (!isEventType(record['type'])) {
      throw new Error(`unknown event type on line ${index + 1}`);
    }

    entries.push({
      seq: Number(record['seq']),
      ts: String(record['ts']),
      type: record['type'],
      payload: assertPlainObject(record['payload'], `line ${index + 1} payload`),
      prev: String(record['prev']),
      hash: String(record['hash']),
    });
  }

  return entries;
}

/**
 * Recompute the whole chain and report the first inconsistency.
 *
 * Detects: edited payloads, edited timestamps, edited event types, deleted
 * entries, inserted entries, and reordered entries.
 */
export function verifyJournal(path: string): VerifyResult {
  const entries = parseJournal(readFileSync(path, 'utf8'));
  let previousHash = GENESIS_HASH;

  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;

    if (entry.seq !== index) {
      return {
        ok: false,
        count: entries.length,
        brokenAt: entry.seq,
        error: `expected seq ${index}, found ${entry.seq}`,
      };
    }

    if (entry.prev !== previousHash) {
      return {
        ok: false,
        count: entries.length,
        brokenAt: entry.seq,
        error: 'prev hash does not link to the previous entry',
      };
    }

    const expected = computeHash({
      prev: entry.prev,
      seq: entry.seq,
      type: entry.type,
      ts: entry.ts,
      payload: entry.payload,
    });

    if (expected !== entry.hash) {
      return {
        ok: false,
        count: entries.length,
        brokenAt: entry.seq,
        error: 'entry hash does not match its content',
      };
    }

    previousHash = entry.hash;
  }

  return { ok: true, count: entries.length };
}

/**
 * Append-only writer. Each `append` extends the hash chain and flushes a single
 * line to disk, so a crash mid-run leaves a truncatable prefix rather than a
 * corrupt file.
 */
export class Journal {
  readonly path: string;

  #lastHash: string = GENESIS_HASH;
  #nextSeq = 0;
  #entries: JournalEntry[] = [];

  private constructor(path: string) {
    this.path = path;
  }

  /** Start a new, empty journal. Refuses to clobber unless `force` is set. */
  static create(path: string, options: { force?: boolean } = {}): Journal {
    if (existsSync(path) && options.force !== true) {
      throw new Error(`journal already exists: ${path}`);
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '', 'utf8');
    return new Journal(path);
  }

  /** Reopen an existing journal, continuing its chain. Refuses corrupt files. */
  static open(path: string): Journal {
    if (!existsSync(path)) {
      throw new Error(`journal not found: ${path}`);
    }

    const check = verifyJournal(path);
    if (!check.ok) {
      throw new Error(`refusing to open unverified journal (${check.error} at seq ${check.brokenAt})`);
    }

    const journal = new Journal(path);
    journal.#entries = parseJournal(readFileSync(path, 'utf8'));
    const last = journal.#entries.at(-1);
    if (last !== undefined) {
      journal.#lastHash = last.hash;
      journal.#nextSeq = last.seq + 1;
    }
    return journal;
  }

  append(type: EventType, payload: Payload, ts: string = new Date().toISOString()): JournalEntry {
    if (!isEventType(type)) {
      throw new TypeError(`unknown event type: ${String(type)}`);
    }
    assertPlainObject(payload, 'payload');

    const seq = this.#nextSeq;
    const hash = computeHash({ prev: this.#lastHash, seq, type, ts, payload });
    const entry: JournalEntry = { seq, ts, type, payload, prev: this.#lastHash, hash };

    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, 'utf8');

    this.#entries.push(entry);
    this.#lastHash = hash;
    this.#nextSeq = seq + 1;

    return entry;
  }

  entries(): readonly JournalEntry[] {
    return this.#entries;
  }

  verify(): VerifyResult {
    return verifyJournal(this.path);
  }
}
