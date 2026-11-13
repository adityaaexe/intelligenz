# 02 — Agent Command Centre

> Route: `/{workspace}/agents` · Module 3 (Agent Studio) · Detail: `/{workspace}/agents/{agentId}?tab=…`
> Components referenced here are defined in `../COMPONENT-INVENTORY.md`.

---

## 1. Purpose

The registry and live execution surface for the specialist brains. This is where an operator watches
work happen, intervenes when an agent is stuck, and changes the model routing that determines quality
and cost.

**Primary jobs**

| Persona | Job |
|---|---|
| Founder / operator | See which agent is working, which is stuck, and what to do about it |
| Enterprise lead | Verify runtime isolation, model routing, and that no agent exceeds its permission ceiling |
| Agency owner | Reassign capacity between client workspaces; confirm utilisation |

**The five-second question:** *Which agent is doing what right now, and is any of them stuck?*

The answer must be readable without opening a detail: the list carries state, assignment, and elapsed
time; the fleet summary carries the count stuck.

---

## 2. Layout

Base 1440×900. Three panes: fixed list 320px, fluid detail, fixed activity rail 360px.

```
┌ topbar 56 ────────────────────────────────────────────────────────────────┐
├ scopebar 40 ──────────────────────────────────────────────────────────────┤
│ Screen header 64  Agent Command Centre        [Filter] [Register agent]    │
├───────────────────────────────────────────────────────────────────────────┤
│ FLEET SUMMARY 72   12 agents · 7 running · 2 awaiting · 1 stuck · 1 offline │
│                    success 94.1% (24h) · median 11m 20s · $412.80 today    │
├──────────────┬───────────────────────────────────┬────────────────────────┤
│ AGENT LIST   │ AGENT DETAIL                      │ LIVE ACTIVITY  360     │
│ 320          │ fluid, min 640                    │ sticky, own scroll     │
│              │ ┌ header 96 ────────────────────┐ │ ┌ filter 40 ─────────┐ │
│ filter 40    │ │ Atlas · OpenCode · Running    │ │ │ 42 events/min      │ │
│ rows 56      │ │ route: opus-4-5 → sonnet-4-5  │ │ ├───────────────────┤ │
│ 12 agents    │ │ [Pause] [⋯]                   │ │ │ 04:19:02  Atlas    │ │
│              │ └───────────────────────────────┘ │ │  applied patch     │ │
│              │ tabs 36: Activity Runs Artifacts  │ │  7 files           │ │
│              │        Handoffs Config            │ │ …                  │ │
│              │ body (tab content)                │ │ [Paused · 14 new]  │ │
├──────────────┴───────────────────────────────────┴────────────────────────┤
│ status bar 28  streaming · 4 agents active · last event 0.8s ago           │
└───────────────────────────────────────────────────────────────────────────┘
```

| Region | Size | Contents |
|---|---|---|
| Screen header | 64px | Title, description (`12 agents · 4 runtimes`), filter toggle (mobile), `Register agent` secondary |
| Fleet summary | 72px | 5 metrics divided by rules: agents, running, awaiting, stuck, success 24h, spend today |
| Agent list | 320px fixed | Filter (40px), sort control, 12 rows × 56px, scrolls independently |
| Agent detail | fluid, min 640px | Header 96px, tabs 36px, tab body scrolls; detail header is sticky within the pane |
| Activity rail | 360px | Filter chips 40px, stream, paused-follow footer 32px |
| Status bar | 28px | Stream connection state, active count, last event age |

The three panes scroll independently. The page itself never scrolls: `height: calc(100vh -
var(--iz-topbar-h) - var(--iz-scopebar-h) - 64px - 72px - 28px)`.

---

## 3. Information hierarchy

| Priority | Element | Treatment |
|---|---|---|
| 1 | Agent state | `StatusPill` 24px, first line of each list row; the stuck agent carries `Failed` + `Needs intervention` in the same line |
| 2 | Current assignment | 13px, one line, truncated with full value on focus |
| 3 | Elapsed time on the current run | Tabular, `--iz-ink-2`, updates every 10s |
| 4 | Model route | Three chips `opus-4-5 → sonnet-4-5 → gpt-5.1`, labelled `reasoner → engineer → verifier` |
| 5 | Throughput and cost | 12px meta in the list row footer, 16px metrics in the detail header |
| 6 | Live activity | 12px mono timestamps; the rail is peripheral by design |
| 7 | Config, handoffs | On demand via tabs |

