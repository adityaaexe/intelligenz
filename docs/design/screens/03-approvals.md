# 03 — Approvals

> Route: `/{workspace}/approvals` · Detail: `/{workspace}/approvals/{approvalId}`
> Components referenced here are defined in `../COMPONENT-INVENTORY.md`.

---

## 1. Purpose

The governance surface. Every material change that an agent proposes stops here until a human decides.
Trust is produced on this screen, so evidence and traceability outrank polish — and polish must not be
absent.

**Primary jobs**

| Persona | Job |
|---|---|
| Founder / operator | Clear the queue quickly and correctly, without reading code they cannot judge |
| Enterprise lead | Prove that a control existed: who decided, on what evidence, against which policy |
| Agency owner | Show a client exactly what changed in their environment and why |

**The five-second question:** *What needs my decision, and is the evidence sufficient to make it?*

Two things must be legible before any scrolling: the risk of the top item, and whether its evidence is
complete. An approval that cannot be judged from this screen is a failure of the screen, not of the
reviewer.

---

## 2. Layout

Base 1440×900. Three panes, fixed–fluid–fixed.

```
┌ topbar 56 ────────────────────────────────────────────────────────────────┐
├ scopebar 40 ──────────────────────────────────────────────────────────────┤
│ Screen header 64   Approvals          3 awaiting · oldest 3h 12m           │
│                    [All|Critical|High|Medium]  [Risk▾]  [Assign to me]     │
├───────────────┬───────────────────────────────────┬───────────────────────┤
│ QUEUE 360     │ APPROVAL DETAIL                   │ EVIDENCE / LINEAGE 400│
│               │                                   │                       │
│ card 96       │ ┌ title block 112 ──────────────┐ │ [Evidence|Lineage]    │
│ card 96       │ │ apr_01JB8M3XQ2      High · 68  │ │                       │
│ card 96       │ │ Merge token-rotation refactor  │ │ 12 items              │
│ …             │ │ Atlas · 22m · prod             │ │ 9 verified            │
│               │ └────────────────────────────────┘ │ 2 failed              │
│ sticky footer │ guardrails 5 rows, 152px           │ 1 unverified          │
│ 48: 3 selected│ ─────────────────────────────────  │ ───────────────────   │
│               │ sections: change 1 · cost 2 ·      │ evidence rows         │
│               │ policy 3 · rollback 4 · evidence 5 │ (scroll)             │
│               │ · audit 6                          │                       │
│               │                                   │                       │
├───────────────┴───────────────────────────────────┴───────────────────────┤
│ DECISION BAR 64 sticky  [Request changes] [Reject]        [Approve merge]  │
└───────────────────────────────────────────────────────────────────────────┘
```

| Region | Size | Contents |
|---|---|---|
| Screen header | 64px | Title, live summary (`3 awaiting · 1 critical · oldest 3h 12m`), risk filter `SegmentedControl`, sort `DropdownMenu` (Risk / Age / Cost), `Assign to me` |
| Queue pane | 360px fixed | `ApprovalCard/queue-row` × n, 96px each, own scroll, sticky pane footer with selection state |
| Detail | fluid, min 600px | Title block 112px (sticky), `GuardrailSummary` 152px, six sections, own scroll |
| Evidence rail | 400px | Tabs `Evidence` / `Lineage`; sticky tab bar 36px; own scroll |
| Decision bar | 64px, sticky to viewport bottom | Secondary actions left, primary right, policy note centre |

The detail pane and the rail scroll independently. The decision bar overlays the bottom of the detail
and rail panes (not the queue), with `padding-bottom: 64px` reserved on both scroll containers so no
content is permanently hidden.

---

## 3. Information hierarchy

| Priority | Element | Treatment |
|---|---|---|
| 1 | Risk level + score | `RiskBadge` 4 segments + `Critical · 84` at 16px, in the title block, first element after the ID |
| 2 | Evidence sufficiency | Rail header line: `9 of 12 verified · 2 failed`; failed items are never collapsed |
| 3 | The action, in one sentence | 16px `--iz-ink-1`, directly under the title; generated from the proposal, not free text |
| 4 | Blast radius | Files, repos, environments, services, rows affected — as a 4-field row |
| 5 | Guardrails | Five fixed rows, 24px each; `Not declared` blocks approval |
| 6 | Policy checks | Grouped: `4 passed · 1 warned · 0 failed`, expandable |
| 7 | Cost impact | Cost meter + monthly delta |
| 8 | Diff | On demand — a summary line (`+128 −64 · 7 files`) with `Review diff` opening the full viewer inline |
| 9 | Audit history | Last section, chronological |

