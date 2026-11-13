# INTELLIGENZ — Information Architecture

> Companion to `DESIGN.md`. Defines the navigation model, scope model, routing, search boundaries,
> object lineage, and notification taxonomy for the Control Centre.
>
> **Module count reconciliation.** `BRIEF.md` §2 says "13 modules" but enumerates 15:
> Overview, Projects, Agent Studio, Model Intelligence, Research Lab, Code Intelligence,
> Design Intelligence, Workflow Studio, Schedules, Knowledge Base, Creative Studio, Reports,
> Integrations, Security, Marketplace. The enumerated list is authoritative. **Approvals** is
> specified as a full screen in §3.3 but omitted from that list, so it is treated as a
> first-class destination here. That gives **16 primary destinations**, all covered below.

---

## 1. The scope model

Four nested levels. Scope is never implicit — it is encoded in the URL, rendered in the scope bar,
and stamped into every export.

| Level | Object | ID prefix | Set by | Visible as |
|---|---|---|---|---|
| Tenant (organisation) | `org` | `org_` | Account owner, in account menu | Account name in the sidebar header, above the workspace switcher |
| Workspace | `wsp` | `wsp_` | Workspace switcher | Scope bar, first chip |
| Project | `prj` | `prj_` | Scope bar project selector | Scope bar, second chip |
| Environment | — | — | Scope bar environment selector | Scope bar, third chip, with a distinct tint: `prod` uses `--iz-status-failed-fg` text, `staging` uses `--iz-status-awaiting-fg`, `dev` uses `--iz-ink-3`. |

An agency owner runs one workspace per client (`wsp_reveilchat`, `wsp_northwind`). An enterprise lead
runs one workspace with many projects and stricter policy. The tenant level exists so billing,
members, and audit export can span workspaces.

### 1.1 Scope bar behaviour

- Always rendered, always visible from 640px up. Height `--iz-scopebar-h` (40px).
- Contents left to right: workspace chip · project chip (with `All projects` option) · environment
  chip · git branch/revision chip where the screen is repo-bound · right side: `Simulated` marker
  when fixtures are active, plus the current mode summary (`Copilot · budget 69%`).
- Changing workspace is a full navigation (`/{newWorkspace}/overview`) and preserves the current
  module if it exists in the target workspace; otherwise falls back to Overview with a toast
  explaining the fallback.
- Changing project or environment is an in-place update to the current screen's query string; the
  screen re-fetches without a route change.
- A workspace whose policy forbids `prod` access for the current role shows the environment chip
  disabled with a lock glyph and a tooltip naming the required role.

### 1.2 Scope visibility rule

Every page title region repeats the scope in a subtitle line (`wsp_reveilchat › prj_control-plane ›
prod`), in `--iz-text-xs` `--iz-ink-3`, linked to each level. This is redundant with the scope bar by
design: screenshots, exports, and screen-shares lose the bar, and an approval without visible scope
is an approval without meaning.

---

## 2. Navigation model

### 2.1 Sidebar anatomy

```
┌────────────────────────────┐  ← --iz-color-chrome, 264px
│ INTELLIGENZ        [org ▾] │  56px  tenant header + account menu
│ [ ◧ ReveilChat      ▾ ]    │  40px  workspace switcher
├────────────────────────────┤
│ ▦  Overview                │  pinned, 32px rows
│ ◇  Approvals            3  │  badge = items awaiting *me*
│ ⬡  Agent Command Centre    │
│ ▤  Projects                │
│                            │
│ ENGINEERING            ⌄   │  group header, 11px/500/uppercase, --iz-on-chrome-2
│  ⟨⟩ Code Intelligence      │
│  ✎  Design Intelligence    │
│  ✦  Creative Studio        │
│  ⛓  Workflow Studio        │
│  ◷  Schedules              │
│                            │
│ INTELLIGENCE           ⌄   │
│  ⚗  Research Lab           │
│  ◎  Model Intelligence     │
│  ▤  Knowledge Base         │
│                            │
│ ASSURANCE              ⌄   │
│  ⛨  Security               │
│  ▥  Reports                │
│                            │
│ PLATFORM               ⌄   │
│  ⚯  Integrations           │
│  ⛁  Marketplace            │
├────────────────────────────┤
│ ● Copilot   ○ Autopilot    │  40px  mode indicator (compact)
│ prod · degraded            │  24px  environment + posture
│ ?  ⚙  (avatar)             │  48px  help · settings · account
└────────────────────────────┘
```

