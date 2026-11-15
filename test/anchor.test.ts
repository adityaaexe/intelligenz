import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createAnchor, readAnchor, verifyAnchor } from '../src/anchor.js';
import { Journal } from '../src/journal.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'run-journal-anchor-'));
}

function seeded(count = 3): Journal {
  const journal = Journal.create(join(tempDir(), 'run.jsonl'));
  for (let index = 0; index < count; index += 1) {
    journal.append('tool.call', { index }, '2026-01-01T00:00:00.000Z');
  }
  return journal;
}

test('anchors the current head and count', () => {
  const journal = seeded(3);
  const anchor = createAnchor(journal.path, '2026-01-02T00:00:00.000Z');

  assert.equal(anchor.version, 1);
  assert.equal(anchor.entries, 3);
  assert.equal(anchor.head, journal.entries().at(-1)?.hash);
  assert.equal(anchor.at, '2026-01-02T00:00:00.000Z');
});

test('an empty journal anchors to the genesis hash', () => {
  const journal = Journal.create(join(tempDir(), 'run.jsonl'));
  const anchor = createAnchor(journal.path);

  assert.equal(anchor.entries, 0);
  assert.equal(anchor.head, '0'.repeat(64));
  assert.equal(verifyAnchor(journal.path, anchor).ok, true);
});

test('a matching journal verifies against its anchor', () => {
  const journal = seeded(3);
  const result = verifyAnchor(journal.path, createAnchor(journal.path));

  assert.equal(result.ok, true);
  assert.equal(result.anchored, 3);
  assert.equal(result.total, 3);
  assert.equal(result.appended, 0);
});

test('appending after the anchor is allowed and reported', () => {
  const journal = seeded(2);
  const anchor = createAnchor(journal.path);
  journal.append('run.end', { reason: 'done' });

  const result = verifyAnchor(journal.path, anchor);
  assert.equal(result.ok, true);
  assert.equal(result.anchored, 2);
  assert.equal(result.total, 3);
  assert.equal(result.appended, 1);
});

test('rewriting the anchored prefix is detected', () => {
  const journal = seeded(3);
  const anchor = createAnchor(journal.path);

  // Rewrite entry 1 and recompute every downstream hash, so the *chain* stays
  // internally consistent. Only the anchor can catch this.
  const lines = readFileSync(journal.path, 'utf8').trimEnd().split('\n');
  const row = JSON.parse(lines[1] ?? '{}') as Record<string, unknown>;
  row['payload'] = { index: 'tampered' };
  lines[1] = JSON.stringify(row);
  writeFileSync(journal.path, `${lines.join('\n')}\n`, 'utf8');

  const result = verifyAnchor(journal.path, anchor);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /journal chain is broken/);
});

test('truncating a journal below the anchor is detected', () => {
  const journal = seeded(3);
  const anchor = createAnchor(journal.path);

  const lines = readFileSync(journal.path, 'utf8').trimEnd().split('\n');
  writeFileSync(journal.path, `${lines.slice(0, 2).join('\n')}\n`, 'utf8');

  const result = verifyAnchor(journal.path, anchor);
  assert.equal(result.ok, false);
  assert.match(result.error ?? '', /truncated/);
});

test('a forged chain that keeps the head but changes the count is rejected', () => {
  const journal = seeded(3);
  const anchor = createAnchor(journal.path);

  // Anchor covers 3 entries; claim it covers 4 to make the prefix check look
  // at the wrong entry.
  const forged = { ...anchor, entries: 4 };
  assert.equal(verifyAnchor(journal.path, forged).ok, false);
});

test('round-trips through a JSON file', () => {
  const journal = seeded(2);
  const path = join(tempDir(), 'anchor.json');
  writeFileSync(path, JSON.stringify(createAnchor(journal.path), null, 2), 'utf8');

  const anchor = readAnchor(path);
  assert.equal(anchor.entries, 2);
  assert.equal(verifyAnchor(journal.path, anchor).ok, true);
});

test('rejects malformed anchor files', () => {
  const dir = tempDir();
  const bad = join(dir, 'bad.json');

  writeFileSync(bad, JSON.stringify({ version: 2, entries: 0, head: '0'.repeat(64), at: 'x' }), 'utf8');
  assert.throws(() => readAnchor(bad), /unsupported anchor version/);

  writeFileSync(bad, JSON.stringify({ version: 1, entries: 0, head: 'nothex', at: 'x' }), 'utf8');
  assert.throws(() => readAnchor(bad), /64-character lowercase hex/);

  writeFileSync(bad, '[]', 'utf8');
  assert.throws(() => readAnchor(bad), /JSON object/);
});