The diff is deliberately *not* first. Most approvals are judged on the action, the blast radius, and
the evidence; the diff is for the minority who read code. Making the diff the loudest element would
make the screen unusable for the founder persona.

---

## 4. Component composition

| Region | Components |
|---|---|
| Shell | `A1 AppShellChrome`, `A2 SidebarNav`, `A4 ScopeBar`, `A5 ModeIndicator`, `A8 NotificationCentre` |
| Header | `C5 SegmentedControl` (risk filter), `C8 DropdownMenu` (sort), `C3 FilterChips` (active filters), button `Assign to me` |
| Queue | `C11 ApprovalCard/queue-row` ×n, `B2 RiskBadge`, `B1 StatusPill`, `E5 CodeIDChip`, `F1 EmptyState`, `F2 SkeletonLoader`, `A9 Breadcrumb` (in detail, not queue) |
| Title block | `A9 Breadcrumb`, `E5 CodeIDChip`, `B2 RiskBadge`, `B1 StatusPill`, `D4 GuardrailSummary/compact` (summary line only) |
| Detail body | `D4 GuardrailSummary` (full), `C4 Tabs` (section anchor nav, mobile), `D1 DiffViewer`, `D7 CostUsageMeter`, `D8 BudgetBar`, `D5 PolicyCheckRow/group`, `D2 EvidenceList`, `E4 Timeline/event-log` (audit history), `C1 DataTable` (affected files), `C9 Tooltip` (IDs, truncated paths) |
| Evidence rail | `C4 Tabs` (Evidence / Lineage), `D2 EvidenceList`, `D3 SourceProvenanceRow` (for external sources), `D6 LineageTraceRail`, `B3 ConfidenceIndicator` (evidence completeness), `F1 EmptyState` |
| Decision bar | Buttons (primary/secondary/destructive), `C9 Tooltip` (disabled reasons), inline policy note |
| Overlays | `C7 Modal/dialog` (approve confirm, reject reason, request changes), `C10 Toast`, `C7` (bulk assign) |
| States | `F1`–`F6` |

---

## 5. Data model

### 5.1 Queue item (`apr_01JB8M3XQ2`)

```ts
{
  approvalId: "apr_01JB8M3XQ2",
  title: "Merge token-rotation refactor into reveilchat/backend",
  action: "merge",                       // merge | deploy | delete | schema-change | permission-grant | publish | spend
  risk: { level: "high", score: 68, factors: [
    { label: "production environment", weight: 18 },
    { label: "auth surface", weight: 22 },
    { label: "7 files changed", weight: 9 },
    { label: "no prior incident in this area", weight: -6 },
    { label: "rollback tested", weight: -12 }
  ]},
  state: "awaiting",
  requestedBy: { type: "agent", agentId: "agt_eng_04", name: "Atlas", runtime: "OpenCode" },
  requestedAt: "2026-11-13T03:56:40Z",
  ageMs: 1_320_000,
  runId: "run_01JB7Q2K8M4X",
  taskId: "tsk_01JB7P3N8Q",
  blastRadius: {
    files: 7, additions: 128, deletions: 64,
    repos: ["reveilchat/backend"],
    services: ["auth-api", "session-worker", "gateway"],
    environments: ["prod"],
    recordsAffected: 0
  },
  costImpact: { runtimeUsd: 0, monthlyDeltaUsd: 0, note: "No infrastructure change" },
  guardrails: {
    permission: "repo:write · branch:feature/* · no:merge-protected · no:deploy",
    budget: { perRun: 40.00, used: 12.40, perDay: 120.00 },
    repos: ["reveilchat/backend"],
    environment: "sandbox:firecracker · 4 vCPU · 8 GiB · egress allowlist (pypi, npm)",
    rollback: "git revert 8f2c1a4 + slot-2 traffic shift (tested 03:52Z)"
  },
  policyChecks: [
    { policyId: "pol_auth_change_v4", name: "Auth surface requires second approver", status: "warn",
      message: "Second approver required: S. Idris (Release role)", evaluatedAt: "03:56:41Z" },
    { policyId: "pol_branch_protect_v2", name: "Protected branch merge path", status: "pass",
      message: "Merge via PR only; direct push blocked", evaluatedAt: "03:56:41Z" },
    { policyId: "pol_secret_scan_v3", name: "Secret scan on diff", status: "pass",
      message: "0 findings across 128 added lines", evaluatedAt: "03:56:42Z" },
    { policyId: "pol_test_gate_v2", name: "Test gate", status: "pass",
      message: "214/214 passing on the merge commit", evaluatedAt: "03:57:10Z" },
    { policyId: "pol_audit_trail_v1", name: "Decision recorded", status: "pass",
      message: "Audit entry will be written on decision", evaluatedAt: "03:56:41Z" }
  ],
  evidence: { total: 12, verified: 9, failed: 2, unverified: 1 },
  requiredApprovers: 2,
  approvalsReceived: [{ name: "M. Okafor", role: "Owner", at: "04:02Z" }]
}
```

