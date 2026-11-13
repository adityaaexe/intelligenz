# 01 — Overview

> Route: `/{workspace}/overview` · Module 1 · Landing screen for every role.
> Components referenced here are defined in `../COMPONENT-INVENTORY.md`.

---

## 1. Purpose

The organisation's flight strip. It reports posture, live work, human blockers, and spend in one
scan, and it is the entry point to every chain of evidence.

**Primary jobs**

| Persona | Job |
|---|---|
| Founder / operator | Confirm the system is running, see what needs a decision, see today's spend against plan |
| Agency owner | Check each client workspace is healthy before a status call; confirm delivery evidence exists |
| Enterprise lead | Confirm no policy violations are open, no degraded dependency is silently producing bad work |

**The five-second question:** *Is the organisation healthy, what is it doing right now, and what needs me?*

Three answers must be readable without scrolling: posture, the count of items awaiting a human, and
spend against today's ceiling.

---

## 2. Layout

Base design 1440×900. Content padding `--iz-space-24`. 12-column grid, `--iz-space-24` gutter.

```
┌ topbar 56 ────────────────────────────────────────────────────────────────┐
├ scopebar 40 ──────────────────────────────────────────────────────────────┤
│ Screen header 64   Overview            [24h|7d|30d]  [Run a workflow]      │
├───────────────────────────────────────────────────────────────────────────┤
│ R1 POSTURE STRIP 96                                                       │
│  Nominal │ 4 Running │ 3 Awaiting │ 2 Failed │ $186.40 / $600             │
│ R1b OPERATING CONSTRAINTS 32  Copilot · max risk Medium · $600/day ·      │
│     4 repos · sandbox:firecracker · rollback: revert+slot                 │
├──────────────────────────────────────────────┬────────────────────────────┤
│ R2a LIVE RUNS                 span 8         │ R2b NEEDS YOU      span 4  │
│    filter bar 40 + table (8 rows × 32)       │  3 approval cards +        │
│    min-height 360                            │  3 alerts, min-height 360  │
├───────────────┬───────────────┬──────────────┴────────────────────────────┤
│ R3a COST 4    │ R3b DECISIONS │ R3c AGENT FLEET 4                         │
│ 280           │ 4 · 280       │ 280                                       │
├───────────────────────────────────────────────────────────────────────────┤
│ R4 SCHEDULES NEXT 24H 160 — horizontal timeline, 12 spans                 │
└───────────────────────────────────────────────────────────────────────────┘
```

| Region | Height | Grid | Contents |
|---|---|---|---|
| Screen header | 64px | 12 | Title `Overview` (`--iz-text-xl`), scope subtitle (`--iz-text-xs`, links), window segmented control, primary action |
| R1 posture strip | 96px | 12 | 5 cells divided by 1px `--iz-border-default` vertical rules; each cell = metric label + value + delta |
| R1b operating constraints | 32px | 12 | One line, `--iz-text-xs`, `--iz-ink-2`; mode chip + 4 constraint fragments, each a link to its setting |
| R2a live runs | min 360px | 8 | Filter bar (40px) + data table; rows 32px; 8 visible before scroll |
| R2b needs you | min 360px | 4 | 3 `ApprovalCard/card` + 3 compact notification rows + `View all` |
| R3a cost | 280px | 4 | `BudgetBar` daily + monthly, `DistributionBar` by agent, 7-bar spend sparkline |
| R3b decisions | 280px | 4 | `Timeline/event-log`, 6 entries, each with actor and decision stamp |
| R3c agent fleet | 280px | 4 | 8 `AgentStatusCard/compact` in `repeat(auto-fit, minmax(160px,1fr))` |
| R4 schedules | 160px | 12 | `Timeline/horizontal-gantt`, next 24h, 5 schedules |

The posture strip is not a card and has no background: it is a band of the canvas divided by rules.
R2a and R2b are separated by a 1px `--iz-border-default` vertical rule, not a gap and not a card edge.

---

## 3. Information hierarchy

