# intelligenz

Deterministic, tamper-evident run journals for multi-agent systems.

Record what an agent run actually did, prove afterwards that the record was not
edited, and replay it in order. Zero runtime dependencies — Node's standard
library only.

```
OK 6 entries, chain intact
BROKEN at seq 2: entry hash does not match its content (6 entries)
```

## Why

Multi-agent runs are hard to reason about after the fact. The usual artifact is
a log file: unstructured, mutable, and impossible to trust when it matters —
during an incident, a review, or a regression hunt. If the record can be edited
silently, it cannot settle a disagreement.

`intelligenz` writes an append-only journal where every entry commits to the one
before it. Editing any field invalidates that entry, deleting or reordering an
entry breaks the chain, and replay refuses to trust a journal that fails
verification.

## Install

```bash
npm install intelligenz
```

Requires Node 22 or newer.

## Quick start

```js
import { Journal, replay, verifyJournal } from 'intelligenz';

const journal = Journal.create('run.jsonl');

journal.append('run.start', { goal: 'summarise three papers' });
journal.append('agent.spawn', { agent: 'researcher' });
journal.append('tool.call', { tool: 'search', query: 'retrieval augmented generation' });
journal.append('tool.result', { tool: 'search', hits: 3 });
journal.append('run.end', { reason: 'completed' });

verifyJournal('run.jsonl');
// { ok: true, count: 5 }

await replay('run.jsonl', {
  'tool.call': (entry) => {
    console.log(entry.payload.tool);
  },
});
```

Reopening a journal continues its chain rather than starting a new one:

```js
const journal = Journal.open('run.jsonl'); // verifies before returning
journal.append('run.end', { reason: 'resumed and finished' });
```

## CLI

```bash
intelligenz verify <journal>      # recompute the chain; exit 1 if broken
intelligenz head <journal> [n]    # first n entries (default 10)
intelligenz tail <journal> [n]    # last n entries (default 10)
intelligenz replay <journal>      # re-drive and print a summary
```

`verify` is meant for CI and pre-incident checks: a non-zero exit is a usable
gate.

```bash
$ intelligenz verify run.jsonl
OK 6 entries, chain intact

$ intelligenz verify tampered.jsonl
BROKEN at seq 2: entry hash does not match its content (6 entries)
```

## Event vocabulary

The vocabulary is closed on purpose. A journal that accepts arbitrary event
names cannot be validated meaningfully.

```
run.start   agent.spawn   agent.message   tool.call
tool.result decision      run.error       run.end
```

Payloads must be plain objects. Unknown event types and non-object payloads are
rejected at append time, not silently written.

## What verification detects

- an edited payload, timestamp, or event type
- an edited `prev` link
- a deleted entry
- an inserted entry
- a reordered entry

## What it does **not** do

These limits matter, so they are stated rather than implied:

- **It is tamper-*evident*, not tamper-*proof*.** Every entry can be
  recomputed. Someone who rewrites the entire chain from the first entry
  produces a journal that verifies. To close that gap you need an external
  anchor — publish the head hash somewhere, sign it, or commit it to a
  transparency log. That is not implemented in 0.1.0.
- **It does not capture the run for you.** You call `append`; nothing
  intercepts your agent framework automatically.
- **It does not guarantee replay produces the same side effects.** Replay
  re-delivers recorded events to your handlers. If those handlers call live
  APIs, they will call live APIs.
- **Timestamps are recorded, not attested.** They come from the writer's clock.

## Design

Each entry is one line of JSON:

```json
{"seq":0,"ts":"2026-01-01T00:00:00.000Z","type":"run.start","payload":{"goal":"demo"},"prev":"000…0","hash":"9f2c…"}
```

`hash = sha256(prev ‖ seq ‖ type ‖ ts ‖ canonical(payload))`, where `canonical`
sorts object keys at every depth so logically identical payloads hash
identically. The first entry chains to `GENESIS_HASH` (64 zeros).

Append writes a single line and flushes, so a crash mid-run leaves a truncatable
prefix rather than a corrupt file. `Journal.open` verifies before returning, and
`replay` verifies before emitting a single event.

## Status

`0.1.0`. The journal, verification, and replay are implemented and covered by a
test suite (`npm test`, 16 tests). A control plane, a research engine, and
automatic framework instrumentation are **not** built yet — they are the
direction, not a claim about the present.

## License

MIT
