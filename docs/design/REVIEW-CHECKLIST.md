# INTELLIGENZ — Review Checklist

> Run this against `prototype/index.html` before accepting the Phase 1b handoff.
> Report findings by section number. Anything that fails a **must** item blocks handoff.

---

## 1. How to run the review

1. Open `prototype/index.html` directly (double-click). Do not use a server for the primary pass —
   the `file://` path is a requirement, not a fallback.
2. Set the window to **1440 × 900** for the base pass, then repeat §6 at 1024, 768, and 390.
3. Keep the browser console open for the whole pass. **Zero errors, zero warnings** is the bar.
4. Dismiss the first-run notice with `Dismiss` (it is inline, not modal, and reappears on reload).
5. For state coverage, open the account menu → **State inspector**, or navigate to `#/states`.

Time budget: 25–35 minutes for a full pass.

---

## 2. Checklist

### 2.1 Shell and navigation

| # | Check | Must |
|---|---|---|
| 2.1.1 | Skip link is the first `Tab` stop, becomes visible on focus, and moves focus to `<main>` | must |
| 2.1.2 | Sidebar shows 4 pinned destinations and 4 groups containing 12 further modules (16 total) | must |
| 2.1.3 | Group headers toggle with `aria-expanded` and the correct `aria-controls` target | must |
| 2.1.4 | Current destination carries `aria-current="page"` on every route, including deep links | must |
| 2.1.5 | At 1024–1279 the sidebar is a 64px icon rail; every icon has a tooltip and an accessible name | must |
| 2.1.6 | Below 1024 the sidebar is an off-canvas drawer; the hamburger opens it, the scrim and `Esc` close it | must |
| 2.1.7 | Scope bar shows workspace, project, environment, branch, and the `Simulated data` chip | must |
| 2.1.8 | Below 640 the scope bar drops project and branch but keeps workspace, environment, and the simulated chip | must |
| 2.1.9 | Mode indicator changes require confirmation and record a toast | should |
| 2.1.10 | Workspace, project, environment, and branch menus open, are keyboard reachable, and close on outside click / `Esc` | should |

### 2.2 Overview

| # | Check | Must |
|---|---|---|
| 2.2.1 | Five-second read: posture word, awaiting count, spend against ceiling are all above the fold | must |
| 2.2.2 | Posture strip shows 5 cells; values are tabular and do not animate | must |
| 2.2.3 | Runs table fits 7 columns at 1440 with no horizontal scroll and no truncated duration/cost | must |
| 2.2.4 | Status filters add removable chips and update the count (`n of 8 runs`) | must |
| 2.2.5 | Text filter narrows rows live without a re-render or losing focus | must |
| 2.2.6 | Sorting by cost re-orders and moves focus to the sort button | must |
| 2.2.7 | Row expansion reveals step, tokens, branch, repository, model, started, task, and the run note | must |
| 2.2.8 | Row selection updates the bulk bar count; select-all works | should |
| 2.2.9 | Needs-you cards link to the specific approval; the Critical card is tinted and labelled | must |
| 2.2.10 | Cost panel shows two budget bars, a distribution with legend, and a labelled sparkline | must |
| 2.2.11 | Decisions ledger distinguishes human (seal stamp), agent, and policy actors | should |
| 2.2.12 | Agent fleet cards show state, assignment, runtime, and success rate | must |

### 2.3 Agent Command Centre

| # | Check | Must |
|---|---|---|
| 2.3.1 | 12 agents listed; the failed agent sorts to the top and states `Needs intervention` | must |
| 2.3.2 | Selecting an agent updates the detail pane and the URL | must |
| 2.3.3 | Tabs switch Activity / Runs / Artifacts / Handoffs / Config | must |
| 2.3.4 | Activity shows a 9-step timeline with the active step marked, a tool-call table with headers, and a log tail | must |
| 2.3.5 | Handoffs show the receiving agent's rejection reason, not just a state | should |
| 2.3.6 | Config shows all five guardrails, the model route with the verifier constraint, and a versioned change note | must |
| 2.3.7 | Live stream is labelled `Streaming`, pauses at 1024, and shows 14 events | should |
| 2.3.8 | Pause opens a confirm dialog that states checkpoint behaviour | must |