The stuck agent must be identifiable from the list alone: `Failed` pill, `Needs intervention` label,
and the elapsed time in `--iz-status-failed-fg`. It sorts to the top of the list under the default
`Attention` sort.

---

## 4. Component composition

| Region | Components |
|---|---|
| Shell | `A1 AppShellChrome`, `A2 SidebarNav`, `A4 ScopeBar`, `A5 ModeIndicator` |
| Fleet summary | `B4 MetricTile/posture` ×5, `B5 Sparkline` (success rate, 7d) |
| Agent list | `C2 FilterBar/minimal`, `C3 FilterChips`, `E1 AgentStatusCard/row` ×12, `B1 StatusPill`, `C8 DropdownMenu` (sort), `E5 CodeIDChip` (agent ID, on hover) |
| Detail header | `E1 AgentStatusCard` (expanded header), `B1 StatusPill`, `D6 LineageTraceRail` (trigger), `C10 Toast` (action feedback), `C7 Modal` (pause/retire confirm) |
| Detail — Activity tab | `E4 Timeline/vertical-steps`, `E3 LogViewer/compact`, `C1 DataTable` (recent steps), `D1 DiffViewer/readonly-compact` (when a step produced a patch) |
| Detail — Runs tab | `C1 DataTable`, `C2 FilterBar`, `B1 StatusPill`, `D7 CostUsageMeter` |
| Detail — Artifacts tab | `C1 DataTable`, `E5 CodeIDChip`, `D1 DiffViewer` (on open), `F1 EmptyState` |
| Detail — Handoffs tab | `C1 DataTable` (from, to, task, reason, state, at), `B1 StatusPill` |
| Detail — Config tab | `D4 GuardrailSummary`, `C1 DataTable` (routing rules), `C5 SegmentedControl` (runtime), `C7 Modal` (change route), `D5 PolicyCheckRow` |
| Activity rail | `E2 LiveActivityStream`, `C2 FilterBar/minimal`, `C3 FilterChips`, `B1 StatusPill` |
| States | `F1`–`F6` per region |

---

## 5. Data model

### 5.1 Fleet summary

`12 agents` · `7 running` · `2 awaiting approval` · `1 stuck (41m)` · `1 offline (12m)` ·
`94.1% success (24h, 118 runs)` · `median 11m 20s` · `$412.80 today of $900.00 ceiling`.

### 5.2 Agent list rows (12)

| Agent | Runtime | State | Assignment | Elapsed |
|---|---|---|---|---|
| Atlas `agt_eng_04` | OpenCode | Running | Rotate refresh tokens in auth middleware | 14m 22s |
| Wren `agt_des_01` | Claude Code | Running | Regenerate design tokens for dark theme | 6m 08s |
| Kestrel `agt_eng_02` | Codex | Awaiting approval | Merge PR #412 rate-limit middleware | 22m |
| Forge `agt_eng_07` | OpenHands | Failed · Needs intervention | Partition sessions table by month | 41m 06s |
| Sift `agt_res_02` | Pi | Degraded | Index research corpus (1.2M docs) | 2h 08m |
| Audra `agt_audit_01` | OpenCode | Queued | Audit WCAG contrast on onboarding flow | 0m |
| Ledger `agt_rep_01` | Codex | Idle | — (last: Q4 delivery report) | 18m idle |
| Vector `agt_idx_03` | custom | Offline | Index shard 3 compaction | 12m |
| Quill `agt_doc_02` | Claude Code | Running | Update API reference for /v2/matches | 3m 41s |
| Probe `agt_sec_01` | OpenCode | Running | Dependency CVE sweep, 214 manifests | 9m 12s |
| Mason `agt_eng_09` | OpenHands | Paused | Migrate webhook retries to queue | 0m |
| Echo `agt_support_01` | Pi | Awaiting approval | Reply to enterprise security questionnaire | 1h 12m |

