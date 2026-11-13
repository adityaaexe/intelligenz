# 04 — Research Lab

> Route: `/{workspace}/research` · Detail: `/{workspace}/research/{campaignId}`
> Finding: `/{workspace}/research/{campaignId}/findings/{findingId}`
> Components referenced here are defined in `../COMPONENT-INVENTORY.md`.

---

## 1. Purpose

The research engine's working surface. A campaign is a question with a budget, a retrieval window, a
set of sources, and a set of claims whose confidence is earned from that evidence. The screen's job is
to make it impossible to read a claim without also seeing how well it is supported and what is missing.

**Primary jobs**

| Persona | Job |
|---|---|
| Founder / operator | Decide whether to act on a finding, and know what would change the answer |
| Enterprise lead | Verify that a recommendation cites primary sources with dates, not vendor marketing |
| Agency owner | Turn a campaign into a client-facing report without re-checking the sources |

**The five-second question:** *What do we know, how sure are we, and what is the evidence?*

The finding ledger must show, per claim: the confidence value, the source count, and its state
(supported / contested / insufficient). Coverage gaps must be visible without opening a panel — a
research surface that hides its gaps is a liability.

---

## 2. Layout

Base 1440×900. Campaign list 320px, campaign detail fluid, evidence rail 400px.

```
┌ topbar 56 ────────────────────────────────────────────────────────────────┐
├ scopebar 40 ──────────────────────────────────────────────────────────────┤
│ Screen header 64  Research Lab        9 campaigns · 3 with gaps            │
│                                      [New campaign]                        │
├───────────────┬───────────────────────────────────┬───────────────────────┤
│ CAMPAIGNS 320 │ CAMPAIGN DETAIL                   │ SOURCES 400           │
│               │                                   │                       │
│ filter 40     │ ┌ header 128 ───────────────────┐ │ [Sources|Coverage]    │
│ cmp row 72    │ │ Runtime adapter comparison…   │ │                       │
│ cmp row 72    │ │ Active · 41d window · $18/$25 │ │ ⚠ 2 unreachable       │
│ cmp row 72    │ │ coverage 78% · 3 gaps         │ │ ⚠ 6 stale (>30d)      │
│ …             │ └───────────────────────────────┘ │ ───────────────────   │
│               │ coverage strip 88                 │ src row 56            │
│               │ ───────────────────────────────── │ src row 56            │
│               │ findings ledger (table) 6 rows    │ …                     │
│               │ ───────────────────────────────── │                       │
│               │ selected finding panel 240        │                       │
│               │ ───────────────────────────────── │                       │
│               │ comparison table 320              │                       │
├───────────────┴───────────────────────────────────┴───────────────────────┤
│ footer 32  retrieval window 2026-10-02 → 2026-11-12 · corpus 1.2M docs     │
└───────────────────────────────────────────────────────────────────────────┘
```

| Region | Size | Contents |
|---|---|---|
| Screen header | 64px | Title, `9 campaigns · 3 with coverage gaps`, primary `New campaign` |
| Campaign list | 320px | Filter 40px, 9 rows × 72px, own scroll |
| Campaign header | 128px | Question (18px), status pill, owner agent, retrieval window, budget meter, coverage score, actions `Publish report` / `Re-run` / `⋯` |
| Coverage strip | 88px | 4 metrics + `3 known gaps` disclosure |
| Findings ledger | fluid, min 320px | `DataTable` 6 rows, expandable; selection drives the panel below |
| Selected finding panel | 240px | Statement, confidence block, disconfirming evidence, `Open finding` |
| Comparison | 320px | `DataTable` comparing 4 runtimes on 5 criteria, with source counts per cell |
| Sources rail | 400px | Tabs `Sources` / `Coverage`; problem sources pinned at top; provenance rows |
| Footer | 32px | Retrieval window, corpus size, last verification run |

The detail pane scrolls as one column; the rail and list scroll independently.

---

## 3. Information hierarchy

