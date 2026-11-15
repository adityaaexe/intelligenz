import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { canonical, GENESIS_HASH } from '../src/hash.js';
import { Journal, parseJournal, verifyJournal } from '../src/journal.js';

function tempPath(name = 'run.jsonl'): string {
  return join(mkdtempSync(join(tmpdir(), 'intelligenz-')), name);
}

function buildJournal(count = 3): Journal {
  const journal = Journal.create(tempPath());
  for (let index = 0; index < count; index += 1) {
    journal.append('tool.call', { index, tool: 'search' }, '2026-01-01T00:00:00.000Z');
  }
  return journal;
}

/** Rewrite one line of a journal file in place. */
function rewriteLine(path: string, lineIndex: number, mutate: (row: Record<string, unknown>) => void): void {
  const lines = readFileSync(path, 'utf8').trimEnd().split('\n');
  const row = JSON.parse(lines[lineIndex] ?? '{}') as Record<string, unknown>;
  mutate(row);
  lines[lineIndex] = JSON.stringify(row);
  writeFileSync(path, `${lines.join('\n')}\n`, 'utf8');
}

test('appends entries and keeps a verifiable chain', () => {
  const journal = buildJournal();

  assert.equal(journal.entries().length, 3);
  assert.equal(journal.entries()[0]?.prev, GENESIS_HASH);
  assert.equal(journal.entries()[1]?.prev, journal.entries()[0]?.hash);

  const result = verifyJournal(journal.path);
  assert.equal(result.ok, true);
  assert.equal(result.count, 3);
});

test('seq starts at zero and increases by one', () => {
  const journal = buildJournal();
  assert.deepEqual(journal.entries().map((entry) => entry.seq), [0, 1, 2]);
});

test('reopening continues the chain instead of restarting it', () => {
  const journal = buildJournal(2);
  const reopened = Journal.open(journal.path);
  const entry = reopened.append('run.end', { reason: 'done' });

  assert.equal(entry.seq, 2);
  assert.equal(entry.prev, journal.entries()[1]?.hash);
  assert.equal(verifyJournal(journal.path).ok, true);
});

test('detects a tampered payload', () => {
  const journal = buildJournal();
  rewriteLine(journal.path, 1, (row) => {
    row['payload'] = { index: 99, tool: 'search' };
  });

  const result = verifyJournal(journal.path);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 1);
  assert.match(result.error ?? '', /hash does not match/);
});

test('detects a tampered timestamp', () => {
  const journal = buildJournal();
  rewriteLine(journal.path, 0, (row) => {
    row['ts'] = '1999-01-01T00:00:00.000Z';
  });

  assert.equal(verifyJournal(journal.path).ok, false);
});

test('detects a deleted entry', () => {
  const journal = buildJournal(3);
  const lines = readFileSync(journal.path, 'utf8').trimEnd().split('\n');
  writeFileSync(journal.path, `${[lines[0], lines[2]].join('\n')}\n`, 'utf8');

  const result = verifyJournal(journal.path);
  assert.equal(result.ok, false);
  assert.equal(result.brokenAt, 2);
  assert.match(result.error ?? '', /expected seq/);
});

test('detects reordered entries', () => {
  const journal = buildJournal(3);
  const lines = readFileSync(journal.path, 'utf8').trimEnd().split('\n');
  const reordered = [lines[0], lines[2], lines[1]].join('\n');
  writeFileSync(journal.path, `${reordered}\n`, 'utf8');

  assert.equal(verifyJournal(journal.path).ok, false);
});

test('refuses to open an unverified journal', () => {
  const journal = buildJournal();
  rewriteLine(journal.path, 0, (row) => {
    row['type'] = 'run.end';
  });

  assert.throws(() => Journal.open(journal.path), /unverified journal/);
});

test('refuses to clobber an existing journal unless forced', () => {
  const journal = buildJournal();
  assert.throws(() => Journal.create(journal.path), /already exists/);
  assert.equal(Journal.create(journal.path, { force: true }).entries().length, 0);
});

test('rejects payloads that are not plain objects', () => {
  const journal = Journal.create(tempPath());
  assert.throws(() => journal.append('tool.call', [] as unknown as Record<string, unknown>), /plain object/);
});

test('canonical serialisation is insensitive to key order', () => {
  assert.equal(canonical({ a: 1, b: { c: 2, d: 3 } }), canonical({ b: { d: 3, c: 2 }, a: 1 }));
});

test('blank lines are ignored when parsing', () => {
  const journal = buildJournal(2);
  writeFileSync(journal.path, `${readFileSync(journal.path, 'utf8')}\n\n`, 'utf8');

  assert.equal(parseJournal(readFileSync(journal.path, 'utf8')).length, 2);
  assert.equal(verifyJournal(journal.path).ok, true);
});