Default sort: `Attention` = failed → awaiting → degraded → offline → active → queued → idle, then by
elapsed descending. Two other sorts: `Name`, `Cost today`.

### 5.3 Agent detail — Atlas (`agt_eng_04`)

```
name: "Atlas"
agentId: "agt_eng_04"
runtime: { adapter: "OpenCode", version: "0.9.4", isolation: "firecracker-microvm", vcpu: 4, memoryGiB: 8 }
route: { reasoner: "claude-opus-4-5", engineer: "claude-sonnet-4-5", verifier: "gpt-5.1" }
state: "running"
currentRun: { runId: "run_01JB7Q2K8M4X", taskId: "tsk_01JB7P3N8Q", title: "Rotate refresh tokens in auth middleware",
              step: "4 of 9 · running tests", startedAt: "2026-11-13T04:04:11Z", elapsedMs: 862000 }
metrics24h: { runs: 14, succeeded: 13, failed: 1, medianMs: 760000, costUsd: 41.28, tokensIn: 2_412_880, tokensOut: 318_441 }
guardrails: { permission: "repo:write · branch:feature/* · no:merge-protected · no:deploy",
              budget: { perRun: 40.00, perDay: 120.00, spentToday: 41.28 },
              repos: ["reveilchat/backend", "reveilchat/infra"],
              environment: "sandbox:firecracker · 4 vCPU · 8 GiB · egress allowlist (pypi, npm)",
              rollback: "git revert + slot-2 traffic shift" }
concurrency: { maxParallelRuns: 2, queueDepth: 1 }
retry: { maxAttempts: 3, backoff: "exponential", jitter: true, retryOn: ["test-failure", "timeout"] }
lastHeartbeatAt: "2026-11-13T04:18:52Z"
```

### 5.4 Activity tab

**Step timeline** (vertical, 9 steps): `1 Plan` 00:41 ✓ · `2 Read 34 files` 01:12 ✓ · `3 Patch 7 files`
03:28 ✓ · `4 Run tests` running, 09:02 elapsed, 128/214 passed · `5 Verify` pending · `6 Lint` pending ·
`7 Security scan` pending · `8 Commit branch` pending · `9 Open PR` pending (requires approval).

**Recent tool calls** (table, 5 rows): `04:18:44 read_file services/auth/token.ts` 8ms ·
`04:18:41 apply_patch services/auth/rotate.ts +62 −18` 41ms ·
`04:17:02 run_tests --suite auth --shard 2` running · `04:15:19 grep "refresh_token" --include=*.ts` 1.2s ·
`04:12:33 read_file services/auth/session.ts` 6ms.

**Log tail** (compact, last 8 lines): `04:18:58 INFO  test auth/rotate.spec.ts › rotates on reuse (2.1s)` ·
`04:18:56 WARN  test auth/session.spec.ts › legacy cookie path skipped` ·
`04:18:52 INFO  128 passed, 0 failed, 86 pending`.

### 5.5 Handoffs tab

| From | To | Task | Reason | State | At |
|---|---|---|---|---|---|
| Atlas `agt_eng_04` | Audra `agt_audit_01` | WCAG audit of changed onboarding screens | Specialism routing | Completed | 03:12Z |
| Wren `agt_des_01` | Atlas `agt_eng_04` | Apply token changes to component CSS | Build required | Completed | 02:48Z |
| Kestrel `agt_eng_02` | Forge `agt_eng_07` | Partition `sessions` table | Needs infra scope | Failed | 03:41Z |
| Forge `agt_eng_07` | Atlas `agt_eng_04` | Retry partition migration | Capability escalation | Rejected | 03:44Z |
| Sift `agt_res_02` | Quill `agt_doc_02` | Draft findings summary | Output format | Awaiting approval | 01:20Z |