`requiredApprovers: 2` with one received is the reason the primary button reads `Approve merge`
disabled with the note `1 of 2 approvals · second approver: S. Idris`. A single approver cannot clear
an auth-surface change.

### 5.2 Diff (inline summary + expanded)

```
services/auth/rotate.ts        modified  +62 −18
services/auth/token.ts         modified  +31 −22
services/auth/session.ts       modified  +14 −9
services/auth/rotate.spec.ts   added     +18 −0
services/auth/__snapshots__/…  modified  +3 −15
config/auth.yaml               modified  +0 −0   (mode change 100644 → 100755)
docs/auth-token-rotation.md    added     +0 −0
```

Full viewer opens with three visible hunks by default:

```diff
@@ -41,8 +41,14 @@ export async function rotate(refreshToken: string) {
-  const session = await store.get(refreshToken);
-  if (!session) throw new AuthError('invalid_token');
-  await store.delete(refreshToken);
-  return issue(session.userId);
+  const session = await store.get(refreshToken);
+  if (!session) throw new AuthError('invalid_token');
+  if (session.reusedAt) {
+    await audit.record('token_reuse', { userId: session.userId, tokenId: session.id });
+    await store.revokeFamily(session.familyId);
+    throw new AuthError('token_reuse_detected');
+  }
+  await store.markUsed(refreshToken);
+  return issue(session.userId, { familyId: session.familyId });
```

The reuse-detection branch is the substantive change and it is 6 lines. A reviewer can judge it without
reading the other 186.

### 5.3 Policy checks (rendered group)

`4 passed · 1 warning · 0 failed`. The warning row is expanded by default because it is the only one
that changes what the reviewer must do. Passing rows show their message but are collapsed to 24px.

### 5.4 Evidence list (12 items)

| # | Kind | Label | Producer | Age | State |
|---|---|---|---|---|---|
| 1 | test-run | `214/214 passing · merge commit 8f2c1a4` | CI (`github-actions`) | 21m | verified |
| 2 | test-run | `auth suite · 92 tests · 1.8s` | Atlas (`agt_eng_04`) | 22m | verified |
| 3 | diff | `7 files · +128 −64` | Atlas | 22m | verified |
| 4 | policy-eval | `pol_secret_scan_v3 · 0 findings` | Policy engine | 21m | verified |
| 5 | log | `sandbox transcript · 1,204 lines` | Runtime `opencode` | 22m | verified |
| 6 | artifact | `coverage report · auth 91.4%` | Atlas | 22m | verified |
| 7 | artifact | `benchmark · p95 118ms (target 120ms)` | Atlas | 20m | verified |
| 8 | human-note | `M. Okafor: reviewed rotate.ts, approved direction` | M. Okafor | 16m | verified |
| 9 | policy-eval | `pol_branch_protect_v2 · pass` | Policy engine | 21m | verified |
| 10 | test-run | `e2e · 3 of 41 flaky, retried, 41/41 final` | CI | 19m | **failed** (initial attempt) |
| 11 | artifact | `rollback rehearsal · slot-2 shift 03:52Z` | Forge (`agt_eng_07`) | 26m | **failed** (drill exceeded 90s budget) |
| 12 | log | `linter · 2 warnings (unused import)` | Atlas | 22m | unverified |