| Priority | Element | Treatment |
|---|---|---|
| 1 | Posture word (`Nominal` / `Degraded` / `Failed`) | `--iz-text-2xl` 28px, glyph 20px, status stem colour |
| 2 | Awaiting-approval count | 28px, `--iz-status-awaiting-fg`, label `Awaiting approval` beneath in `--iz-text-micro` |
| 3 | Spend against ceiling | 28px with `of $600` at 0.85em in `--iz-ink-3`; `BudgetBar` directly under |
| 4 | Live runs table | 13px rows, status pill first column — the eye lands on colour + glyph |
| 5 | Needs-you cards | Risk badge + title; the only region allowed a tinted background (`#FAF1F0` for Critical) |
| 6 | Cost, decisions, fleet | 16px metric values, secondary |
| 7 | Schedules | 13px, lowest contrast that still passes (6.13:1) |

Available on demand: run detail, agent detail, cost breakdown by model, full decision history, every
alert older than the 3 shown, and any object's lineage. Nothing primary is behind a hover.

---

## 4. Component composition

| Region | Components |
|---|---|
| Shell | `A1 AppShellChrome`, `A2 SidebarNav`, `A4 ScopeBar`, `A5 ModeIndicator`, `A8 NotificationCentre` (trigger) |
| Screen header | `C5 SegmentedControl` (window), `A6 CommandPalette` (trigger only), button `Run a workflow` |
| R1 | `B4 MetricTile/posture` ×4, `B1 StatusPill` (posture), `B5 Sparkline` (inside spend cell) |
| R1b | `B1 StatusPill` (mode), inline text links, `D8 BudgetBar/inline` |
| R2a | `C2 FilterBar`, `C3 FilterChips`, `C1 DataTable` (compact), `B1 StatusPill`, `E5 CodeIDChip`, `C9 Tooltip` (truncated IDs) |
| R2b | `C11 ApprovalCard/card` ×3, `B2 RiskBadge`, `B1 StatusPill`, `D4 GuardrailSummary/compact`, `A8 NotificationCentre/panel` |
| R3a | `D8 BudgetBar` ×2, `B6 DistributionBar`, `D7 CostUsageMeter/inline`, `B5 Sparkline/bar` |
| R3b | `E4 Timeline/event-log`, `E5 CodeIDChip`, decision stamp (`--iz-seal`) |
| R3c | `E1 AgentStatusCard/compact` ×8 |
| R4 | `E4 Timeline/horizontal-gantt`, `B1 StatusPill` |
| States | `F1 EmptyState`, `F2 SkeletonLoader/table`, `F3 ErrorState`, `F4 PermissionDeniedState`, `F5 OfflineBanner`, `F6 DegradedSystemBanner` |

No component appears that is not in the inventory. `B2 RiskBadge` is deliberately absent from the runs
table: risk is an approval property, and putting it in a run row conflates two dimensions.

---

## 5. Data model

### 5.1 Posture

```ts
{
  posture: 'nominal' | 'degraded' | 'failed' | 'offline',
  postureReason: 'all systems within contract' | 'model-router degraded: 2 of 5 providers responding',
  since: '2026-11-13T04:12:00Z',
  activeRuns: 4,
  queuedRuns: 7,
  awaitingApproval: 3,
  failed24h: 2,
  spend: { today: 186.40, ceiling: 600.00, currency: 'USD', forecast: 412.00 },
  mode: 'copilot',
  constraints: { maxRisk: 'medium', dailyBudget: 600, repos: 4, environment: 'sandbox:firecracker', rollback: 'revert+slot' }
}
```

Posture derivation: `failed` if any P0 is open; `degraded` if any P1 is unacknowledged >15m or any
dependency is below contract; `offline` if the control plane has no heartbeat for 60s; otherwise
`nominal`.

### 5.2 Live runs — columns and 8 real rows

Columns: `Status` (140px) · `Run` (fluid, min 280px) · `Agent` (150px) · `Repository` (170px) ·
`Model route` (150px) · `Cost` (80px, right) · `Duration` (80px, right) · `Started` (72px, right) ·
`Actions` (48px).