| Priority | Element | Treatment |
|---|---|---|
| 1 | Coverage score + gap count | `78% coverage · 3 gaps` at 16px beside the campaign title; gaps in `--iz-status-awaiting-fg` |
| 2 | Finding confidence | `B3 ConfidenceIndicator` at the start of each row's second line; `0.87 · 12 sources` |
| 3 | Claim text | 13px `--iz-ink-1`, max 2 lines in the table, full in the panel |
| 4 | Finding state | `Supported` / `Contested` / `Insufficient evidence` text + glyph, never colour alone |
| 5 | Source health | Rail header: `2 unreachable · 6 stale` in the status stems |
| 6 | Comparison | Coverage per cell; a cell with one source is marked `thin` |
| 7 | Retrieval window | Footer and campaign header; always absolute dates |

The loudest thing on this screen is not the claim — it is the coverage. That is deliberate: a
confident claim drawn from a thin corpus is the failure mode this product exists to prevent.

---

## 4. Component composition

| Region | Components |
|---|---|
| Shell | `A1 AppShellChrome`, `A2 SidebarNav`, `A4 ScopeBar`, `A5 ModeIndicator` |
| Header | Buttons (`Publish report`, `New campaign`), `C8 DropdownMenu` (overflow), `C3 FilterChips` |
| Campaign list | `C2 FilterBar/minimal`, `C1 DataTable` (or list of rows), `B1 StatusPill`, `B3 ConfidenceIndicator/compact`, `E5 CodeIDChip`, `F1 EmptyState`, `F2 SkeletonLoader` |
| Campaign header | `A9 Breadcrumb`, `B1 StatusPill`, `E5 CodeIDChip` (campaign + agent), `D7 CostUsageMeter`, `D8 BudgetBar`, `B4 MetricTile/inline` (coverage), `C7 Modal` (publish, re-run) |
| Coverage strip | `B4 MetricTile/panel` ×4, `B6 DistributionBar` (source type mix), `C9 Tooltip` |
| Findings ledger | `C1 DataTable` (sortable, expandable), `B3 ConfidenceIndicator`, `B1 StatusPill`, `E5 CodeIDChip`, `C2 FilterBar` |
| Selected finding panel | `B3 ConfidenceIndicator/block`, `D2 EvidenceList/compact`, `D3 SourceProvenanceRow` (contradicting sources), `C4 Tabs` (Supporting / Contradicting / Method) |
| Comparison | `C1 DataTable`, `B6 DistributionBar` (per-row source mix), `B3 ConfidenceIndicator/compact` |
| Sources rail | `C4 Tabs`, `D3 SourceProvenanceRow` ×n, `D2 EvidenceList`, `F3 ErrorState/inline` (unreachable group), `C3 FilterChips` (source type filter) |
| States | `F1`–`F6` |

---

## 5. Data model

### 5.1 Campaign list (9)

| Campaign | Status | Findings | Avg confidence | Coverage | Window | Budget |
|---|---|---|---|---|---|---|
| Runtime adapter comparison for enterprise isolation | Active | 6 | 0.74 | 78% · 3 gaps | 41d | $18.00 / $25.00 |
| Buyer expectations for on-prem AI tooling, EU mid-market | Active | 11 | 0.81 | 86% · 1 gap | 22d | $9.40 / $20.00 |
| Competitive pricing: 6 agent platforms | Completed | 9 | 0.88 | 91% · 0 gaps | 30d | $14.20 / $20.00 |
| Auth token rotation: current best practice | Completed | 7 | 0.93 | 94% · 0 gaps | 14d | $4.10 / $10.00 |
| Mobile onboarding drop-off causes | Completed | 5 | 0.66 | 61% · 4 gaps | 28d | $11.80 / $15.00 |
| WCAG 2.2 failures in fintech dashboards | Active | 4 | 0.71 | 69% · 3 gaps | 9d | $3.20 / $12.00 |
| Temporal vs custom durable execution | Completed | 8 | 0.84 | 88% · 1 gap | 35d | $7.60 / $15.00 |
| Vector DB cost at 50M embeddings | Degraded | 3 | 0.52 | 44% · 6 gaps | 60d | $16.90 / $18.00 |
| Open-source agent runtimes: licence risk | Completed | 6 | 0.79 | 82% · 2 gaps | 26d | $5.50 / $10.00 |

Default sort: `Active` first, then `Degraded`, then `Completed` by recency. `Degraded` is used when
more than 20% of sources are stale or unreachable — it is a data-health state, not a workflow state.