Handoff rejection is a first-class outcome: the receiving agent's reason is shown (`permission
ceiling: Atlas cannot write to reveilchat/infra`), not just the state.

### 5.6 Config tab

Routing rules table: `task.type = refactor → engineer: claude-sonnet-4-5` · `task.type = architecture →
reasoner: claude-opus-4-5` · `verification → gpt-5.1 (independent)` · `fallback → gemini-2.5-pro on
429/5xx` · `embeddings → qwen3-embedding-8b`.

The verifier rule is rendered with a lock glyph and the note `Independent verification cannot be
served by the executing model` — this is a hard constraint, not a preference.

---

## 6. States

| State | What renders |
|---|---|
| **Default** | §5. Atlas selected (first row). Activity tab. Live stream streaming. |
| **Empty** (no agents) | List pane: `EmptyState/first-run` — "No agents registered. An agent is a runtime plus a model route plus a permission ceiling." [Register an agent] [Use a template]. Detail pane: `EmptyState` explaining what an agent is with a 3-item anatomy list (runtime, route, guardrails). Fleet summary shows zeros with `—` for rates. Activity rail: `No activity.` |
| **Loading** | List: 12 skeleton rows at 56px. Detail: skeleton header + 3 timeline blocks + 5 table rows. Rail: 6 skeleton rows. Fleet summary: values as skeleton blocks, labels visible. Panes never collapse. |
| **Error** | List keeps its last good data with a stale marker. Detail: `ErrorState/region` — "Could not load agent detail. Runtime adapter `opencode` did not respond within 5s." [Retry] [Open runtime docs]. Rail independent: `Activity stream unavailable — reconnecting (2/5)`. |
| **Permission denied** | Operator without `agent:admin`: list and detail render fully, `Pause`, `Retire`, and `Config` tab actions are disabled with the required role shown in a persistent line under the header (`Changing routing requires the Platform admin role`) and in the tooltip. Viewing logs is not gated by that role. |
| **Offline** | `OfflineBanner`. List states freeze with `Last seen 04:12Z`; live stream shows `Disconnected — 3 attempts`; detail header shows `Cached` chip. Actions requiring the server (`Pause`, `Retry`) are disabled with reason `Requires connection`. |
| **Degraded** | `DegradedSystemBanner` naming the runtime adapter or model provider. Affected agents show `Routing fallback: gemini-2.5-pro` in the detail header and a `D` marker on their route chips. The stream shows an inline notice row: `Model provider degraded — 4 events delayed`. |

---

## 7. Interactions

### 7.1 Click paths

| Target | Result |
|---|---|
| List row | Selects the agent in place (no navigation); URL becomes `/agents/{id}` via `replaceState`; detail loads in the right pane |
| `⌘`/`Ctrl` + click a row | Opens the agent in a new tab at its canonical route |
| Assignment text in a row | Navigates to the run detail (stops row selection) |
| `Pause` (header) | `C7 Modal` — "Pause Atlas? 1 run continues to its next checkpoint (max 2m). 2 queued runs will be held. Rollback unaffected." Primary `Pause agent`; focus starts on `Keep running` |
| `Resume` | Immediate, no confirm; toast with `Undo` (8s) |
| `Retry` (failed run in detail) | Opens a retry dialog preselecting `from step 4`; states cost estimate (`+$1.80`) and that the failed attempt's artifacts are retained |
| Assignment chip | Navigates to the run |
| Route chips | Opens Model Intelligence filtered to that route |
| `⋯` header menu | Copy agent ID · View audit trail · View runs · Retire agent (destructive) |
| Artifact row | Opens the artifact drawer; a diff artifact opens `D1 DiffViewer` in the drawer at 560px |
| Handoff row | Opens the handoff transcript drawer: the request payload, the receiving agent's decision, and its reason |
| Activity event | Expands inline to the tool-call payload (arguments, result, duration); never navigates away |

`Retire agent` requires typing the agent name; it states that in-flight runs are cancelled and that
artifacts are retained and still auditable.

### 7.2 Keyboard

| Key | Action |
|---|---|
| `j` / `k` | Move down/up the agent list; detail follows selection |
| `Enter` | Focus the detail pane's first tab |
| `p` | Pause/resume the selected agent (opens confirm when pausing) |
| `r` | Retry the selected agent's last failed run |
| `t` | Cycle tabs (`Activity → Runs → Artifacts → Handoffs → Config`) |
| `a` | Jump to the activity rail's filter |
| `/` | Focus the agent filter |
| `⌘\` | Collapse/expand the activity rail |
| `Esc` | Return focus from the rail to the selected list row |

Tab order inside the detail: header actions → tablist → tab panel → rail. The rail is after the panel
in DOM order so a keyboard user reaches content before the stream.

### 7.3 Destructive actions

| Action | Guard |
|---|---|
| `Pause agent` | Confirm dialog; states affected runs and the checkpoint behaviour |
| `Cancel current run` | Confirm; states cost already spent and retained artifacts |
| `Retire agent` | Typed confirmation of the agent name; lists in-flight runs that will be cancelled |
| `Change routing` | Confirm dialog comparing cost and quality: `opus-4-5 → sonnet-4-5 saves ~62% per run; verifier independence is retained`. Never a silent switch. |

---

## 8. Responsive adaptations

| Breakpoint | Behaviour |
|---|---|
| **≥1440px** | Three panes as specified; rail 360px. |
| **1280–1439px** | Rail narrows to 320px; list 288px; detail min 560px. Fleet summary drops `median` and shows 4 metrics. |
| **1024–1279px** | Activity rail becomes a toggleable drawer (`⌘\`), closed by default, opened from a `Stream` button with a live dot. Panes: list 288 + detail fluid. Detail header metrics wrap to 2 rows. |
| **768–1023px** | List becomes a top horizontal strip of 12 chips (agent name + state dot + label, 44px tall, horizontally scrollable, snapping). Detail takes full width. Tabs scroll horizontally. The step timeline switches to a compact form: step number + title + state, durations right-aligned. Log viewer keeps 400px height. |
| **<768px (mobile)** | Agent list becomes a full-screen route (`/agents` shows the list, selecting pushes `/agents/{id}`). Fleet summary collapses to 2 metrics (running, stuck) with `More` disclosure. Detail tabs become a select. Activity rail is a bottom sheet at 60vh. `Config` is read-only with a note; `Pause` and `Retry` remain available. |

---

## 9. Evidence and traceability

- Every run started by an agent records: the triggering instruction, the resolved model per role, the
  runtime adapter and version, the sandbox image digest, the permission ceiling in force, and the
  approving human (or the policy rule that auto-approved). The detail header exposes this as an
  `Execution` popover reachable from the runtime chip.
- The `Config` tab is versioned: each routing change is a diff against the previous version, with
  author, timestamp, and the eval scores at the time of the change. Routing changes appear in
  `/{wsp}/security/audit` under `class: model-routing`.
- Handoff transcripts are immutable. A rejected handoff retains the receiver's reason, because "the
  agent declined" is an operational fact worth auditing.
- The activity stream is append-only and is not the audit log: it is capped at 500 events in the UI,
  with `Open full audit` linking to `/{wsp}/security/audit?agent={agt}`.
- Stream rows that are fixture-generated carry a `Simulated` chip in the rail header, not per row.

---

## 10. Accessibility notes

- **Three-pane keyboard model.** Panes are landmarks: `<nav aria-label="Agents">`,
  `<main aria-label="Agent detail">`, `<aside aria-label="Live activity">`. Each is reachable by a
  skip link, so a keyboard user does not tab through 12 rows to reach the detail.
- **Live region.** The stream is `aria-live="polite"` with a 3s throttle; when paused, new events are
  announced once as `14 new events, stream paused`, never one announcement per event.
- **Elapsed timers.** Rendered as `<time>` with a visually hidden absolute start time; the visible
  ticking value is `aria-hidden="true"` so screen readers are not interrupted every 10 seconds.
- **Status independence.** List rows encode state with pill + label + left icon; a row with `Failed`
  also carries the words `Needs intervention`, so the stuck agent is findable by text search.
- **Route chips.** Each chip has an accessible name combining role and model: `Reasoner:
  claude-opus-4-5`. The arrow glyph between chips is `aria-hidden`.
- **Log viewer.** A labelled `role="log"` region with `aria-live="off"` (following is opt-in and
  announced when toggled). Level is conveyed by the level word, not only colour.
- **Focus return.** Closing the activity drawer, any modal, or the artifact drawer returns focus to
  the element that opened it. Pausing an agent moves focus to the status pill so the state change is
  announced in context.
- **Target size.** List rows are 56px (well above 24px). Tab hit areas are 36px tall.