| Status | Run | Agent | Repository | Model route | Cost | Duration | Started |
|---|---|---|---|---|---|---|---|
| `Running` | `run_01JB7Q2K8M4X` Rotate refresh tokens in auth middleware | Atlas · `agt_eng_04` | `reveilchat/backend` | `claude-sonnet-4-5` | $2.14 | 14m 22s | 04:04Z |
| `Running` | `run_01JB7Q4R2C9P` Regenerate design tokens for dark theme | Wren · `agt_des_01` | `intelligenz/design-system` | `gpt-5.1` | $0.61 | 6m 08s | 04:12Z |
| `Awaiting approval` | `run_01JB7P9XW3N2` Merge PR #412 rate-limit middleware | Kestrel · `agt_eng_02` | `reveilchat/backend` | `claude-sonnet-4-5` | $1.87 | 22m blocked | 03:24Z |
| `Queued` | `run_01JB7Q8T5H6V` Audit WCAG contrast on onboarding flow | Audra · `agt_audit_01` | `reveilchat/mobile` | `gemini-2.5-pro` | — | — | 04:18Z |
| `Failed` | `run_01JB7N1K7D4S` Partition sessions table by month | Forge · `agt_eng_07` | `reveilchat/infra` | `claude-sonnet-4-5` | $4.92 | 41m 06s | 03:41Z |
| `Degraded` | `run_01JB7Q0M8B1L` Index research corpus (1.2M docs) | Sift · `agt_res_02` | `intelligenz/knowledge` | `qwen3-embedding-8b` | $0.38 | 2h 08m | 02:10Z |
| `Completed` | `run_01JB7K5T9F3Q` Generate Q4 delivery report for Northwind | Ledger · `agt_rep_01` | `intelligenz/reports` | `gpt-5.1` | $0.44 | 8m 41s | 02:02Z |
| `Completed` | `run_01JB7J8V2R6D` Contract tests for /v2/matches | Kestrel · `agt_eng_02` | `reveilchat/backend` | `claude-sonnet-4-5` | $1.12 | 11m 19s | 01:48Z |

Run rows are ordered: awaiting approval first (they need a human), then failed, then degraded, then
active, then queued, then completed by recency. Ordering is stable across polls; new rows insert
without reordering existing ones.

### 5.3 Needs-you rail

| Field | Approval 1 | Approval 2 | Approval 3 |
|---|---|---|---|
| ID | `apr_01JB8M3XQ2` | `apr_01JB8F7T1K` | `apr_01JB84QZ9R` |
| Title | Merge token-rotation refactor | Drop legacy `match_events` table | Publish pricing page variant |
| Risk | High · 68 | Critical · 84 | Medium · 41 |
| Requested by | Atlas (`agt_eng_04`) | Forge (`agt_eng_07`) | Wren (`agt_des_01`) |
| Age | 22m | 1h 04m | 3h 12m |
| Blast radius | 7 files · 1 repo · prod | 1 table · 412k rows · prod | 3 pages · 1 env · staging |
| Cost impact | +$0.00 runtime | +$18.40/mo storage saved | +$0.00 |
| Policy | 5 pass | 4 pass · 1 fail (retention) | 5 pass |

The Critical card carries the `#FAF1F0` tint, the word `Critical`, and a 4/4 segmented risk bar. It is
never the auto-focused element.

**Alerts (3, compact rows):** `P2 model-router degraded — 2 of 5 providers`, 6m ·
`P1 schedule-missed nightly-eval`, 41m · `P2 budget 80% project control-plane`, 1h 12m.

### 5.4 Cost panel

`Daily $186.40 of $600.00 (31%)`, forecast `$412.00 by 18:00`.
`Monthly $3,142.00 of $9,000.00 (35%)`.
`DistributionBar`: Claude Sonnet 4.5 `$98.20` (53%), GPT-5.1 `$41.60` (22%), Gemini 2.5 Pro `$26.40`
(14%), Embeddings `$12.10` (6%), Other `$8.10` (4%).
7-bar sparkline: `[142, 168, 151, 204, 187, 219, 186]` — labelled `Daily spend, last 7 days, $1,257 total`.

### 5.5 Decisions ledger