### 5.2 Campaign header (`cmp_01JB6R2T8K`)

```ts
{
  campaignId: "cmp_01JB6R2T8K",
  title: "Runtime adapter comparison for enterprise isolation",
  question: "Which agent runtime gives the strongest sandbox isolation per dollar for private deployment?",
  state: "active",
  owner: { agentId: "agt_res_02", name: "Sift", runtime: "Pi" },
  startedAt: "2026-10-02T09:00:00Z",
  retrievalWindow: { from: "2026-10-02", to: "2026-11-12" },
  budget: { used: 18.00, ceiling: 25.00, currency: "USD" },
  coverage: { score: 0.78, gaps: 3, sources: 42, primarySources: 11, stale: 6, unreachable: 2 },
  corpus: { documents: 1_204_880, lastIndexedAt: "2026-11-13T02:10:00Z" },
  outputs: [{ reportId: "rpt_01JB6Z8Q", state: "draft", updatedAt: "2026-11-12T17:40:00Z" }]
}
```

Coverage score is defined, not vibes: `0.4 × primary-source ratio + 0.3 × freshness ratio + 0.3 ×
question-coverage ratio`, where question-coverage is the share of sub-questions with ≥2 independent
sources. The definition is available in a `C9 Tooltip` on the score and in the methodology tab of any
published report.

### 5.3 Findings ledger (6)

| Claim | Confidence | Sources | State | Last verified |
|---|---|---|---|---|
| Firecracker microVMs give the strongest isolation per dollar for single-tenant deployment | 0.87 · High | 12 | Supported | 2026-11-11 |
| OpenHands requires outbound egress for dependency resolution in 3 of 5 configurations | 0.72 · Moderate | 7 | Supported | 2026-11-10 |
| Pi runtime has no published independent security audit as of 2026-10 | 0.61 · Moderate | 4 | **Coverage gap** | 2026-11-09 |
| Codex runtime cold-start is 2.4× slower than OpenCode at 4 vCPU | 0.44 · Low | 3 | **Contested** | 2026-11-06 |
| Per-run isolation cost is $0.0031 at 8 GiB, 4 vCPU | 0.38 · Insufficient | 2 | Insufficient evidence | 2026-11-04 |
| Egress allowlisting is supported by all five runtimes, with different default postures | 0.79 · Moderate | 9 | Supported | 2026-11-12 |

`Contested` and `Coverage gap` are not status stems; they are finding states rendered with a
`B1 StatusPill` using `awaiting` and `degraded` stems respectively, plus the word. `Supported` uses
the `completed` stem. This keeps the palette closed.

### 5.4 Selected finding (`fnd_01JB6S4M2Q`)

```ts
{
  findingId: "fnd_01JB6S4M2Q",
  claim: "Firecracker microVMs give the strongest isolation per dollar for single-tenant deployment",
  confidence: { value: 0.87, band: "high", sourceCount: 12, stale: false, oldestSourceAt: "2026-09-18" },
  state: "supported",
  reasoning: "Three independent benchmarks and two vendor architecture documents agree on isolation properties; cost per run is 31% below the nearest alternative at equal vCPU and memory.",
  assumptions: [
    "Single-tenant deployment is the requirement (multi-tenant changes the isolation calculus)",
    "8 GiB / 4 vCPU is representative of the workload",
    "Vendor-published benchmarks are directionally reliable; two were cross-checked against independent runs"
  ],
  disconfirming: [
    { claim: "Firecracker cold-start adds 1.8s per run, which dominates at <30s runs", sourceId: "src_01JB6T9X", strength: "moderate" },
    { claim: "gVisor narrows the isolation gap at 40% lower operational complexity", sourceId: "src_01JB6V2R", strength: "weak" }
  ],
  whatWouldChangeIt: "A published independent penetration test showing a Firecracker escape, or a workload profile where runs are shorter than 45s."
}
```

`whatWouldChangeIt` is mandatory on every finding above 0.6 confidence. A finding without a stated
disconfirmation path is treated as an assertion, and the UI labels it that way.

### 5.5 Sources (42; rail shows 8 problem + recent)