**Why not a flat 16-item list.** Sixteen equal rows have no entry point and no hierarchy: the
operator cannot tell "what I do daily" from "what I configure quarterly". The four pinned
destinations are the daily loop (what is running · what needs me · who is doing it · what am I
building). The four groups are the seasonal surface, collapsed-able, and each group header is a
`<button aria-expanded>` controlling a nested `<ul>`.

**Why these four are pinned.** Overview and Approvals are the two destinations every persona opens
first. Agent Command Centre is where every intervention happens. Projects is the object navigator —
almost every trace chain starts by choosing a project.

### 2.2 Group definitions and layer mapping

| Group | Destinations | Purpose in one line | Brief layer |
|---|---|---|---|
| *(pinned)* | Overview, Approvals, Agent Command Centre, Projects | Daily operational loop | 1, 6 |
| Engineering | Code Intelligence, Design Intelligence, Creative Studio, Workflow Studio, Schedules | Surfaces that produce and schedule work products | 3, 4, 6 |
| Intelligence | Research Lab, Model Intelligence, Knowledge Base | Surfaces that produce and retain knowledge | 1, 2, 5 |
| Assurance | Security, Reports | Surfaces that prove what happened and enforce policy | 6 |
| Platform | Integrations, Marketplace | Surfaces that extend the organisation's capability | — |

Grouping is by operator task, not by system architecture. Workflow Studio is architecturally layer 6
but belongs under Engineering because the operator's job there is "author how work happens", the same
job as Code Intelligence.

### 2.3 Module register

| # | Module | Route | Purpose (one line) | Primary object | Default view | Primary action |
|---|---|---|---|---|---|---|
| 1 | Overview | `/{wsp}/overview` | Real-time posture: what is running, what needs a human, what it costs | `run_` | Posture strip + live runs table + needs-you rail | Open an approval |
| 2 | Approvals | `/{wsp}/approvals` | Risk-ranked governance queue; approve, reject, or request changes with evidence | `apr_` | Queue + detail + evidence rail | `Approve` / `Reject` |
| 3 | Agent Command Centre (Agent Studio) | `/{wsp}/agents` | The agent registry and live execution surface: assignments, handoffs, logs, recovery | `agt_` | Agent list + agent detail + live stream | `Pause agent` / `Retry run` |
| 4 | Projects | `/{wsp}/projects` | The object navigator: goals, plans, repositories, runs, artifacts per project | `prj_` | Project table with health and spend | `New project` |
| 5 | Code Intelligence | `/{wsp}/code` | Repository understanding, refactor proposals, test and security findings | `prj_` (repo-scoped) | Repo table + findings | `Open review` |
| 6 | Design Intelligence | `/{wsp}/design` | UI audits, design-system drift, accessibility findings against live surfaces | `prj_` | Audit list + finding detail | `Open audit` |
| 7 | Creative Studio | `/{wsp}/creative` | Brand assets, campaign variants, generated media with licence provenance | `art_` | Asset library | `New variant` |
| 8 | Workflow Studio | `/{wsp}/workflows` | Author and version the graphs that agents execute, including guardrails | `wfl_` | Workflow list + graph editor | `Publish version` |
| 9 | Schedules | `/{wsp}/schedules` | Cron and event triggers; upcoming fire times; missed and skipped runs | `sch_` | Timeline + schedule table | `New schedule` |
| 10 | Research Lab | `/{wsp}/research` | Campaigns, source provenance, findings with confidence and coverage gaps | `cmp_` | Campaign list + finding ledger + evidence rail | `Publish report` |
| 11 | Model Intelligence | `/{wsp}/models` | Routing policy per role (reasoner / engineer / verifier), cost and quality history | `mrt_` | Routing table + eval charts | `Change route` |
| 12 | Knowledge Base | `/{wsp}/knowledge` | Durable project memory: decisions, conventions, evaluated skills | `knw_` | Document tree + reader | `New entry` |
| 13 | Security | `/{wsp}/security` | Policies, permission grants, sandbox isolation, audit log export | `pol_` | Policy table + audit stream | `Export audit` |
| 14 | Reports | `/{wsp}/reports` | Generated delivery and cost reports, per client or per period | `rpt_` | Report list | `Generate report` |
| 15 | Integrations | `/{wsp}/integrations` | Connected providers: VCS, CI, Figma, issue trackers, model providers | `int_` | Connection table with health | `Connect` |
| 16 | Marketplace | `/{wsp}/marketplace` | Installable agents, skills, and workflow templates with trust signals | `lst_` | Listing grid + detail | `Install` |