| Time | Actor | Decision | Object | Stamp |
|---|---|---|---|---|
| 03:52Z | M. Okafor (human) | Approved | `apr_01JB7Z2K4M` deploy rate-limit middleware to staging | seal |
| 03:48Z | Atlas (`agt_eng_04`) | Auto-approved | `apr_01JB7Y8Q1C` dependency patch, risk Low | agent |
| 03:31Z | Policy `pol_retention_v3` | Blocked | `apr_01JB7X4T7N` drop `audit_log` partition | policy |
| 02:55Z | S. Idris (human) | Rejected | `apr_01JB7W1M9P` raise Autopilot risk ceiling to High | seal |
| 02:40Z | Wren (`agt_des_01`) | Auto-approved | `apr_01JB7V6R3D` regenerate icon set | agent |
| 02:12Z | Policy `pol_egress_v2` | Warned | `run_01JB7Q0M8B1L` corpus index egress 4.1 GB | policy |

### 5.6 Agent fleet

| Agent | Runtime | Route (reasoner / engineer / verifier) | Status | Runs today | Success | Median |
|---|---|---|---|---|---|---|
| Atlas `agt_eng_04` | OpenCode | opus-4-5 / sonnet-4-5 / gpt-5.1 | Running | 14 | 96.2% | 12m 40s |
| Wren `agt_des_01` | Claude Code | gpt-5.1 / sonnet-4-5 / gemini-2.5-pro | Running | 9 | 100% | 5m 12s |
| Kestrel `agt_eng_02` | Codex | o3 / gpt-5.1-codex / sonnet-4-5 | Awaiting approval | 11 | 90.9% | 9m 48s |
| Forge `agt_eng_07` | OpenHands | sonnet-4-5 / sonnet-4-5 / gpt-5.1 | Failed | 6 | 66.7% | 21m 04s |
| Sift `agt_res_02` | Pi | gemini-2.5-pro / qwen3-coder-30b / sonnet-4-5 | Degraded | 3 | 100% | 48m 20s |
| Audra `agt_audit_01` | OpenCode | gpt-5.1 / sonnet-4-5 / o3 | Queued | 5 | 100% | 7m 30s |
| Ledger `agt_rep_01` | Codex | gpt-5.1 / gpt-5.1-codex / sonnet-4-5 | Idle · 18m | 4 | 100% | 8m 12s |
| Vector `agt_idx_03` | custom | sonnet-4-5 / — / — | Offline · 12m | 2 | 50% | 31m 40s |

### 5.7 Schedules

`nightly-eval` every day 02:00Z, next 02:00Z +1d · `token-audit` Mon 06:00Z, next 16 Nov ·
`client-report-northwind` Fri 14:00Z, next 14:00Z · `dependency-sweep` every 6h, next 10:00Z ·
`retention-enforce` Sun 00:00Z, missed 41m ago.

---

## 6. States

| State | What renders |
|---|---|
| **Default** | §5 data. Posture `Nominal`, 4 running, 3 awaiting, 2 failed, $186.40/$600. |
| **Empty** (new workspace) | Posture strip: `—` for every metric, posture `Offline` replaced by a single line `No runs yet`. R2a: `EmptyState/first-run` — "No runs in this workspace. Runs appear when a workflow is triggered, scheduled, or started by hand." [Run a workflow]. R2b: `EmptyState/inline` — "No approvals waiting. Nothing needs a human decision." R3a: budget bars render at 0 with `No spend recorded`. R3c: `EmptyState/inline` — "No agents registered." [Register an agent]. R4: `No schedules.` [Create a schedule]. |
| **Loading** | Every region renders `SkeletonLoader` at its final dimensions (posture values as 40×24 blocks, 8 table rows, 3 card blocks, 8 fleet blocks). No layout shift on resolve. Posture strip keeps its 96px height. |
| **Error** | Posture strip: values `—`, posture pill `Unknown`. R2a: `ErrorState/region` — "Could not load runs. The runs service returned 503 after 3 retries." [Retry] [Copy error details]. R2b, R3, R4 each independent: one region failing never blanks the page. R1b constraints remain (window-scoped config). |
| **Permission denied** | Operator role without `billing:read`: R3a replaced by `PermissionDeniedState/action` — "Cost data requires the Finance viewer role. Ask M. Okafor (workspace owner)." No numbers leak, including in the posture strip — the spend cell renders `Restricted` rather than `—`. All other regions unaffected. |
| **Offline** | `OfflineBanner` under the scope bar: "Offline — showing data from 04:12Z. 2 approvals queued and will submit when reconnected." All values carry a `Stale` marker in `--iz-status-degraded-fg` on the posture strip. Table rows show their cached `last updated` in the time column. Live stream in R3b pauses with `Paused — 3 new events pending`. |
| **Degraded** | `DegradedSystemBanner` — "Model router degraded: 2 of 5 providers responding. New runs queue rather than fail. Approvals unaffected." Posture word becomes `Degraded` (`--iz-status-degraded-fg`), the active-runs cell shows `3 running · 3 queued (provider backpressure)`, and the fleet cards for affected agents show their runtime chip in `--iz-status-degraded-fg` with a `Routing fallback` label. |

