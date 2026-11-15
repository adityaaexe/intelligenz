# intelligenz

Deterministic, tamper-evident run journals for multi-agent systems.

Record what an agent run actually did, prove afterwards that the record was not
edited, and replay it in order. Zero runtime dependencies — Node's standard
library only.

```
OK 5 entries, chain intact
ANCHOR MISMATCH: anchored prefix was rewritten: entry 3 hashes to 07f9…
```

## Why

Multi-agent runs are hard to reason about after the fact. The usual artifact is a
log file: unstructured, mutable, and impossible to trust when it matters — during
an incident, a review, or a regression hunt. If the record can be edited
silently, it cannot settle a disagreement.

`intelligenz` writes an append-only journal where every entry commits to the one
before it. Editing any field invalidates that entry; deleting or reordering an
entry breaks the chain; replay refuses to trust a journal that fails
verification. A published **anchor** extends that guarantee to the whole file,
so a fully re-chained forgery is still caught.

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

## Anchoring

A hash chain alone cannot detect a careful falsifier: someone who rewrites an
entry and recomputes every downstream hash produces a chain that verifies. The
anchor is what closes that gap. Publish it somewhere the attacker does not
control — a Git commit, a release asset, a transparency log.

```js
import { createAnchor, verifyAnchor } from 'intelligenz';

const anchor = createAnchor('run.jsonl');
// { version: 1, entries: 5, head: '71f4…', at: '2026-11-15T17:27:00.503Z' }

verifyAnchor('run.jsonl', anchor);
// { ok: true, anchored: 5, total: 5, appended: 0 }
```

Entries appended *after* anchoring are allowed — a run may legitimately
continue — and are reported as `appended`. Rewriting or truncating the anchored
prefix is not.

This is the difference in practice. Given a journal whose entry 1 was edited and
whose remaining four hashes were recomputed to match:

```
$ intelligenz verify run.jsonl
OK 5 entries, chain intact

$ intelligenz verify run.jsonl --anchor anchor.json
ANCHOR MISMATCH: anchored prefix was rewritten: entry 3 hashes to 07f9…
```

## CLI

```bash
intelligenz verify <journal> [--anchor <file>]   # exit 1 if broken or mismatched
intelligenz anchor <journal> [--out <file>]      # emit a publishable head anchor
intelligenz head <journal> [n]                   # first n entries (default 10)
intelligenz tail <journal> [n]                   # last n entries (default 10)
intelligenz replay <journal>                     # re-drive and print a summary
```

Exit codes: `0` success, `1` verification failure, `2` usage error. `verify` is
meant for CI — a non-zero exit is a usable gate, and there is no flag to disable
it.

## Event vocabulary

The vocabulary is closed on purpose. A journal that accepts arbitrary event names
cannot be validated meaningfully.

```
run.start   agent.spawn   agent.message   tool.call
tool.result decision      run.error       run.end
```

Payloads must be plain objects. Unknown event types and non-object payloads are
rejected at append time, not silently written.

## What verification detects

| Attack | `verify` | `verify --anchor` |
|---|---|---|
| Edited payload, timestamp, or event type | detected | detected |
| Edited `prev` link | detected | detected |
| Deleted entry | detected | detected |
| Inserted entry | detected | detected |
| Reordered entry | detected | detected |
| Trailing truncation | not detectable | detected |
| Full re-chain | **not detectable** | detected |
| Backdated fresh journal | not detectable | detected |

## What it does **not** do

These limits matter, so they are stated rather than implied. The full analysis is
in [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md).

- **It is not tamper-*proof*.** With no published anchor, the careful falsifier
  wins. The software provides the mechanism; publishing is the operator's job.
- **No signatures, no identity.** Nothing here proves *who* wrote an entry.
- **Timestamps are recorded, not attested.** They come from the writer's clock.
- **It cannot prove completeness.** A malicious writer can simply omit an event.
- **It does not capture the run for you.** You call `append`; nothing intercepts
  your agent framework automatically.
- **Replay does not reproduce side effects.** Handlers are yours; if they call
  live APIs, they will call live APIs.

## Design

Each entry is one line of JSON:

```json
{"seq":0,"ts":"2026-01-01T00:00:00.000Z","type":"run.start","payload":{"goal":"demo"},"prev":"000…0","hash":"9f2c…"}
```

```
hash = SHA-256( prev ‖ "\n" ‖ seq ‖ "\n" ‖ type ‖ "\n" ‖ ts ‖ "\n" ‖ canonical(payload) )
```

`canonical` sorts object keys at every depth so logically identical payloads hash
identically. The first entry chains to `GENESIS_HASH` (64 zeros). The normative
description is [docs/FORMAT.md](docs/FORMAT.md).

Append writes a single line and flushes, so a crash mid-run leaves a truncatable
prefix rather than a corrupt file. `Journal.open` verifies before returning, and
`replay` verifies before emitting a single event.

## Status

`0.2.0`. Journal, verification, anchors, and replay are implemented and covered by
**25 tests** (`npm test`). A control plane, a research engine, automatic framework
instrumentation, and signatures are **not** built — they are direction, not a
claim about the present.

## Documentation

- [docs/FORMAT.md](docs/FORMAT.md) — format specification and hash preimage
- [docs/THREAT-MODEL.md](docs/THREAT-MODEL.md) — adversaries, coverage, residual risk
- [CHANGELOG.md](CHANGELOG.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)

## License

MIT
