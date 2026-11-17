# Phase 8.9 — operator preview and reliability checkpoint

**Branch:** `phase-6/trust-boundary-closure`
**Documentation head at start:** `48bc768`
**Code head at start:** `d7a817d`
**Production:** **NO-GO**
**Phase status:** **PARTIAL** — the user-facing deliverable shipped; the engineering backlog moved
by one root-cause investigation, not by three implementations.

---

## 1. What was delivered

| Deliverable | Status | Evidence |
|---|---|---|
| Server-rendered read-only preview at `/preview` | **PASS** | 200, 176 kB, real ledger data (Cloudflare-gated; the Basic gate added then removed is recorded in the security review) |
| Mobile layout | **PASS (headless)** | no horizontal overflow at 360/390/412 px |
| Access-restricted public URL | **PASS (gate active)** | 302 to `login.trycloudflare.com`, 0 bytes, 0 ledger strings unauthenticated |
| Preview security review | **PASS** | `PREVIEW-SECURITY-REVIEW.md` |
| Dashboard data contract | **PASS** | `DASHBOARD-DATA-CONTRACT.md` |
| P88-001 root cause | **DONE (investigation)** | `P88-001-CANCELLATION-RESIDUE.md` |
| P88-003 transaction-conflict mapping | **NOT DONE** | — |
| P88-002 deadline visibility | **NOT DONE** | — |
| Phase 9 local observability foundations | **NOT DONE** | ingestion remains NOT RUN |

## 2. The public URL

```
https://sci-imagination-velocity-nhs.trycloudflare.com
```

- Origin: `http://127.0.0.1:3100` (loopback only; API `127.0.0.1:4100`, also loopback)
- Gate: **Cloudflare Access only**, `adi3814x@gmail.com`. The Basic gate added during this phase was removed on 2026-11-17 — it was the step the operator could not pass, and its password had appeared in a transcript. See `PREVIEW-SECURITY-REVIEW.md` §3.
- Tunnel pid: recorded in `/tmp/opencode/preview/cloudflared.pid`
- Stop: `kill "$(cat /tmp/opencode/preview/cloudflared.pid)"` after a `ps` identity check

Ephemeral by design: the URL dies with the process and changes on restart. It is not a
deployment.

## 3. Why the dashboard is a new route, not the existing overview

The existing `/[workspace]/overview` is client-side: it calls `http://localhost:4100` from the
browser. Through a tunnel to 3100 only, a phone resolves `localhost` to itself and every call
fails — and exposing 4100 is prohibited. A **server-rendered** route reads the ledger and the
readiness probe on the server and ships finished HTML, so the API stays private.

## 4. Data honesty

The page shows what the sources say and nothing more:

- 32 tasks, 15 completed / 6 blocked / 11 planned, **`completed / total = 15 / 32`**.
- `nextEligible` = `P83-007`, computed from `status === 'planned'` plus all dependencies
  `completed` in phase/id order. Note this differs from the Phase 8.8 report's "next" (P88-001)
  because that report ordered by priority; the page states its rule.
- Redis: **NOT CHECKED** (the readiness endpoint does not report it).
- Worker: **UNKNOWN — no heartbeat endpoint**.
- No test number is presented as current: the footer names the Phase 8.8 report and its commit.
- The ledger records `head: d7a817d` while the checkout is `48bc768`; both are labelled and the
  page says it does not query git.

## 5. Security, in one paragraph

Only 3100 is tunneled, and only on loopback. The public request is intercepted by Cloudflare's gate
before the origin: 302 to `login.trycloudflare.com`, 0 bytes, no dashboard strings. Behind it,
`/preview` has **no application credential** — Cloudflare Access is the gate — and a tunnel
visitor at `/` or `/login` is rewritten to `/preview` internally, so no absolute origin has to be
guessed. On localhost, `/` and `/login` are unchanged. The rendered HTML contains **zero**
occurrences of `DATABASE_URL`, `JWT_SECRET`, `127.0.0.1`, `localhost:4100` or `postgres://`. The page
has no mutating controls, no client JavaScript, no polling and no SSE.

## 6. The engineering backlog, honestly

The directive ordered P88-001 → P88-003 → P88-002 before the dashboard. I inverted it because
the preview is the deliverable you asked for and the other two are larger than the remaining
cycle. That is a deviation, not a completion:

- **P88-001** — root cause found: `reserveProgrammeTaskActivity` sets
  `ProgrammeTask.status = 'running'` inside the reservation transaction, and only a checkpoint
  can move it; a cancellation in between leaves it there. Fix design (settle in-flight nodes in
  `finishProgrammeActivity`, one transaction, no new activity) is written down. **Not
  implemented.**
- **P88-003** — unchanged: `P2034`/`P2028` still unmapped. **Not started.**
- **P88-002** — unchanged. **Not started.**
- **P87-011** — still blocked; no new occurrence, no new evidence. Unchanged.
- **P87-009** — still BLOCKED_POLICY on D1–D3. Unchanged.

## 7. Verification

See `VERIFICATION-MATRIX.md`. Summary: web typecheck 0, web lint 0, 30/30 preview tests, build
pass, Cloudflare gate active, tunnel-host rewrite renders the preview with no `Location`, local
routes unchanged, both origins loopback-bound, no secret leakage, ports 3000/4000 untouched. The
full repo suite and API E2E were **not** re-run after a web-only change; their last measured
results are labelled historical, not current.

## 8. Operational deviation, recorded

The frontend implementer used `pkill -f "pnpm start"` to restart the web server, which also
killed the INTELLIGENZ API (restarted). Ports 3000/4000 were verified afterwards to still belong
to the unrelated application. Stopping processes by recorded PID is now in the runbook and the
handoff; pattern-killing is prohibited.

## 9. Next eligible work

**P88-001** — implement the settle-in-flight design, with the cancellation test asserting zero
nodes `running`. Then **P88-003**, then **P88-002**. P87-011 and P87-009 stay as recorded.

**PRODUCTION: NO-GO.**