Partial failure is normal and must not cascade: each of R1–R4 is an independent `<section>` with its
own loading/error/empty state and its own retry.

---

## 7. Interactions

### 7.1 Click paths

| Target | Result |
|---|---|
| Run row (anywhere except the actions cell) | Navigate to `/{wsp}/projects/{prj}/runs/{run}`; the row keeps a selected style on return for 10s |
| Run row `⋯` | `C8 DropdownMenu/context`: Open · Open agent · Copy run ID · Cancel run (destructive, only when `active`/`queued`) · View evidence |
| Status pill (interactive variant) | Popover with state history: last 5 transitions with timestamps and actor |
| Needs-you card | Navigate to `/{wsp}/approvals/{apr}` |
| Needs-you card `Quick approve` | Not offered on Overview. Overview routes to the approval; quick approve exists only inside the queue where the risk badge and guardrails are in context. |
| Alert row | Opens the notification drawer at that entry |
| Posture cell | Opens the filtered list behind it (e.g. `Active runs` → runs table filtered `status=active`) |
| Cost panel header | Navigate to Reports filtered to the current window |
| Fleet card | Navigate to `/{wsp}/agents/{agt}` |
| Schedule bar | Navigate to `/{wsp}/schedules/{sch}` |
| `Run a workflow` | Opens a picker dialog (search + last 5 workflows) → creates a run, focuses its row on return |

### 7.2 Keyboard

