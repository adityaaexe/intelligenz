import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Journal } from '../src/journal.js';
import { replay } from '../src/replay.js';
import type { JournalEntry } from '../src/events.js';

function seeded(): Journal {
  const path = join(mkdtempSync(join(tmpdir(), 'intelligenz-replay-')), 'run.jsonl');
  const journal = Journal.create(path);
  journal.append('run.start', { goal: 'demo' }, '2026-01-01T00:00:00.000Z');
  journal.append('agent.spawn', { agent: 'researcher' }, '2026-01-01T00:00:01.000Z');
  journal.append('tool.call', { tool: 'search', query: 'x' }, '2026-01-01T00:00:02.000Z');
  journal.append('run.end', { reason: 'done' }, '2026-01-01T00:00:03.000Z');
  return journal;
}

test('replays every event in recorded order', async () => {
  const journal = seeded();
  const seen: string[] = [];

  const summary = await replay(journal.path, {
    '*': (entry: JournalEntry) => {
      seen.push(entry.type);
    },
  });

  assert.deepEqual(seen, ['run.start', 'agent.spawn', 'tool.call', 'run.end']);
  assert.equal(summary.events, 4);
});

test('dispatches to type-specific handlers', async () => {
  const journal = seeded();
  const tools: string[] = [];

  await replay(journal.path, {
    'tool.call': (entry) => {
      tools.push(String(entry.payload['tool']));
    },
  });

  assert.deepEqual(tools, ['search']);
});

test('awaits async handlers sequentially', async () => {
  const journal = seeded();
  const order: number[] = [];

  await replay(journal.path, {
    '*': async (entry) => {
      await Promise.resolve();
      order.push(entry.seq);
    },
  });

  assert.deepEqual(order, [0, 1, 2, 3]);
});

test('refuses to replay a tampered journal', async () => {
  const journal = seeded();
  const lines = readFileSync(journal.path, 'utf8').trimEnd().split('\n');
  const row = JSON.parse(lines[2] ?? '{}') as Record<string, unknown>;
  row['payload'] = { tool: 'exec', command: 'rm -rf /' };
  lines[2] = JSON.stringify(row);
  writeFileSync(journal.path, `${lines.join('\n')}\n`, 'utf8');

  await assert.rejects(() => replay(journal.path, {}), /unverified journal/);
});