### 2.4 Approvals

| # | Check | Must |
|---|---|---|
| 2.4.1 | Queue shows 4 items: awaiting, awaiting, awaiting, and one `Blocked`; risk is visible per row | must |
| 2.4.2 | Risk filter (All / Critical / High / Medium) narrows the queue | should |
| 2.4.3 | Detail shows the action, blast radius, records, environment, cost impact | must |
| 2.4.4 | All five guardrails are present and complete; a missing value would render `Not declared` and block approval | must |
| 2.4.5 | Policy checks show passes as well as the warning/failure, with policy IDs | must |
| 2.4.6 | Diff is collapsed by default, expands in place, and uses `+`/`−` markers in addition to tint | must |
| 2.4.7 | Evidence rail header states `n items · x verified · y failed · z unverified`; failed items are visible without filtering | must |
| 2.4.8 | Approve on a High-risk item completes, toasts, and advances the queue | must |
| 2.4.9 | Approve on the Critical item is refused until the acknowledgement is checked **and** the 6-character ID is typed exactly | must |
| 2.4.10 | Reject refuses without a reason and a note of ≥12 characters | must |
| 2.4.11 | Request changes refuses without an instruction of ≥12 characters | must |
| 2.4.12 | The blocked item cannot be approved; the failing policy is named in the decision bar | must |
| 2.4.13 | No bulk approve exists anywhere | must |
| 2.4.14 | Lineage tab shows upstream task/plan/goal and downstream run/artifacts/evidence/audit | should |

### 2.5 Research Lab

| # | Check | Must |
|---|---|---|
| 2.5.1 | 9 campaigns listed with state, finding count, average confidence, coverage, and gap count | must |
| 2.5.2 | Coverage strip shows coverage, sources, freshness, independence — all four visible at 1440 | must |
| 2.5.3 | The three known gaps are rendered with title, detail, and mitigation | must |
| 2.5.4 | Findings ledger shows claim, confidence (value + band + source count), state, and verified date | must |
| 2.5.5 | Selecting a finding updates the detail panel; Supporting / Contradicting / Method tabs all render | must |
| 2.5.6 | The contradicting tab lists disconfirming evidence with a strength rating | must |
| 2.5.7 | The method tab states assumptions and `what would change it` | must |
| 2.5.8 | Comparison table marks thin cells and every cell carries a source count in its tooltip/accessible name | should |
| 2.5.9 | Sources rail pins unreachable and stale sources above healthy ones, with retrieval dates | must |
| 2.5.10 | Coverage tab repeats the gaps, freshness, and independence disclosures | should |

### 2.6 States

| # | Check | Must |
|---|---|---|
| 2.6.1 | Empty renders for all four screens with an explanation and an action | must |
| 2.6.2 | Loading renders skeletons at the final dimensions and is held for inspection | must |
| 2.6.3 | Error renders at region level with a retry and a trace ID | must |
| 2.6.4 | Permission-denied names the required role and the owner | must |
| 2.6.5 | Offline shows a banner, cached markers, and queued decisions | must |
| 2.6.6 | Degraded changes the posture word and names the failing dependency | must |
| 2.6.7 | The preview bar is visible in every non-live state and returns to live in one click | must |

### 2.7 Keyboard and accessibility

| # | Check | Must |
|---|---|---|
| 2.7.1 | Keyboard-only: reach the skip link, nav, scope bar, table, and dialog without a pointer | must |
| 2.7.2 | Focus is always visible (2px ring, 2px offset) and never clipped by `overflow:hidden` | must |
| 2.7.3 | Dialogs trap focus, close on `Esc`, and return focus to the trigger | must |
| 2.7.4 | `⌘K` / `Ctrl+K` opens the palette; arrows move; `Enter` runs; `Esc` closes | must |
| 2.7.5 | Status is never colour-only: every pill has a glyph and a label; risk has segment count + word | must |
| 2.7.6 | Icon-only controls all carry `aria-label` and a tooltip | must |
| 2.7.7 | Tables use `<caption>`, `<th scope>`, and `aria-sort`; expandable rows use `aria-expanded`/`aria-controls` | should |
| 2.7.8 | `prefers-reduced-motion: reduce` removes the stream pulse, skeleton shimmer, and row flash | must |
| 2.7.9 | At 200% zoom the layout reflows without horizontal page scroll | should |
| 2.7.10 | Colour-blind simulation (deuteranopia) leaves every status distinguishable by glyph + text | should |