| # | Title | Domain | Published | Retrieved | Type | Status |
|---|---|---|---|---|---|---|
| 1 | Firecracker: secure and fast microVMs (design doc) | `firecracker-microvm.github.io` | 2024-06-11 | 2026-10-04 | primary | retrieved |
| 2 | gVisor vs Firecracker isolation benchmark, 2026 | `arxiv.org` | 2026-03-18 | 2026-10-06 | primary | retrieved |
| 3 | AWS Lambda isolation architecture | `docs.aws.amazon.com` | 2026-01-22 | 2026-10-04 | vendor | retrieved |
| 4 | Agent runtime security posture survey | `nccgroup.com` | 2026-08-30 | 2026-10-11 | primary | retrieved |
| 5 | OpenHands deployment requirements | `docs.all-hands.dev` | 2026-09-02 | 2026-10-12 | vendor | **unreachable** (403 since 11-09) |
| 6 | Codex runtime benchmarks | `github.com/openai/codex` | 2026-05-14 | 2026-10-19 | primary | **stale** (208d old) |
| 7 | Pi runtime security FAQ | `pi.dev` | 2025-11-03 | 2026-10-02 | vendor | **stale** (375d old) |
| 8 | Enterprise agent platform pricing, 2026 | `gartner.com` | 2026-07-01 | 2026-10-08 | secondary | **paywalled** (abstract only) |
| 9 | Sandbox escape CVE roundup 2026 | `nvd.nist.gov` | 2026-10-28 | 2026-11-02 | primary | retrieved |
| 10 | Community thread: Firecracker cold-start | `news.ycombinator.com` | 2026-09-19 | 2026-10-04 | forum | retrieved (low weight) |

Problem sources are pinned above healthy ones, in three labelled groups: `Unreachable (2)`,
`Stale (6)`, `Paywalled (1)`. They are never collapsed by default and never hidden behind a filter that
is off by default.

### 5.6 Coverage panel (rail tab 2)

**Known gaps — 3, all disclosed**

1. No primary source for Pi's isolation implementation. Vendor FAQ is 375 days old and marketing-grade.
   *Mitigation: excluded from the recommendation ranking; labelled `unverified` in the comparison.*
2. No published enterprise-tier pricing for two of five vendors (quote-only). Cost comparison uses
   list price for the remaining three and marks the others `not comparable`.
3. Retrieval window closed 2026-11-12; anything published after that date is not represented.
   *Risk: a new CVE or a new entrant would not appear.*

**Freshness:** 6 of 42 sources are older than 30 days; 2 are older than 180 days. The oldest is 375
days. Freshness ratio in the coverage score: 0.81.

**Independence:** 42 sources across 19 domains; the top domain contributes 5 sources (12%). Single-domain
over-representation triggers a warning at 25%.

### 5.7 Comparison table

| Criterion | Firecracker | gVisor | OpenHands (sandbox) | Codex | Pi |
|---|---|---|---|---|---|
| Isolation strength | Strong | Strong | Moderate | Moderate | Unknown |
| Cold start | 1.8s | 0.9s | 3.1s | 4.3s | 2.2s |
| Cost per 8 GiB run | $0.0031 | $0.0044 | $0.0028 | $0.0051 | not comparable |
| Egress default | deny | allow | allow | allow | deny |
| Independent audit | Yes (2) | Yes (3) | No | No | **No — gap** |
| Sources | 12 | 9 | 7 | 6 | 4 |

Every cell carries a source count in `title`/`aria-label`; cells with fewer than 3 sources get a
`thin` marker (1px dotted underline) and a tooltip `2 sources — treat as indicative`.

---

## 6. States