Evidence 10 and 11 are failures that do not block the decision but must be read: they are rendered at
the top of the "Needs attention" group in the rail, with their failure output one click away. Evidence
11 being a failed rollback drill is material — the reviewer sees it before the approve button.

### 5.5 Audit history

| At | Actor | Event |
|---|---|---|
| 03:56:40Z | Atlas `agt_eng_04` | Proposal created from `run_01JB7Q2K8M4X` step 8 |
| 03:56:41Z | Policy engine | 5 checks evaluated · 1 warning |
| 03:57:10Z | CI | Test gate passed on merge commit |
| 04:02:18Z | M. Okafor | First approval recorded (1 of 2) |
| 04:11:02Z | System | Reminder sent to S. Idris (second approver) |

---

## 6. States

| State | What renders |
|---|---|
| **Default** | Queue of 3 (Critical, High, Medium), first selected, detail as §5, rail on `Evidence`. |
| **Empty** | Queue: `EmptyState/cleared` — "No approvals waiting. Queue cleared at 04:02Z by M. Okafor." Detail: `EmptyState` — "Select an approval from the queue. Approvals appear when an agent proposes a material change." Rail: empty. Header summary reads `0 awaiting · median decision 18m`. |
| **Loading** | Queue: 3 skeleton cards at 96px. Detail: skeleton title block, 5 guardrail rows, 3 section blocks. Rail: 5 skeleton rows, tab bar visible. Decision bar renders disabled with skeleton labels — never absent, so the layout does not jump. |
| **Error** | Queue keeps last good data with a stale marker. Detail: `ErrorState/region` — "Could not load approval detail. The approvals service returned 504 after 30s." [Retry] [Copy trace ID]. Rail: `Evidence unavailable — cannot approve without evidence` and the approve action is disabled with that reason. This is the correct failure mode: no evidence, no approval. |
| **Permission denied** | Viewer without `approval:decide`: full read access to the proposal, diff, evidence, and audit; decision bar replaced by `PermissionDeniedState/action` — "Approving requires the Approver role. Request access from M. Okafor (workspace owner)." The queue still renders (visibility is not the same as authority). |
| **Offline** | `OfflineBanner`. Queue and detail read from cache with `Cached 04:12Z` in the title block. Decision bar remains enabled, and decisions are queued: after tapping, the button becomes `Queued — will submit on reconnect` with a disabled state and the row in the queue gains a `Queued` marker. A queued decision is never shown as final. |
| **Degraded** | `DegradedSystemBanner` — "Evidence verification degraded: 2 of 12 items could not be re-verified. Critical approvals are blocked until verification recovers." For risk High and below, approval remains possible with an explicit `Approve without re-verification` secondary action that requires a reason. For Critical, the action is disabled with the reason shown. |

---

## 7. Interactions

### 7.1 Decision flows

**Approve (default path).**

1. Reviewer selects an item (queue row or `j`/`k`).
2. Becomes familiar: title, action, blast radius, guardrails, policy, evidence rail.
3. `Approve merge` → `C7 Modal` `confirm`:
   - Title: `Approve merge into reveilchat/backend?`
   - Body: three lines — `1 repo · 3 services · prod` / `Rollback: git revert 8f2c1a4 + slot-2 shift (tested 03:52Z)` / `This records your name in the audit trail.`
   - If `requiredApprovers > 1`: the modal states `This records approval 1 of 2. S. Idris must approve before merge executes.`
   - Buttons: `Cancel` (focused) and `Approve merge`.
4. On confirm: optimistic row state → `Approving…`; on success the row moves out of the queue with a
   200ms fade, the next item is selected automatically, and a toast appears with `Open audit entry`.
5. Failure: modal stays open with an inline `role="alert"` error and a retry; the queue row returns to
   `Awaiting approval`.

**Approve Critical.** Same, plus: a required checkbox `I have reviewed the failed evidence item
(rollback drill, 03:52Z)` and typed confirmation of the approval's short ID (`8M3XQ2`). The primary
button stays disabled until both are satisfied.