Settings, members, and billing are not modules: they live under `/{wsp}/settings/*` and the account
menu, and never appear in the sidebar body.

---

## 3. Routes and URL conventions

### 3.1 Patterns

| Pattern | Form | Example |
|---|---|---|
| Module index | `/{workspace}/{module}` | `/reveilchat/approvals` |
| Object detail | `/{workspace}/{module}/{objectId}` | `/reveilchat/approvals/apr_01JB8M3XQ2` |
| Nested object | `/{workspace}/{module}/{parentId}/{child}` | `/reveilchat/projects/prj_control-plane/runs/run_01JB7Q2K8M` |
| Sub-view (tab) | `?tab={tab}` | `/reveilchat/agents/agt_eng_04?tab=artifacts` |
| Side panel | `?panel={panel}` | `/reveilchat/approvals/apr_01JB8M3XQ2?panel=evidence` |
| Filters | `?{field}={value}` repeated | `?status=failed&status=degraded&risk=high` |
| Sort | `?sort={field}&dir={asc\|desc}` | `?sort=cost&dir=desc` |
| Pagination | `?cursor={opaque}` — never `?page=n` | `?cursor=eyJpZCI6...` |
| Single object shortcut | `/{workspace}/r/{objectId}` | `/reveilchat/r/run_01JB7Q2K8M` — resolves the object type and redirects to its canonical route |

### 3.2 Rules

1. **Workspace slug is always present.** No route works without it, so a shared link is never
   ambiguous about scope.
2. **Everything filterable is in the query string.** Filters survive reload, back/forward, and
   paste. Component-local state (which row is hovered) does not.
3. **Panels are URL state.** `?panel=evidence` opens the drawer; closing it removes the parameter
   via `history.replaceState` so Back does not reopen it.
4. **IDs are opaque and stable.** ULIDs, never sequential integers, never slugs derived from titles.
   Renaming an object never breaks a link.
5. **Canonical routes are singular.** A run is reachable at `/projects/{prj}/runs/{run}`; the
   `/r/{id}` shortcut 302s there. Two live URLs for one object is a defect.
6. **No modal-only routes.** Anything a user can meaningfully share gets a route.
7. **Trailing segments are nouns.** `/approvals/apr_x`, not `/approve/apr_x`. Actions are POSTs, not
   URLs — with one exception: `/{wsp}/reports/{rpt}/preview` is a read-only render.

### 3.3 Reserved segments

`overview`, `approvals`, `agents`, `projects`, `code`, `design`, `creative`, `workflows`,
`schedules`, `research`, `models`, `knowledge`, `security`, `reports`, `integrations`, `marketplace`,
`search`, `settings`, `r`, `new`. Workspace slugs may not collide with these.

---

## 4. The object graph

### 4.1 Lineage