| State | What renders |
|---|---|
| **Default** | §5. Campaign 1 selected; findings ledger; rail on `Sources`; problem sources pinned. |
| **Empty** (no campaigns) | List: `EmptyState/first-run` — "No research campaigns. A campaign is a question, a retrieval window, and a budget; findings appear as sources are verified." [New campaign] [Start from a template]. Detail: `EmptyState` explaining the three inputs, with a 4-step preview (define question → set window → collect → verify). Rail: empty. Footer: `No corpus yet`. |
| **Loading** | List: 9 skeleton rows at 72px. Header: skeleton title (2 lines) + 4 metric blocks. Ledger: 6 skeleton rows. Panel: 3 blocks. Rail: 8 skeleton rows. Footer keeps its height with a skeleton line. |
| **Error** | List keeps last good data. Header renders from cache with `Cached` chip. Ledger: `ErrorState/region` — "Could not load findings. The research service timed out after 20s." [Retry]. Rail: `Source index unavailable — showing 34 of 42 cached sources` with a stale marker on each. The screen never shows a claim without saying the evidence set is incomplete. |
| **Permission denied** | Viewer without `research:read_confidential`: public campaigns render fully; confidential campaigns appear in the list with a lock glyph and `Restricted` instead of the title, and opening one renders `PermissionDeniedState/module` — "This campaign is restricted to the Research analyst role." Titles of restricted campaigns are not disclosed. |
| **Offline** | `OfflineBanner`. All data reads from cache with `Cached 04:12Z`. `Re-run verification` and `Re-verify source` are disabled with `Requires connection`; publishing a report is disabled with the same reason (a report must cite a verified evidence set). Reading, filtering, expanding, and comparing remain fully functional. |
| **Degraded** | `DegradedSystemBanner` — "Source retrieval degraded: 2 sources unreachable since 09 Nov. Coverage for 1 campaign dropped by 6 points. Findings citing affected sources are marked `stale`." Affected findings show their confidence band with a `Stale · 41d` suffix in `--iz-status-awaiting-fg`, and the campaign's coverage score shows the delta (`78% · was 84%`). |

---

## 7. Interactions

### 7.1 Click paths

| Target | Result |
|---|---|
| Campaign row | Select in place; URL `?id=`; detail + rail load |
| Coverage score | `C9 Tooltip` with the formula and its three components; link `Methodology` |
| `3 gaps` | Switches the rail to `Coverage` and scrolls to `Known gaps` |
| Finding row | Expands the selected-finding panel below (single selection); does not navigate |
| Finding row `Open` | Navigate to `/research/{cmp}/findings/{fnd}` — the full finding record with all evidence |
| Confidence value | Popover: value, band, source count, oldest source age, and the coverage sub-score that produced it |
| Claim text with citation marker | Opens the evidence drawer at the cited source, with the exact supporting excerpt |
| `Contradicting (2)` | Switches the panel tab to Contradicting; the two sources are listed with their strength rating |
| Source row | Opens the source in a new tab, with an interstitial note `External source opens in a new tab`. For unreachable sources the row expands to the last successful snapshot (archived 2026-11-02) |
| `Publish report` | `C7 Modal` — check boxes for including gaps, method, and raw evidence appendix; states that a report with unresolved gaps is labelled `Partial evidence` on its cover |
| `Re-run` | Confirm; states cost estimate (`~$3.20`), that existing findings are preserved with their original retrieval dates, and that new sources are added to the same corpus |
| Comparison cell | Popover with the supporting source list for that cell |

### 7.2 Keyboard