**Reject.** `C7 Modal` `form` with a mandatory reason `Selectbox` (Incorrect approach · Insufficient
evidence · Policy violation · Out of scope · Duplicate) plus a free-text note (min 12 chars, max 600)
that is shown to the requesting agent. States `Rejection is recorded permanently and returned to the
agent as feedback.` On confirm, the run is returned to `Awaiting input`, not cancelled.

**Request changes.** `C7 Modal` `form` with a required instruction field (min 12 chars) and an
optional `Re-run from step` selector. Creates a new run from the selected step, linked as a child of
the original; the approval stays open and shows `Changes requested · awaiting new run`.

**Bulk.** No bulk approve, ever. Selection supports `Assign to me` and `Copy IDs` only. The queue's
footer shows `3 selected` with those two actions.

### 7.2 Click paths

| Target | Result |
|---|---|
| Queue row | Select in place; URL `?id=` updates via `replaceState`; detail + rail load |
| Risk badge | Popover with the score's factor breakdown (the five weighted factors) |
| `run_…` chip | Navigate to the run detail (leaves Approvals; queue state preserved in the URL) |
| Guardrail value | Opens the relevant config: permission → Security policy, budget → Limits, env → Integrations |
| `Review diff` | Expands `D1 DiffViewer` inline (full width of the detail pane), with `Collapse` |
| File row in diff header | Jumps to that file's hunks |
| Evidence item | Opens the evidence drawer (400px over the rail) with the payload; `Open full artifact` inside |
| Failed evidence item | Opens expanded by default in the drawer, showing the failure output first |
| `Lineage` tab | Swaps the rail to `D6 LineageTraceRail`: upstream task/plan/goal, downstream artifacts and audit |
| Policy row | Opens the policy in Security in a new tab (`⌘`-click behaviour preserved) |
| Audit row | Opens the audit entry in Security |
| `Assign to me` | Immediate, toast with `Undo` (8s) |

### 7.3 Keyboard