### 2.8 Responsive

| # | Check | Must |
|---|---|---|
| 2.8.1 | 1440: no horizontal scroll on any of the four screens | must |
| 2.8.2 | 1024: rail sidebar; Approvals and Agent CC drop their right rail; no horizontal scroll | must |
| 2.8.3 | 768: sidebar off-canvas; Agent list becomes a horizontal strip; tables keep status + name | must |
| 2.8.4 | 390: single column; runs table shows status + run + actions only; nothing clipped | must |
| 2.8.5 | Touch targets ≥44px on layouts ≤1024; ≥24px on desktop | should |
| 2.8.6 | Search trigger keeps its full label above 900px and collapses to icon + `⌘⇧F` at ≤900 (icon only at ≤640); the child never exceeds the control's height and the accessible name survives every collapse | must |

### 2.9 Constraints

| # | Check | Must |
|---|---|---|
| 2.9.1 | `grep -rn 'type="module"\|http://\|https://\|//cdn' prototype/` returns nothing | must |
| 2.9.2 | `node --check` passes on all three JS files | must |
| 2.9.3 | Works with the network disabled and from `file://` | must |
| 2.9.4 | No `fetch`, `XMLHttpRequest`, `WebSocket`, or dynamic `import()` in `prototype/` | must |
| 2.9.5 | Reloading resets all mutations (no persistence) | must |

---

## 3. Known limitations

Stated plainly. None of these is hidden in the UI.

1. **No backend, no persistence.** Every mutation is in memory. Reloading restores the fixtures.
2. **No auth or permissions.** The permission state is a visual preview; nothing is enforced.
   "M. Okafor" is a fixture.
3. **Run detail screens are out of scope.** A run row expands in place via a real disclosure button
   (cost, duration, repository, model, branch and tokens are inside); "Open run" explains that the
   detail route is not part of this slice.
4. **Only Atlas (`agt_eng_04`) has a full execution trace.** The other 11 agents have real registry
   rows; selecting them shows a labelled notice rather than fabricated steps.
5. **Evidence records are a fixture drawer, not a real artifact viewer.** Each record shows its
   `evd_…` id, source path, producer, produced-at, retrieval window, verdict, and the claim it
   supports; "Open full artifact" is a placeholder.
6. **Only one research campaign has a full evidence set.** The other 8 campaigns show registry data
   with a labelled notice.
7. **12 of 16 destinations are placeholders.** They render a module header and an explicit "not part
   of this slice" state. The IA is complete; the build is not.
8. **Scope switching is simulated.** Menus open and toasts confirm, but workspace/project/environment
   do not change the data.
9. **Global search and palette search a local array**, not an index. No file-content search.
10. **Diff viewer is simplified.** Unified only, no split view, no syntax highlighting, 3 hunks per
   file, no virtualisation.
11. **No virtualised tables.** 8–12 rows per screen; large datasets would need TanStack Virtual.
12. **Charts are static SVG.** Sparklines and the distribution bar have accessible labels but no
    hover tooltips beyond native `title`.
13. **Notifications are static.** Read/unread is seeded, not live; the badge does not decrement.
14. **The activity stream does not append.** It is a fixed 14-event slice, marked `Streaming`.
15. **No i18n.** Copy is English and hard-coded; dates are fixed strings, not locale-formatted.
16. **Below 768px is read-and-decide.** Approving, filtering and reading work; creation and editing
    flows (Workflow Studio graph authoring, agent Config, schedule creation) are desktop-width only.
17. **First-run notice reappears on reload** if the browser blocks `localStorage` on `file://`. It is
    inline and dismissible, not modal.