| Key | Action |
|---|---|
| `j` / `k` | Move through campaigns when the list has focus; through findings when the ledger has focus |
| `Enter` | Select the focused campaign or expand the focused finding |
| `Enter` on an expanded finding | Open the full finding record |
| `s` | Switch the rail to Sources and focus the first row |
| `c` | Switch the rail to Coverage |
| `f` | Focus the findings filter |
| `⌘⏎` | Open `Publish report` for the current campaign |
| `Esc` | Collapse the finding panel; return focus to the row |
| `⌘\` | Toggle the rail |

Tab order: campaign list → header actions → coverage strip (each metric links) → findings table →
finding panel → comparison → rail.

### 7.3 Destructive actions

| Action | Guard |
|---|---|
| `Re-run campaign` | Confirm; states cost, that the retrieval window will extend to today, and that findings are versioned not overwritten |
| `Archive campaign` | Confirm; states that published reports remain available and their evidence links remain resolvable |
| `Remove source` | Confirm with reason; states that any finding citing it will have its confidence recalculated and its state may drop to `Insufficient` |

Publishing is not destructive but is guarded: a report is an external artefact and cannot be
un-shared once exported.

---

## 8. Responsive adaptations

| Breakpoint | Behaviour |
|---|---|
| **≥1440px** | Three panes as specified. |
| **1280–1439px** | List 288px, rail 360px. Comparison table becomes horizontally scrollable with the criterion column sticky. |
| **1024–1279px** | Rail becomes a drawer toggled by a `Sources 42` button with the problem count (`· 8 issues`). Coverage strip drops to 3 metrics and folds `primary sources` into the tooltip. Finding panel and comparison stack below the ledger. |
| **768–1023px** | Campaign list becomes a horizontal chip strip (240px cards, scroll-snap) above the detail. Findings table drops to 4 columns: Claim, Confidence, Sources, State; `Last verified` moves into the expanded panel. Comparison becomes a per-runtime card stack (5 cards) rather than a matrix. |
| **<768px (mobile)** | Campaign list is a route; campaign detail is a route. Header compresses: title + coverage + gaps. Coverage strip becomes 2×2. Findings render as a list of claim + confidence + source count, tap to expand. Comparison is a table with horizontal scroll inside a labelled region, or a select to choose one runtime. Rail is a bottom sheet at 70vh, opening on `Sources`. Reading and disclosing gaps remain complete; publishing requires tablet width or above, with an explicit note. |

---

## 9. Evidence and traceability

- **Every finding is a claim plus evidence, never a claim alone.** The table's confidence cell is a
  link to the evidence set; the source count is never decorative.
- **Provenance is complete.** Each source shows publisher domain, publication date, retrieval date,
  source type, and status. Retrieval dates are mandatory — a source without one is a defect and is
  rendered as `Retrieval date missing` in `--iz-status-failed-fg`.
- **Failed and stale sources are disclosed by default.** The rail pins them, the campaign header counts
  them, and the published report includes them in a `Limitations` section. This is the brief's
  non-negotiable and it is enforced at the component level, not by author discipline.
- **Contradiction is a first-class state.** `Contested` findings show the contradicting sources with a
  strength rating, and the finding record requires a `whatWouldChangeIt` field above 0.6 confidence.
- **Coverage gaps are named, not scored away.** Three textual gaps with mitigation, plus the freshness
  and independence ratios. A coverage score without its gaps listed would be a vanity metric.
- **Report lineage.** A published report records the campaign version, the retrieval window, the
  evidence-set hash, and the model route used for synthesis. Changing any of those produces a new
  report version rather than editing the old one.
- **Simulated data.** The campaigns in the prototype are fixtures; the campaign header carries
  `Simulated` when fixtures are active, and no external URL is fetched.

---

## 10. Accessibility notes

- **Confidence is redundant by design.** Value (`0.87`), band word (`High`), and meter segments (5/5).
  Removing colour changes nothing. `Insufficient evidence` is a full phrase, not an icon.
- **Finding state** uses a pill with glyph + word; `Contested` and `Coverage gap` are distinguishable
  from `Supported` by text alone.
- **Tables.** `<caption>` states the count and sort (`Findings, 6 claims, sorted by confidence
  descending`). Sortable headers expose `aria-sort`. Each confidence cell has an accessible name:
  `Confidence 0.87, high, 12 sources, oldest source 56 days old`.
- **External links.** `D3 SourceProvenanceRow` links carry `target="_blank" rel="noopener"` and an
  accessible name ending in `opens in a new tab`; the visible `↗` glyph is `aria-hidden`.
- **Unreachable sources.** Announced as part of the rail header (`2 sources unreachable`), and each row
  states its status in text plus the date it became unreachable.
- **Comparison table.** A real `<table>` with `<th scope="col">` and `<th scope="row">`; each cell's
  source count is in the accessible name, so a screen-reader user hears `Strong, 12 sources`.
- **Live updates.** Re-verification results arrive asynchronously; the ledger's caption region is
  `aria-live="polite"` and announces `2 findings updated` once, not per row.
- **Focus.** Expanding a finding moves no focus (the panel is adjacent and read next in DOM order);
  opening the full record navigates and focuses the `<h1>`. The rail drawer traps focus only on mobile.
- **Reduced motion.** Panel expansion becomes instant; no confidence meter animates to its value.
- **Zoom.** At 400%, the comparison matrix scrolls within its labelled region; the findings table
  becomes a definition list of claim / confidence / sources / state; the rail stacks below the detail.
  Nothing on this screen requires a pointer.