| Key | Action |
|---|---|
| `j` / `k` | Move focus down/up the runs table (row focus ring, not selection) |
| `Enter` | Open the focused row |
| `Space` | Select the focused row (bulk actions bar appears) |
| `x` | Toggle selection without moving |
| `a` | Jump to the first `Awaiting approval` item in the needs-you rail |
| `/` | Focus the runs filter |
| `r` | Refresh all regions (announced: `Refreshed 04:19:02Z`) |
| `[` | Collapse sidebar |
| `⌘\` | Toggle the needs-you rail as a drawer (below 1280px) |
| `g` `o` | Return to Overview from anywhere |

Tab order: skip link → top bar → sidebar → scope bar → screen header → posture strip (each cell is a
link) → filter bar → table (header buttons, then rows) → needs-you cards → cost → decisions → fleet →
schedules.

### 7.3 Destructive actions

| Action | Guard |
|---|---|
| `Cancel run` | `C7 Modal/dialog` confirm. Restates: run ID, task, elapsed time, cost already spent ($2.14 non-refundable), and that completed steps' artifacts are retained. Primary action is `Cancel run`, styled destructive; focus starts on `Keep running`. |
| `Pause agent` (from fleet card menu) | Confirm; states which runs finish and which queue. |

Nothing else on Overview mutates state. Bulk actions on the runs table are limited to `Copy IDs` and
`Export CSV`.

---

## 8. Responsive adaptations

| Breakpoint | Behaviour |
|---|---|
| **≥1440px (desktop)** | As specified. 8/4 split; three 4-column panels in R3; 8 table columns. |
| **1280–1439px** | R2b drops below R2a at full width (12 cols), 2 approval cards per row, alerts to the right of them. R3 becomes 6/6 with cost and fleet side by side; decisions moves to a full-width 200px ledger below. Table loses the `Started` column. |
| **1024–1279px** | Sidebar becomes the 64px rail (labels in tooltips). Posture strip becomes 3+2 (three cells, then two) at 2×48px. R3 becomes a 2-column grid; decisions ledger collapses to 4 rows. Table drops `Model route` and `Started`. Needs-you rail becomes a right drawer toggled by a `3 awaiting` button in the screen header, opening at 400px. |
| **768–1023px** | Single column: posture (2×2 grid at 64px cells) → needs-you (horizontal scroll of 3 cards, snapping) → live runs → cost → fleet. Screen header actions collapse into a `⋯` menu. Table shows 5 columns: Status, Run, Agent, Cost, Age; the rest move into the expanded row. Tapping a row opens the detail drawer at 100% width. |
| **<768px (mobile)** | Posture becomes 2×2 with 56px cells and the spend cell spanning both columns. Table becomes a list: 3 columns (Status, Run, Age) with 44px rows; expand shows agent, repo, model, cost, duration. Needs-you cards stack vertically. Decisions ledger hidden behind `Recent decisions (6)` disclosure. Fleet becomes a 2-column grid of name + status only. Schedules render as a vertical list, not a gantt. Everything remains readable and approvable; no authoring. |

---

## 9. Evidence and traceability

Overview is the top of the chain, so every row must be a door into it, not a dead end.

- Each run row carries its `run_` ID (mono, truncated, copyable) and links to the canonical route.
- The `Awaiting approval` rows show the approval ID's last 6 characters beside the run title so the
  operator can match what they see here to the queue.
- The decisions ledger shows the actor, the decision verb, and the object — with the human decisions
  stamped in `--iz-seal` and the policy decisions marked `policy`. An auto-approved item shows the
  agent name and the rule that permitted it (`risk ≤ Low, mode Copilot, policy pol_auto_low_v2`), so
  "the system approved its own work" is never a mystery.
- Posture changes are recorded: clicking the posture word opens a popover with the last 5 posture
  transitions and their cause. This is the audit of the dashboard itself.
- The `Simulated` chip in the scope bar is present whenever fixtures are in use, and any panel whose
  data is fixture-generated carries a `Simulated` label in its header. No panel claims to be live
  when it is not.

---

## 10. Accessibility notes

- **Table semantics.** `<caption class="iz-sr-only">Live runs, 8 of 214, sorted by attention</caption>`,
  `<th scope="col" aria-sort>` on sortable headers, row actions inside the row's last cell with
  `aria-label="Actions for run 01JB7Q2K8M4X"`.
- **Status never colour-only.** Every pill has glyph + label. A greyscale screenshot remains readable;
  this is a review criterion.
- **Posture announcements.** The posture strip is a `role="status" aria-live="polite"` region that
  announces only on *change of posture or count*, rate-limited to one announcement per 3s. Polling
  that returns identical values announces nothing.
- **Sparklines** are `aria-hidden` with the summary text in an adjacent visually hidden span; the
  metric value and delta carry the meaning.
- **Focus order** follows visual order at every breakpoint. When R2b becomes a drawer, focus moves to
  the drawer heading and returns to the `3 awaiting` trigger on close.
- **Target size.** Row action buttons are 24×24 visual with 8px negative-margin padding, giving a
  32×32 hit area without changing the 32px row height.
- **Reduced motion.** The `Streaming` pulse, row insert flash, and skeleton shimmer are removed; the
  posture strip never animates its numbers.
- **Zoom.** At 400% (320px equivalent) the page reflows to one column; the runs table becomes a
  horizontally scrollable region with `role="region" tabindex="0" aria-label="Live runs table"`, and
  the posture strip wraps to one cell per row.
- **Contrast.** All body text ≥6.13:1. The lowest-contrast text on this screen is the schedule time
  label at `--iz-ink-3` on canvas (6.13:1), which passes AA for 12px text with margin.