18. **Dark theme is implemented but only token-verified.** The light theme is the reviewed surface;
    dark inherits the same tokens with the contrast values measured in `DESIGN.md` §4.8, but no
    screen was visually reviewed in dark mode.
19. **The scope-bar summary collapses below 1100px.** From 768–1099 the full line
    (`3 awaiting · budget 31% · updated 04:19:02Z`) is replaced by a linked chip that keeps the
    approval count and budget percentage visible; the "updated" timestamp is dropped. Below 768 the
    chip shows the count alone (38px). The chip links to Approvals, and the full summary returns at
    1100px. The branch chip is hidden below 900px to make room for it; the branch remains visible in
    an expanded run row.
20. **No screen-reader session was performed.** Accessibility conclusions come from DOM inspection,
    computed styles, keyboard traversal, and axe-core; they are not a substitute for testing with
    NVDA, JAWS or VoiceOver.

---

## 4. Deviations from the Phase 1a specs

### 4.1 QA fix pass (DS-004) — findings resolved

Independent design QA returned FAIL on seven blocking issues. All were fixed in the prototype; the
verification for each is in the table.

| Finding | Resolution | Proof |
|---|---|---|
| B1 — sidebar labels vanish below 1280px; rail links have no accessible name | Rail rules scoped to `(min-width:1024px) and (max-width:1279.98px)`; drawer restores labels; every nav link carries `aria-label`, `title`, and (in rail mode) `data-tip` | 390px drawer: 16 visible labels, 16 named links; axe `link-name` = 0 at 390 and 1024 |
| B2 — closed off-canvas sidebar is focusable | Closed drawer is `visibility: hidden`; open drawer `visibility: visible` | 768px tab walk: 16 stops, none inside `#sidebar`, no negative-x stop |
| B3 — run detail rows never expand | Per-row disclosure button with `aria-expanded` / `aria-controls`, 24px, Enter/Space native; `⋯` menu adds Show/Hide details; cost and duration repeated inside the expanded row | At 390px the toggle is visible, expansion renders `Cost $1.87`; no overflow |
| B4 — approval evidence rows are inert | Every evidence item has a stable `evd_…` id; rows are buttons that open an evidence drawer with source, producer, produced-at, retrieval window, verdict, approval link, and the claim it supports | `evd_01JB8M_01` opens the drawer with source + produced + retrieval present |
| B5 — permission-denied leaks spend | Posture spend cell renders `Restricted`; scope bar renders `budget restricted` | Page text contains no `186.40` in the permission state |
| B6 — agent registry ignores `attention` sort | Real sort (failed → degraded → awaiting → active → queued → offline), `Needs intervention` flag on failed rows, and a menu control with `aria-haspopup`/`aria-expanded` and checked options | Forge (failed) first, then Sift (degraded), then Echo/Kestrel (awaiting); Name sort re-orders alphabetically |
| B7 — type and target floors breached | No `font-size` below 11px in CSS or inline; metric unit 0.85em; sort buttons and segmented/mode options 24px; checkboxes 16px in a 24px hit box | `grep` for 9px/10px returns 0; rendered minimum is 11px; sort 24px; checkbox 16/24 |
| N2 | Approval title and campaign question demoted to `h2`; duplicate “Needs you” heading removed | One `h1` per screen |
| N3 | `Status:` prefix on pills, `Risk:` prefix and score label on risk badges, visible Passed/Warning/Failed word on policy rows | Accessible text reads `Status: Awaiting approval`, `Risk: Critical · score 84` |
| N6 | Confidence meter banded: ≥0.80 = 5/5, ≥0.70 = 4/5, ≥0.60 = 3/5, ≥0.40 = 2/5, insufficient = 0 | 0.87 → 5, 0.72 → 4, 0.61 → 3, 0.38 → 0 |
| N23 | Costs formatted with thousands separators | `$3,142.00`, not `$3142.00` |
| N24 | Active status filters render as chips with a remove button | Chip has `aria-label="Remove filter: Failed"`; removing clears the filter |

Two defects were found while fixing the above and are also resolved: click-opened menus were being
closed immediately by the delegated handler (fixed with a just-opened guard), and the agent strip at
≤1023px leaked its scroll width into the document (fixed with `contain: paint` plus an internal
scroller).

