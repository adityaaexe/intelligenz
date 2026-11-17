# Phase 8.9 verification matrix

**Measured on this host at this checkpoint.** No result below is inherited or estimated.
Commit before the documentation commit: `48bc768` (worktree gains the preview files and these
documents).

| Gate | Required | Result | Evidence |
|---|---|---|---|
| Repository integrity | clean after commit | **PASS** at time of measurement (worktree held only the intended additions) | `git status --porcelain` |
| Branch / HEAD | recorded | **PASS** — `phase-6/trust-boundary-closure` @ `48bc768` | `git rev-parse HEAD` |
| Programme ledger | VALID | **PASS** — 32 tasks (15 completed / 6 blocked / 11 planned) | `pnpm programme:check` |
| Web typecheck | exit 0 | **PASS** — exit 0 | `pnpm --filter @intelligenz/web typecheck` |
| Web lint | exit 0, zero warnings | **PASS** — `eslint src --max-warnings=0`, exit 0 | command output |
| Preview unit tests | all pass | **PASS** — 30/30, 1 file | `vitest run src/lib/preview-data.test.ts` |
| Web build | pass | **PASS** — `/preview` reported as dynamic (ƒ); the served artefact is this build | `next build` |
| Basic auth fail-closed (unset env) | 503 | **SUPERSEDED 2026-11-17** — the Basic gate was removed; Cloudflare Access is the only authentication. See `PREVIEW-SECURITY-REVIEW.md` §3 |
| Basic auth challenge (historical) | 401 | **SUPERSEDED** — no application credential exists on `/preview` |
| Basic auth accept (historical) | 200 | **SUPERSEDED** — `/preview` returns 200 to any request that has passed Cloudflare Access |
| Tunnel-host `/` renders the preview | 200, preview content, no `Location` | **PASS** — 200, `TEMPORARY PREVIEW` present, `^location:` count 0 |
| `cf-connecting-ip` fallback | preview content when forwarded `Host` is not the tunnel name | **PASS** — marker present with `Host: 127.0.0.1:3100` + `cf-connecting-ip` |
| Local `/` unchanged | no preview content | **PASS** — marker count 0 on plain `127.0.0.1:3100/` |
| Origins loopback-bound | `127.0.0.1:3100` and `127.0.0.1:4100` | **PASS** — both loopback; LAN address returns `000` |
| Matcher scope | `/` and `/login` unaffected | **PASS** — both 200 without a challenge | `curl` |
| Secret leakage in HTML | none | **PASS** — password 0, `DATABASE_URL` 0, `JWT_SECRET` 0, `127.0.0.1` 0, `localhost:4100` 0, `postgres://` 0 | `grep -c` over the rendered body |
| Real data rendered | from the ledger, not invented | **PASS** — `15 / 32`, `P83-007`, `TEMPORARY PREVIEW`, `NOT CHECKED`, `UNKNOWN — no heartbeat endpoint` present | rendered body |
| Mobile layout | no horizontal overflow | **PASS (headless)** — `scrollWidth == innerWidth` at 360/390/412 px; table becomes cards; 44 px targets | implementer measurement |
| Local origin | HTTP success | **PASS** — 200 | `curl 127.0.0.1:3100/` |
| Public tunnel | external HTTP success | **PASS** — `https://sci-imagination-velocity-nhs.trycloudflare.com` answers | `curl` from this host via Cloudflare edge |
| Access gate | active, no data before auth | **PASS** — 302 to `login.trycloudflare.com/authorize`, 0 bytes, 0 ledger strings | `curl -D` |
| Authorised user reaches page | operator-confirmed | **NOT VERIFIED** — requires the operator's mailbox; the operator's first visit is the acceptance test | — |
| Unauthorised email denied | denial observed | **NOT VERIFIED** — no second mailbox available to attempt it | — |
| Tunnel process alive | running | **PASS** — pid recorded, `--allowed-mail` in argv | `ps`, `/proc/<pid>/cmdline` |
| Cleanup procedure | scoped to this pid | **PASS by construction** — `kill "$(cat pid)"` after a `ps` identity check; no `pkill` | runbook §6 |
| Unrelated ports | untouched | **PASS** — 3000 and 4000 still `node /opt/revei`, same pids as baseline | `ss -ltnp` |
| SSE compatibility | not required | **N/A** — the page uses no streaming | design |
| PostHog ingestion | observed event | **NOT RUN** — no SDK, no tool, no verified project identity | telemetry contract §5 |
| Figma | file key | **NOT RUN** — no key supplied; nothing created, no credits spent | — |
| P88-001 / P88-003 / P88-002 | implemented | **NOT DONE this cycle** — P88-001 root cause located and documented; the other two not started. The preview deliverable took priority and is stated as such | `P88-001-CANCELLATION-RESIDUE.md` |

## Gates not run, and why

- **Full repository suite and API E2E**: not re-run after the preview change, because the change
  touches only `apps/web`. The last measured run is `98 files / 1073 passed / 15 skipped` and
  `167 passed ×3` at `d7a817d`; it is **historical**, and this document does not present it as
  verification of the preview.
- **Android device over the tunnel**: no device was available to this session. Mobile layout was
  measured in headless Chrome at phone viewports only.

## Rule applied

A skipped test is not a pass. A historical result is not a fresh verification. A 200 from the
local origin is not proof that the public URL works, so both were checked separately.
