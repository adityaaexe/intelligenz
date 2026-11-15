# Journal format

Version 1. The format is newline-delimited JSON (NDJSON): one entry per line, no
wrapping array, no trailing comma. A journal is append-only.

## Entry

```json
{"seq":0,"ts":"2026-01-01T00:00:00.000Z","type":"run.start","payload":{"goal":"demo"},"prev":"0000000000000000000000000000000000000000000000000000000000000000","hash":"9f2c…"}
```

| Field | Type | Constraints |
|---|---|---|
| `seq` | integer | zero-based, exactly `previous.seq + 1` |
| `ts` | string | ISO-8601; recorded from the writer's clock, not attested |
| `type` | string | one of the eight event types below |
| `payload` | object | plain JSON object; arrays and scalars are rejected |
| `prev` | string | 64-char lowercase hex; `hash` of the previous entry |
| `hash` | string | 64-char lowercase hex; see below |

## Event types

The vocabulary is closed. A journal containing an unknown type is rejected at
parse time rather than silently accepted.

```
run.start   agent.spawn   agent.message   tool.call
tool.result decision      run.error       run.end
```

## Hash preimage

```
hash = SHA-256( prev ‖ "\n" ‖ seq ‖ "\n" ‖ type ‖ "\n" ‖ ts ‖ "\n" ‖ canonical(payload) )
```

where `‖` is string concatenation, `seq` is rendered in decimal without padding,
and `canonical` is `JSON.stringify` applied to a value whose object keys are
sorted ascending at **every** depth.

The first entry uses `prev = GENESIS_HASH = "0" × 64`.

Two consequences worth stating:

- Every field a reader could tamper with is covered by the hash, including the
  link to the previous entry.
- Because payload keys are sorted before hashing, two logically identical
  payloads with different key insertion order produce the same hash. This makes
  the format diff-friendly and language-portable.

## Canonicalisation

```ts
canonical({ b: 2, a: { d: 4, c: 3 } }) === '{"a":{"c":3,"d":4},"b":2}'
```

Arrays preserve order; they are data, not maps. `null` is preserved. Numbers are
serialised by `JSON.stringify`, so `1.0` and `1` are indistinguishable — do not
use floats where exact decimal identity matters.

## Anchors

An anchor is a separate, small document committing to a journal's head:

```json
{
  "version": 1,
  "entries": 4,
  "head": "71f447396a751f63301be6b706083a6ebe798df52c92f929176ab4e82e00b894",
  "at": "2026-11-15T17:27:00.503Z"
}
```

`entries` anchors a **prefix**: verification requires at least that many entries
and that entry `entries - 1` still hashes to `head`. Entries appended after the
anchor are permitted and reported, because a run may legitimately continue.

Anchoring an empty journal yields `entries: 0` and `head: GENESIS_HASH`, which
commits to "nothing yet" and therefore detects later backdating.

## Versioning

`version` is present on anchors and absent on entries. If the entry preimage ever
changes, entries gain a discriminator rather than silently changing meaning;
`version: 1` anchors must continue to verify against version-1 journals.