A goal becomes a plan, a plan becomes tasks, a task becomes runs, a run produces steps, artifacts,
and evidence; evidence feeds an approval; an approval produces a decision; every decision writes an
audit entry. This chain is the product's central claim — that any outcome can be traced back to the
instruction that caused it and forward to the evidence that justified it.

```
gol_ Goal ──► pln_ Plan ──► tsk_ Task ──► run_ Run ──► stp_ Step
                                              │
                                              ├──► art_ Artifact ──► evd_ Evidence
                                              │                        │
                                              └──► evd_ Evidence       ▼
                                                                   apr_ Approval
                                                                       │
                                                                       ▼
                                                                   dsc_ Decision
                                                                       │
                                                                       ▼
                                                                   aud_ Audit entry
```

| Object | Prefix | Parent | Children | Canonical route | Appears on |
|---|---|---|---|---|---|
| Goal | `gol_` | Project | Plans | `/projects/{prj}?tab=goals` | Projects, Overview |
| Plan | `pln_` | Goal | Tasks | `/projects/{prj}/plans/{pln}` | Projects, Approvals |
| Task | `tsk_` | Plan | Runs | `/projects/{prj}/tasks/{tsk}` | Projects, Agent Command Centre |
| Run | `run_` | Task or Workflow | Steps, Artifacts, Evidence | `/projects/{prj}/runs/{run}` | Overview, Agent CC, Approvals |
| Step | `stp_` | Run | Artifacts | `/projects/{prj}/runs/{run}?step={stp}` | Agent CC, Approvals |
| Artifact | `art_` | Run or Step | Evidence | `/projects/{prj}/artifacts/{art}` | Agent CC, Approvals, Reports |
| Evidence | `evd_` | Artifact, Source, or Run | — | drawer only (`?panel=evidence&evidence={evd}`) | Approvals, Research Lab |
| Approval | `apr_` | Run, Plan, or Finding | Decision | `/approvals/{apr}` | Approvals, Overview |
| Decision | `dsc_` | Approval | Audit | `/approvals/{apr}?tab=decision` | Approvals, Audit |
| Audit entry | `aud_` | Any object | — | `/security/audit?entry={aud}` | Security |
| Finding | `fnd_` | Research campaign | Evidence | `/research/{cmp}/findings/{fnd}` | Research Lab |
| Source | `src_` | Finding | Evidence | `/research/{cmp}?panel=sources&source={src}` | Research Lab |
| Agent | `agt_` | Workspace | Runs | `/agents/{agt}` | Agent CC, Overview |
| Workflow | `wfl_` | Workspace | Runs | `/workflows/{wfl}` | Workflow Studio |
| Schedule | `sch_` | Workflow | Runs | `/schedules/{sch}` | Schedules |
| Policy | `pol_` | Workspace | Approvals (evaluations) | `/security/policies/{pol}` | Security, Approvals |
| Model route | `mrt_` | Workspace | Runs | `/models?route={mrt}` | Model Intelligence, Agent CC |

### 4.2 Traversal affordances

Three consistent ways to walk the chain, present on every object surface:

1. **Breadcrumb** — the ancestor chain, always visible under the screen title:
   `Projects › Control Plane › Goal 4 › Task 12 › Run`. Each segment is a link; the current object is
   `aria-current="page"`. Truncates from the middle with an overflow menu at >5 segments.
2. **Lineage rail** (`?panel=lineage`) — a right-hand rail listing ancestors (1 level, expandable)
   and descendants (1 level, with counts by state). This is the `Lineage trace rail` component. It is
   the only place where the full chain is visible in one column, and it is the screen's default panel
   on Approvals.
3. **Referenced-by** — at the bottom of every detail view: "Referenced by 3 approvals · 1 report ·
   12 audit entries", each a link that opens the filtered list.

### 4.3 Forward and backward trace — worked example

An operator sees `run_01JB7Q2K8M` failed in Overview. Paths available:

- **Backward (why):** row → run detail → `Lineage` rail → task 12 → plan → goal "Reduce auth latency
  p95 below 120ms" → the instruction that started it, with the operator who approved the plan.
- **Forward (consequence):** run detail → `Artifacts` tab → `art_01JB7R…` (the diff) → `Evidence`
  drawer → the 214 test results, 12 of which failed → `Referenced by` → the approval that would have
  merged it, now auto-voided → audit entry `aud_01JB7S…`.
- **Lateral (who else):** run detail → agent chip → agent detail → other active runs on the same
  agent → whether to pause the agent before retrying.

Every one of those steps is a single click, and each destination is a real route.

---

## 5. Search, palette, and filter

Three different verbs, three different surfaces. Confusing them is the most common IA failure in
tool products, so the boundary is explicit.

| | Command palette | Global search | Per-screen filter |
|---|---|---|---|
| **Question** | "Do this" / "Take me there" | "Find this thing" | "Narrow what I am looking at" |
| **Opens with** | `⌘K` / `Ctrl+K`, or the search field's `Commands` hint | `⌘⇧F` / `Ctrl+Shift+F`, or the top-bar search field | `/`, or the filter bar's first control |
| **Scope** | Current workspace + global actions | Current workspace by default; explicit `Search all workspaces` toggle | Current screen's dataset only |
| **Input** | Fuzzy over verbs, destinations, recent objects | Faceted query over nouns with field prefixes (`repo:`, `status:`, `owner:`, `since:`) | Structured controls (chips, selects) that compile to query params |
| **Result** | Immediate execution or navigation | A results page at `/{wsp}/search?q=` grouped by type | The same screen, filtered in place |
| **Persistence** | Ephemeral; recent commands remembered | Query stays in URL, shareable | Filters stay in URL, shareable |
| **Never does** | Filter a table, run a report, change data | Navigate without showing results first | Navigate away from the screen |

### 5.1 Decision rule

> If the answer is already on screen and you only need less of it, use the filter.
> If the object is somewhere else, use search.
> If it is an action, use the palette.

### 5.2 Command palette contents

Ordered by relevance, then recency, then alphabet:

1. **Actions on the current object** (`Approve apr_…`, `Retry run_…`) — max 3, only when a single
   object context is active.
2. **Navigation** — all 16 modules, plus settings destinations.
3. **Recent objects** — last 8 visited, with type glyph and workspace.
4. **Actions** — `New workflow`, `New schedule`, `Invite member`, `Export audit log`, `Toggle density`,
   `Switch theme`.
5. **Help** — `Keyboard shortcuts`, `Documentation`.

The palette never lists an action the user lacks permission for; it lists it disabled with the
required role stated. Palette rows show the destination workspace when it differs from the current one.

### 5.3 Global search behaviour

- Results grouped: Runs, Approvals, Artifacts, Research findings, Projects, Agents, Reports, Audit
  entries. Each group header shows the count and a `View all` link into the filtered module.
- Zero-result state names the active scope and offers `Search all workspaces` and `Search all time`.
- Search never searches inside artifact contents by default (cost); a `Search file contents` toggle
  is explicit and labelled with the estimated scan size.
- Query is debounced 180ms; results render progressively; the result count is announced via
  `aria-live="polite"`.

### 5.4 Filter bar behaviour

- Filters compile to query params; the URL is the source of truth.
- Active filters render as removable chips in a single row that wraps; overflow becomes `+3 filters`.
- A `Clear all` control appears only when at least one filter is active.
- Filter values are enumerable (status, risk, agent, model, repo, environment, date range). Free-text
  narrowing inside a result set is the filter bar's search field, not global search.
- Applying a filter that yields zero results shows the empty-filter state, never a blank table, and
  keeps every chip removable.

### 5.5 Keyboard map (global)

