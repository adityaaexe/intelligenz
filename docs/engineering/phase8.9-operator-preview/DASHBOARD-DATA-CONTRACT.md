# Dashboard data contract — `/preview`

**Read-only.** Two sources, both read on the server. The browser receives rendered HTML and
never calls the API.

---

## 1. Sources, in precedence order

| # | Source | How | Why it is trusted |
|---|---|---|---|
| 1 | Programme ledger `docs/engineering/programme/EXECUTION-STATE.json` | `node:fs`, repo root found by walking up from `process.cwd()` | validated in CI by `pnpm programme:check`; the schema is machine-checked |
| 2 | `GET http://127.0.0.1:4100/health/ready` | server-side `fetch`, `no-store`, 2 s timeout | the API's own readiness probe: `postgres`, `temporal` with latencies |

Nothing else. No `git` subprocess, no database access, no `.env` read, no shell.

**Divergence is displayed, not resolved.** The ledger records `head: d7a817d` while the
checkout is `48bc768`. The page labels the value as "recorded in the ledger file" and states
that it does not query git. It does not pretend the two agree.

## 2. Snapshot shape

```ts
interface PreviewSnapshot {
  ledger: {
    branch: string;
    head: string;            // as recorded in the file, not the checkout
    phase: string;
    updatedAt: string;
    tasks: PreviewTask[];
  } | { error: 'LEDGER_UNREADABLE' | 'LEDGER_MALFORMED'; detail: string };

  summary: { total, completed, blocked, planned, percent };  // percent = completed / total
  blockers: PreviewTask[];
  nextEligible: PreviewTask | null;

  health:
    | { state: 'ready'; snapshotAt: string; dependencies: Dependency[] }
    | { state: 'unavailable'; snapshotAt: string; detail: string };

  redis:  'NOT CHECKED';
  worker: 'UNKNOWN — no heartbeat endpoint';
}
```

`Dependency = { name: 'postgres' | 'temporal'; status: 'up' | 'down' | 'unknown'; latencyMs?: number }`.

## 3. Field allowlist

Per task, exactly: `id`, `title`, `status`, `phase`, `riskClass`, `dependsOn`, `owner`,
`updatedAt`, `evidenceRequirement.artifact`, `executionPolicy.gate`.

Deliberately not rendered:

- `evidenceRequirement.note` — truncated to 240 characters at parse time and not displayed;
  it can contain free text about investigations.
- `executionPolicy.rationale` — the same reason.
- any absolute or escaping path (dropped by `safeRepoPath`).

## 4. Derived rules

| Value | Rule |
|---|---|
| `percent` | `completed / total`, integer or one decimal; **0 when `total === 0`**, never `NaN`; displayed with the formula `15 / 32` beside it |
| `blockers` | every task with `status === 'blocked'` |
| `nextEligible` | first task with `status === 'planned'` (phase ascending, then id) whose **every** `dependsOn` id has `status === 'completed'`; `null` if none |
| health state | `ready` only when the probe returns 2xx **and** `status` parses; otherwise `unavailable` |

Blocked and planned are never counted as complete. A dependency that is missing from the task
list is treated as unmet, so it cannot make a task eligible.

## 5. Staleness and error states

| Condition | UI |
|---|---|
| ledger missing / unreadable | explicit `LEDGER UNREADABLE` panel naming the repo-relative path; the rest of the page still renders |
| ledger parses but `tasks` is missing | `LEDGER MALFORMED`; no counts are invented |
| readiness fails or times out | API `UNAVAILABLE`; both dependencies `UNAVAILABLE`; never "healthy" |
| readiness succeeds | statuses and latencies as returned, plus the server snapshot time |
| redis | always `NOT CHECKED` — the endpoint does not report it |
| worker | always `UNKNOWN — no heartbeat endpoint` — no such endpoint exists |

The page shows the **server clock** time of the snapshot. Because the page is dynamic, a reload
is a fresh read; there is no polling and no cached interval to go stale silently.

## 6. What the contract refuses

- A "live" indicator driven by a timer rather than a probe.
- A progress bar whose value is not `completed / total` from the ledger.
- A test-result number presented as current: the footer names the Phase 8.8 report and its
  commit instead of replaying a number that newer code may have invalidated.
- An owner, timestamp, or blocker reason the sources do not contain.

## 7. Filters

`?status=all|completed|blocked|planned` — a server-side anchor, so it works with JavaScript
disabled and cannot be used to reach another resource. The response states "N of 32 shown".