### 4.2 Declared deviations

These remain deliberate, and each has a reason. The specs should be updated to match if accepted.

| Spec | Build | Why |
|---|---|---|
| Overview runs table: 9 columns incl. Repository, Model, Started | 7 columns; repository, model, started, branch, tokens, cost and duration are repeated in the **expanded row**, which is now wired through a per-row disclosure (`aria-expanded` / `aria-controls`, keyboard operable) and a Show details menu item | 9 columns cannot fit a 768px region at 13px without collapsing the title column. The spec's own column-priority rule mandates this order of sacrifice. Expansion is the load-bearing part of the deviation: without it, cost and duration would be unreachable at ≤639px where those columns are hidden. |
| Approvals: queue 360 + detail fluid + rail 400 | queue 300 + detail fluid + rail 340 | At 1440 with a 264px sidebar the detail pane falls to 368px, which is unusable for diffs. The build keeps the detail ≥500px. |
| Agent CC: list 320 + detail + rail 360 | list 272 + detail + rail 320, and the Activity tab stacks | Same arithmetic. The activity rail stays visible at 1440 (the spec's priority) and the detail stacks its two columns instead of squeezing them. |
| Research: findings ledger as a data table | Findings ledger as a list of claim rows with state, confidence, and verified date | A 5-column table in a 528px pane truncates the claim to 15 characters. The list keeps the full claim, the confidence with source count, and the state legible. |
| First-run notice as a modal | Inline callout on Overview, with the full notice available from the `Simulated data` chip | A modal on load traps focus before the skip link can be reached, which fails the keyboard-only pass. |
| Rail groups: flyout on hover/focus at 1024–1279 | **Fixed:** rail is scoped to 1024–1279 with icon + `aria-label` + `title` + tooltip; below 1024 the drawer restores the full text labels; the closed drawer is `visibility: hidden` and leaves the tab order | Hover flyouts are not reliably keyboard-reachable. Restoring labels in the drawer removes the unlabelled-icon problem the first build had. |

## 5. Open questions for the founder

1. **Approval authority.** Should a Critical approval ever be single-approver? The build enforces two
   approvers plus typed confirmation. If a sole operator must be able to clear it, the flow needs an
   explicit break-glass path with post-hoc review.
2. **Autopilot ceiling.** The build shows `max risk Medium` as the ceiling before work queues. Is the
   ceiling per workspace, per project, or per workflow? The UI currently implies workspace-level.
3. **Currency and billing.** Costs are USD and static. Is multi-currency required at launch, and does
   the operator see list price or contracted rate?
4. **Evidence retention.** How long must an evidence set remain resolvable after a decision? The
   review screen promises permanent links; storage cost is the constraint.
5. **Agent count.** The registry shows 12. Is the real deployment expected to run tens or hundreds?
   Above ~50 the list needs search, grouping, and virtualisation that are not built.
6. **Research freshness window.** The campaign degrades when >20% of sources are stale. Is 30 days
   the right default per vertical, or should it be set per campaign?
7. **Report audience.** Reports are generated for clients. Should the client-facing export hide
   internal risk scores and agent names, or show the full decision record?
8. **Tenancy model.** The IA assumes tenant → workspace → project → environment. Does a private
   deployment have exactly one tenant, and should the tenant selector disappear entirely there?
9. **Mode transitions.** Should switching to Autopilot require a second human (four-eyes), or is the
   owner's confirmation sufficient?
10. **Marketplace trust.** Installing a third-party agent implies a permission ceiling. Should
    installs be approvals themselves, routed through the same queue?

---

## 6. Sign-off

| Section | Result | Reviewer | Date |
|---|---|---|---|
| 2.1 Shell | | | |
| 2.2 Overview | | | |
| 2.3 Agent CC | | | |
| 2.4 Approvals | | | |
| 2.5 Research | | | |
| 2.6 States | | | |
| 2.7 Keyboard / a11y | | | |
| 2.8 Responsive | | | |
| 2.9 Constraints | | | |

Handoff is accepted when every **must** row is `pass`, or a documented exception is signed by the
founder.