| Keys | Action |
|---|---|
| `⌘K` / `Ctrl+K` | Command palette |
| `⌘⇧F` | Global search |
| `/` | Focus the current screen's filter or search field |
| `g` then `o` / `a` / `r` / `p` | Go to Overview / Approvals / Research Lab / Projects |
| `[` | Toggle sidebar collapsed |
| `⌘\` | Toggle the right rail (lineage / evidence / activity) |
| `?` | Keyboard shortcuts sheet |
| `Esc` | Close topmost layer, return focus to trigger |
| `j` / `k` | Move down / up in a list or queue (Approvals, Overview runs, Research findings) |
| `Enter` | Open focused row |
| `Space` | Toggle row selection (tables with bulk actions) |
| `⌘⏎` | Confirm the primary action of the focused dialog |

Screen-specific maps live in each screen spec. `?` always opens the same sheet, built from the
current screen's registered shortcuts.

---

## 6. Notification and alert taxonomy

### 6.1 Severity

| Severity | Meaning | Visual | Interrupts? |
|---|---|---|---|
| **P0 — Critical** | Active harm or imminent harm: production failure, policy violation with executed change, security event, budget ceiling breached | `--iz-status-failed-fg`, filled glyph, bell badge in seal-adjacent position | Yes: persistent banner + `role="alert"` toast + notification centre |
| **P1 — Action required** | A human decision or intervention is blocking work: approval waiting, run failed and unrecoverable, schedule missed, integration disconnected | `--iz-status-awaiting-fg` / `--iz-status-degraded-fg` | Once: toast; then badge only |
| **P2 — Attention** | Drift and thresholds: budget at 80%, eval regression, stale research source, degraded model provider | `--iz-status-degraded-fg` | No: notification centre + inline marker |
| **P3 — Informational** | Completion and state transitions the user opted into | `--iz-ink-3` | No |

### 6.2 Classes

| Class | Default severity | Trigger | Grouping | Default delivery | Deep link |
|---|---|---|---|---|---|
| `approval.requested` | P1 | An approval enters the queue assigned to me or my role | Grouped by run; 1 row per run, count badge | In-app + badge | `/approvals/{apr}` |
| `approval.decided` | P3 | My submitted approval was decided (by me elsewhere or another approver) | Grouped per approval | In-app | `/approvals/{apr}?tab=decision` |
| `run.failed` | P1 | A run reaches terminal failure, or fails the same step twice | Grouped by task; collapses repeats | In-app + toast | `/projects/{prj}/runs/{run}` |
| `run.completed` | P3 | Run completes with verification passed | Off by default; opt-in per workflow | In-app | Run detail |
| `budget.threshold` | P2 → P1 at 100% | Workspace, project, or run crosses 80% / 100% of its ceiling | One per threshold per period | In-app + banner at 100% | Cost panel on Overview |
| `policy.violation` | P0 | A policy check fails on an executed action, or a permission boundary is probed | Never grouped; each is a record | Banner + alert toast + email (mandatory) | `/security/policies/{pol}?entry={aud}` |
| `dependency.degraded` | P2 | A model provider, VCS, CI, or sandbox falls below its contract | Grouped by dependency for 15 min | In-app + status marker | `/integrations/{int}` |
| `schedule.missed` | P1 | A schedule's fire time passed without a run starting within 2× its expected start latency | Grouped by schedule | In-app | `/schedules/{sch}` |
| `security.event` | P0 | Auth anomaly, token reuse, sandbox escape attempt, egress denial spike | Never grouped | Banner + alert toast + email | `/security?tab=events` |
| `system.maintenance` | P3 | Planned window, model deprecation, API version sunset | Announcement region | In-app | `/reports` or changelog |

### 6.3 Delivery rules

- **Only P0 and P1-toast classes interrupt.** Everything else accumulates in the notification centre.
- **A toast never carries the only copy of an action.** Every toast has a persistent counterpart in
  the notification centre and, where relevant, in the screen's ledger.
- **Dedupe window:** 15 minutes per `class + object + severity`. Repeats increment a count on the
  existing entry instead of stacking.
- **Quiet hours** suppress P2/P3 delivery; P0 and P1 always deliver.
- **Email and webhook** are opt-in per class per workspace, except `policy.violation` and
  `security.event`, which are mandatory and cannot be disabled by a non-owner role.
- **Read state is per user**, not per workspace.
- **Notification centre** (right-side drawer, 400px): tabs `Unread` / `All` / `Muted`, grouped by
  day, each row = severity glyph + class label + object + one-line consequence + relative time +
  `Open` and `Dismiss`. Bulk `Mark all read` is present; bulk dismiss is not (destructive-by-accident).
- **Badge counts** show items awaiting *me*, not total unread. A badge that cannot be cleared by
  reading is a defect.

### 6.4 Escalation

| Condition | Escalation |
|---|---|
| P1 approval undecided for 4h (business hours) | Re-notify the assigned approver, then the role's backup |
| P1 approval undecided for 24h | Surface at the top of Overview with an age warning; email the workspace owner |
| P0 unacknowledged for 15 min | Email owner + on-call; banner becomes non-dismissable until acknowledged |
| Budget ceiling breached | All new runs queue; Overview posture turns `Degraded`; a single P0 is raised |

---

## 7. Getting anywhere in two clicks

| From Overview | Path |
|---|---|
| Any failing run | Live runs table → row → run detail |
| Any pending approval | Needs-you rail → card → approval detail |
| The agent behind a run | Run row → agent chip → agent detail |
| Cost detail | Cost panel → `View usage` → Reports filtered to the period |
| Policy that blocked something | Alert row → `View policy` → Security policy detail |
| A research finding cited in a decision | Approval → evidence rail → source → research finding |

| From any screen | Path |
|---|---|
| Change scope | Scope bar chip → selector |
| Find an object by ID | `⌘K` → paste ID → Enter (palette resolves `run_`, `apr_`, `evd_`, etc.) |
| Export what I am looking at | Screen header overflow → `Export CSV` / `Copy link` |
| See the audit trail for this object | Detail header → `Audit` tab, or `Referenced by` → audit entries |

---

## 8. Permission visibility

| Situation | Treatment | Rationale |
|---|---|---|
| Module exists in the plan, user lacks the role | Module stays in navigation; opening it renders the **permission-denied state** naming the required role and the workspace owner | Discoverability; the user needs to know the capability exists and who to ask |
| Module not in the plan | Hidden from navigation; direct URL renders an **upgrade state** with the plan comparison | Selling, not security |
| Object exists but user lacks read access | Omitted from lists; counts exclude it | Never leak existence or volume of objects the user cannot see |
| Object readable, action forbidden | Rendered fully; the action button is disabled with the required role in a tooltip and the reason in a persistent line under the action bar | Users must be able to see why they cannot act |
| Environment forbidden (e.g. `prod`) | Environment chip disabled with lock + role; `prod` data never fetched | Prevents accidental read of production data by role |

Disabled-by-permission controls always carry the reason in text, not only in a tooltip — tooltips are
not available to touch or screen-reader users by default.

---

## 9. Responsive navigation

| Width | Sidebar | Scope bar | Pinned destinations | Groups |
|---|---|---|---|---|
| ≥1280px | 264px, expanded, group headers visible | Full, 5 chips | Text + icon | Expanded, all |
| 1024–1279px | 64px icon rail; labels in tooltips + `aria-label` | Full | Icon only, with badge dot | Flyout on hover/focus, single-level |
| 768–1023px | Off-canvas drawer, opened by a header button | Chips collapse to workspace + env; project moves into overflow | Text + icon inside drawer | Accordion, all collapsed except the active one |
| <768px | Off-canvas drawer, full height, `Esc` closes, focus trapped | Two chips only; branch/revision hidden | Text + icon | Accordion |

Mobile is a read-and-decide surface, not an authoring surface: the four screens remain fully usable
for reading, filtering, and approving; the Workflow Studio graph editor and the diff viewer are
read-only below 768px with an explicit note.