| Key | Action |
|---|---|
| `j` / `k` | Next / previous approval in the queue |
| `Enter` | Move focus into the detail's first interactive element |
| `a` | Approve the focused approval (opens the confirm dialog; never approves directly) |
| `r` | Reject (opens the reason dialog) |
| `c` | Request changes (opens the instruction dialog) |
| `d` | Toggle the diff viewer |
| `e` | Focus the evidence rail; `j`/`k` then move through evidence |
| `l` | Switch the rail to Lineage |
| `⌘⏎` / `Ctrl+⏎` | Confirm the currently open dialog |
| `Esc` | Close the topmost layer; return focus to the queue row or the triggering control |
| `⌘\` | Collapse/expand the rail (below 1280px it toggles as a drawer) |

The single-key shortcuts (`a`, `r`, `c`) are active only when focus is inside the queue or the detail
pane, never while a text field has focus, and never on the login or settings surfaces.

### 7.4 Destructive actions

| Action | Guard |
|---|---|
| Approve | Confirm dialog; Critical requires checkbox + typed ID |
| Reject | Mandatory reason; states permanence; returns work to the agent |
| Request changes | Mandatory instruction; creates a linked run |
| `Withdraw my approval` (after approving, before execution) | Confirm; states that execution will not proceed |

Approval is treated as destructive-if-wrong even though it creates rather than deletes: the guard is
about consequence, not about deletion.

---

## 8. Responsive adaptations

| Breakpoint | Behaviour |
|---|---|
| **≥1440px** | Three panes as specified. Decision bar spans detail + rail. |
| **1280–1439px** | Rail narrows to 360px; queue to 320px; detail min 520px. The rail's tabs remain. Decision bar spans the full width below the panes. |
| **1024–1279px** | Rail becomes a bottom sheet at 60vh, opened by an `Evidence (9/12)` button in the title block; it overlays the detail. Queue 320px + detail fluid. Title block metrics wrap to two rows. |
| **768–1023px** | Queue becomes a horizontal strip of cards above the detail (96px tall, scroll-snap, 280px wide each) so the selected item stays visible. Detail full width. Decision bar sticky at 64px with three buttons at 44px height. Diff becomes unified and horizontally scrollable inside a labelled region. |
| **<768px (mobile)** | Queue is a route (`/approvals`), detail is a route (`/approvals/{id}`) with a back link. Title block compresses to ID + risk + title. Sections become an accordion: `Action`, `Guardrails`, `Policy`, `Evidence`, `Diff`, `Audit` — Action and Guardrails open by default. Decision bar becomes a fixed footer with `Approve` primary and `Reject`/`More` in an overflow. Critical approval remains possible on mobile (the confirmation is reachable) because blocking it would force unsafe desktop use. Diff: unified, no horizontal scroll beyond the hunk, `+`/`−` prefixes retained. |

---

## 9. Evidence and traceability

- **Every claim links to an `evd_` record.** The action sentence, the test gate, the rollback drill, the
  benchmark — each is a row in the evidence list, not a sentence in a paragraph.
- **Failed evidence is never hidden.** Two failures exist in the default dataset specifically to prove
  the pattern: the rail sorts `failed` first, the tab shows `2 failed` in the tab label, and Critical
  approvals require an explicit acknowledgement of the failure the reviewer saw.
- **Provenance on external evidence.** Any evidence sourced outside the workspace (vendor docs, CVE
  feeds) uses `D3 SourceProvenanceRow` with publisher, publication date, and retrieval date.
- **Decision record.** On decision, the approval becomes immutable and renders a decision block:
  decision verb, actor (human or policy), timestamp, reason, evidence set hash, policy versions
  evaluated, and the seal stamp in `--iz-seal` for human decisions. The hash makes tampering detectable
  in export.
- **Export.** `Export decision record` produces a PDF/JSON containing the diff summary, the full
  evidence list with timestamps, all policy checks with versions, the guardrails in force, and the
  audit chain. The scope bar's workspace/project/environment is stamped in the header; the file is
  named `apr_01JB8M3XQ2_decision_2026-11-13.pdf`.
- **Lineage.** The `Lineage` tab proves the chain: goal → plan → task → run → this approval → the audit
  entries that will be written. A reviewer can see the instruction that caused the change without
  leaving the screen.

---

## 10. Accessibility notes

- **Three landmarks.** `<nav aria-label="Approval queue">`, `<main aria-label="Approval detail">`,
  `<aside aria-label="Evidence">`. Skip links at the top of the screen reach each.
- **Queue semantics.** The queue is a `<ul>` of links, not a listbox: each row is an `<a>` to the
  canonical URL, with `aria-current="true"` on the selected one. This makes `⌘`-click, open-in-new-tab,
  and screen-reader list navigation work natively. `j`/`k` move DOM focus between the links.
- **Risk is not colour-only.** Segments (count) + word + numeric score. In greyscale, `High · 68` is
  still unambiguous.
- **Evidence completeness announced.** The rail's header is a `role="status"` region: `12 evidence
  items: 9 verified, 2 failed, 1 unverified`.
- **Diff accessibility.** Each hunk is a `<table>` with `role="presentation"` avoided — instead a
  definition-style structure: `<div role="group" aria-label="Hunk 2 of 3, services/auth/rotate.ts,
  lines 41 to 54">` with each line as a row containing a visually hidden prefix (`Added:`, `Removed:`,
  `Context:`). Colour is supplementary. Line numbers are `aria-hidden`.
- **No auto-approve.** `Enter` never approves. `⌘⏎` only confirms an already-open dialog, and the
  dialog's default focus is `Cancel`.
- **Dialog behaviour.** Native `<dialog>` with `showModal()`, focus trapped, `Esc` closes, scroll
  locked, `aria-labelledby` and `aria-describedby` wired. Returning focus goes to the button that
  opened it; after a successful decision, focus moves to the next queue row so the flow continues
  without a pointer.
- **Time.** Ages are relative on screen with absolute UTC in `title` and accessible name; the audit
  table is absolute only.
- **Contrast.** Body text ≥9.4:1; meta at 6.13:1; the Critical row tint `#FAF1F0` keeps ink-1 at
  16.13:1. The seal stamp is 6.11:1 on canvas.
- **Reduced motion.** The queue's row-exit fade becomes an instant removal; the rail's tab switch
  becomes instant; no content is gated on an animation completing.
- **Zoom.** At 400%, the decision bar remains reachable (it is sticky and its buttons wrap to two rows
  at 320px); the diff scrolls within its own labelled region; the queue and rail become stacked
  sections in DOM order (queue → detail → evidence), which matches the reading order.
