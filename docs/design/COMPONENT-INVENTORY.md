# INTELLIGENZ — Component Inventory

> The complete reusable surface. 46 components. Screen specs may only reference components defined
> here; anything not listed is a gap to close in this file first.
>
> Format: **Purpose · Anatomy · Variants & sizes · States · Data shape · Use when · Don't.**
> Token names resolve against `DESIGN.md` §14. Sizes refer to `--iz-control-*` and `--iz-row-*`.

---

## A. Shell and navigation

### A1. App shell chrome

**Purpose.** The fixed frame every screen lives inside: a dark equipment rack around a white document.
**Anatomy.** `topbar` (56px: brand mark, workspace name, global search trigger, mode indicator,
environment chip, notification bell, account avatar) · `sidebar` (264px or 64px) · `scopebar` (40px) ·
`main` (scroll container) · optional right rail slot · `skip to content` link as the first focusable
element.
**Variants.** `standard` · `rail` (sidebar 64px) · `drawer` (sidebar off-canvas below 1024px) ·
`focus` (all chrome hidden except a 40px exit strip — used when a diff is open full-screen).
**States.** default · scrolled (`topbar` gains a 1px `--iz-border-default` bottom rule; it never gains
a shadow) · command-palette-open (`inert` on `main`, scrim at `--iz-z-scrim`) · offline · degraded.
**Data shape.** `{ orgName, workspace, project?, environment: 'prod'|'staging'|'dev', mode: 'autopilot'|'copilot'|'manual', posture: 'healthy'|'degraded'|'offline', unreadCount, pendingApprovals }`.
**Use when.** Always. Exactly once per document.
**Don't.** Add a second horizontal bar below the scope bar. Don't let chrome scroll away. Don't
render the top bar in a marketing style with a large logo — the brand mark is 20px and static.

### A2. Sidebar nav

**Purpose.** Primary navigation: 4 pinned destinations, 4 collapsible groups, 12 grouped modules.
**Anatomy.** Org header (56px) · workspace switcher (40px) · `<nav aria-label="Primary">` with a
pinned `<ul>` · four `<li>` groups, each a `<button aria-expanded>` header + nested `<ul>` · footer
(mode indicator, environment + posture line, help/settings/account, 48px).
**Variants.** `expanded` (264px) · `rail` (64px, icon + tooltip + visually hidden label) · `drawer`.
**Sizes.** Row 32px, icon 20px, label `--iz-text-sm`, group header `--iz-text-micro` in
`--iz-on-chrome-2`, indent 12px for grouped items.
**States.** default · hover (`--iz-color-chrome-hover`) · current (`--iz-color-chrome-selected`, text
`--iz-on-chrome-1`, `aria-current="page"`) · focus-visible (`--iz-focus-on-chrome`, inset because the
rail clips at the viewport edge — use `outline-offset: -2px` here and document the exception) ·
collapsed group · badge (count pill, max `99+`) · badge-attention (`--iz-status-awaiting-fg` dot when
count > 0) · disabled (never for permissions, only while the workspace is loading).
**Data shape.** `{ id, label, href, icon, badge?: number, badgeKind?: 'count'|'attention' }`; groups
`{ id, label, defaultOpen, items[] }`.
**Use when.** Every screen.
**Don't.** Exceed 4 pinned items. Don't put settings, billing, or members in the body — footer only.
Don't animate group expand with height transitions on a 20-row list; use an instant toggle plus an
opacity fade (90ms).

### A3. Workspace switcher

**Purpose.** Change tenant scope, or create/enter a workspace, without losing orientation.
**Anatomy.** Trigger button in the sidebar header: workspace avatar (2-letter monogram, 20px),
workspace name, `⌄` glyph. Popover: search field, `Recent` group, `All workspaces` group, footer
`Create workspace`.
**Variants.** `sidebar` (default) · `compact` (rail: monogram only, 32×32 target).
**States.** default · open · loading (skeleton rows, 3) · empty (single-tenant account: popover
replaced by `Create a workspace` + explanation) · error (popover body error state with retry).
**Data shape.** `{ workspaceId, name, slug, plan, role, memberCount, environmentCount, lastOpenedAt }`.
**Use when.** The account has ≥1 workspace; always visible.
**Don't.** Switch workspace without a full navigation and a toast naming the new scope. Don't hide
the current workspace name in the rail variant — the monogram plus `aria-label` is the minimum.

### A4. Scope bar

**Purpose.** Make workspace / project / environment continuously visible and changeable; stamp the
scope into screenshots and exports.
**Anatomy.** Left: workspace chip · separator `›` · project chip (`All projects` allowed) ·
environment chip (tinted per env) · branch/revision chip when repo-bound. Right: `Simulated` marker,
mode + budget summary.
**Variants.** `full` · `collapsed` (below 768px: workspace + environment only) · `locked`
(environment disabled with lock glyph).
**Sizes.** Height 40px, chips `--iz-control-sm` (24px), text `--iz-text-xs`.
**States.** default · chip hover · chip open (selector popover) · locked (lock glyph, tooltip names
required role, `aria-disabled="true"`) · loading (chips skeleton, bar keeps its height to prevent
layout shift) · offline (bar shows `Last synced 4m ago` on the right).
**Data shape.** `{ workspace, project?: {id,name} | null, environment, revision?: {branch, sha}, simulated: boolean, modeSummary: string }`.
**Use when.** Every screen, directly under the top bar.
**Don't.** Let the bar wrap to two lines. Don't use the environment tint as the only signal — the
word `prod` / `staging` / `dev` is always present.

### A5. Mode indicator

**Purpose.** Show and change the organisation's operating mode: Autopilot, Copilot, Manual. The mode
changes what the system may do without asking, so it is never buried.
**Anatomy.** `role="radiogroup"` with three options, each an icon + label; a 1px divider before it;
a `Change` affordance that opens a confirm dialog explaining consequences.
**Variants.** `topbar` (36px wide control, labels visible ≥1280px, icons only with tooltips below) ·
`footer` (sidebar, stacked, compact) · `readonly` (role lacks `mode:write`: all options disabled with
reason).
**States.** default · hover · focus-visible · checked (`--iz-color-chrome-selected` fill, `aria-checked="true"`) ·
pending (optimistic, 140ms, reverts on failure with a toast) · disabled.
**Data shape.** `{ mode: 'autopilot'|'copilot'|'manual', constraints: { maxRisk: 'low'|'medium'|'high', requiresApprovalAbove: number }, canChange: boolean, changedBy?: {name, at} }`.
**Use when.** Top bar on every screen; repeated in the sidebar footer in compact form.
**Don't.** Represent mode as a toggle switch — it is a three-way choice, not binary. Don't change mode
silently: Autopilot→Manual is safe, but any move *to* Autopilot requires a confirmation that restates
the risk ceiling and daily budget.

### A6. Command palette

**Purpose.** Execute a verb or jump to a destination in under two seconds.
**Anatomy.** Centred dialog (`--iz-z-palette`, max-width 640px), input (`--iz-control-xl`), grouped
result list with type glyph + label + right-aligned hint (`↵`, destination workspace), footer
keyboard legend.
**Variants.** `global` · `object-context` (adds an "Actions on this object" group at the top).
**Sizes.** Row 36px, max 9 visible rows before scroll, input 36px.
**States.** default · querying (inline 12px spinner in the input's trailing slot; results keep their
previous height) · empty query (recents + actions) · no results (offers global search with the same
term) · error · loading first open (skeleton rows).
**Data shape.** `{ id, kind: 'action'|'navigation'|'object'|'help', label, sublabel?, href?, run?: () => Promise<void>, disabledReason?, workspace? }`.
**Use when.** `⌘K`, or the search field's `Commands` affordance.
**Don't.** Put filters in it. Don't show an action the user cannot perform without `disabledReason`.
Don't close the palette before an async action resolves — keep it open with a per-row pending state.

### A7. Global search

**Purpose.** Find a noun across the workspace when you know something about it but not where it lives.
**Anatomy.** Top-bar trigger (32px field, placeholder `Search runs, approvals, evidence…`, `⌘⇧F`
hint) → results page or overlay. Results page: query input, scope line (`in ReveilChat · all time`),
grouped result sections, each with a count and `View all`.
**Variants.** `overlay` (default, max-width 720px, max-height 70vh) · `page` (`/{wsp}/search?q=`) for
shared links and deep result sets.
**States.** default · typing (180ms debounce) · loading (3 skeleton groups) · results · zero results
(names scope, offers broader scope) · error · permission-filtered (silently excludes objects the user
cannot read, and says so once: `Results exclude 2 items you do not have access to`).
**Data shape.** `{ query, scope: {workspace, project?, since?}, groups: [{type, count, items[]}], excludedCount }`.
**Use when.** `⌘⇧F` or the top-bar field. Never inline in a table.
**Don't.** Search file contents by default. Don't return more than 5 rows per group without `View all`.

### A8. Notification centre

**Purpose.** The durable record of everything that needed attention, with read state per user.
**Anatomy.** Bell trigger with badge · right drawer 400px · tabs `Unread`/`All`/`Muted` · day groups ·
rows with severity glyph, class label, object link, one-line consequence, relative time, `Open`,
`Dismiss` · footer `Mark all read` and `Notification settings`.
**Variants.** `drawer` · `panel` (embedded on Overview as `Recent alerts`, max 5 rows).
**States.** default · empty (`You're all caught up. Alerts appear here when runs fail or approvals
arrive.`) · loading (5 skeleton rows) · error · muted class (row dimmed, `aria-label` includes
`muted`) · unread (2px `--iz-status-active-fg` inset marker + bold label).
**Data shape.** `{ id, class, severity: 'P0'|'P1'|'P2'|'P3', title, consequence, objectRef: {type,id,href}, createdAt, readAt?, muted, groupCount }`.
**Use when.** Bell in the top bar; panel variant on Overview.
**Don't.** Use toasts as the only delivery for anything in §6.2 of the IA. Don't allow bulk dismiss.

### A9. Breadcrumb

**Purpose.** Show where an object sits in the lineage and make every ancestor one click away.
**Anatomy.** `<nav aria-label="Breadcrumb">` → `<ol>` of links, `›` separators (`aria-hidden`),
current page as `aria-current="page"` and non-link.
**Variants.** `standard` (≤5 segments) · `truncated` (middle segments collapse into a `…` menu) ·
`inline` (inside a drawer header, 1 ancestor + current).
**States.** default · truncated · overflow menu open.
**Data shape.** `{ segments: [{label, href?, id?}], current }`.
**Use when.** Every object detail screen; not on module index screens.
**Don't.** Duplicate the scope bar — the breadcrumb starts at the project or the parent object, not at
the workspace.

---

## B. Status and telemetry

### B1. Status pill

**Purpose.** Encode one of the seven operational states with glyph, label, and colour — never colour alone.
**Anatomy.** Inline-flex, 2px gap: 10px glyph (SVG) + label. Optional trailing detail (`· 14m 22s`).
**Variants.** `sm` (20px tall, `--iz-text-xs`) · `md` (24px, `--iz-text-xs`, default) · `dot-only`
(**not permitted** — see Don't) · `with-duration` · `interactive` (opens a state-history popover).
**States.** default · hover (only when interactive) · focus-visible · pressed · unknown (`—`, `Not reported`).
**Data shape.** `{ state: 'active'|'queued'|'completed'|'failed'|'awaiting'|'degraded'|'offline', label?: string, detail?: string, since?: string }`.
**Use when.** Every row, card, header, and log line that has a state.
**Don't.** Drop the label. Don't invent an eighth colour for `Retrying` — use `active` with the
detail `retry 2/3`. Don't use pill shape (999px radius) — radius is 4px so it reads as a stamp, not
a tag.

### B2. Risk badge

**Purpose.** Show blast-radius risk as a scannable magnitude, visually distinct from status.
**Anatomy.** Four 6×12px segments (filled = level) + 4px gap + label + optional score.
**Variants.** `inline` (bar + label) · `compact` (bar + score only, label in `aria-label`) ·
`with-threshold` (adds `≥50 blocks Autopilot`).
**States.** default · critical-emphasis (label bold, `--iz-risk-critical`) · unknown (`—` + `Unscored`).
**Data shape.** `{ level: 'low'|'medium'|'high'|'critical', score: number, factors?: [{label, weight}] }`.
**Use when.** Approval rows, approval headers, policy checks, workflow steps.
**Don't.** Use a pill. Don't colour the whole cell background except for `critical`, where a
`#FAF1F0` row tint is allowed and must be paired with the word `Critical`.

### B3. Confidence indicator

**Purpose.** Express how much evidence supports a claim, without implying a verdict.
**Anatomy.** 5-segment meter (10×4px each) + numeric `0.87` + band word + `· 12 sources` link.
**Variants.** `full` (meter + number + band + sources) · `compact` (number + band) · `block` (stacked,
used in research finding headers, meter 96px wide).
**States.** default · insufficient (`<0.40`: empty meter, label `Insufficient evidence`, actions
disabled nearby) · stale (sources older than the campaign's freshness window: `Stale · 41d`, amber
`--iz-status-awaiting-fg` band word) · unknown (`—`, `Not scored`).
**Data shape.** `{ value: number, band: 'high'|'moderate'|'low'|'insufficient', sourceCount: number, stale: boolean, oldestSourceAt: string }`.
**Use when.** Research findings, approval evidence summaries, model eval claims.
**Don't.** Colour it green above 0.8. Don't show a confidence without a source count.

### B4. Metric tile

**Purpose.** One number with its unit, comparison, and trend — the only permitted "big number" in the product.
**Anatomy.** Label (`--iz-text-micro` uppercase) · value (`--iz-text-2xl`, 28px) · unit (0.85em, ink-3) ·
delta line (arrow glyph + `+12%` + `vs. yesterday`) · optional 40px sparkline, right-aligned.
**Variants.** `posture` (in the strip, 28px value, no border, divided by rules) · `panel` (16px value,
inside a panel) · `inline` (13px value, used inside table headers/summaries).
**States.** default · loading (skeleton bar at 60% width, label remains) · no-comparison (`—` where the
delta would be, never `0%`) · degraded (a `Degraded` chip beside the label when the source is partial) ·
error (`—` + retry icon button).
**Data shape.** `{ label, value, unit?, format: 'int'|'money'|'duration'|'percent'|'tokens', delta?: {value, direction, comparisonLabel}, series?: number[], sourceState?: 'ok'|'degraded'|'error' }`.
**Use when.** Posture strip, cost panels, agent fleet summaries.
**Don't.** Stack four gradient tiles as a hero. Don't animate the number.

### B5. Sparkline

**Purpose.** Trend shape in 40×16px without axes, for scanning direction not magnitude.
**Anatomy.** Inline SVG path, 1.5px stroke, `--iz-viz-1`, optional 12% area fill, optional last-point dot (2px).
**Variants.** `line` · `area` · `bar` (7 discrete bars for daily data) · `with-baseline` (dashed 1px
`--iz-border-strong` reference line).
**States.** default · loading (flat 1px `--iz-border-subtle` line) · empty (no series: render nothing but
keep the 16px height) · degraded (dashed stroke).
**Data shape.** `{ points: number[], baseline?: number, label: string }` — `label` is mandatory and
becomes the accessible name plus a `<title>` summary (`Spend, last 7 days, $186.40 total`).
**Use when.** Beside a metric, never alone in a cell without a value.
**Don't.** Add axes, tooltips on hover only, or animation. Don't use it for categorical data.

### B6. Distribution bar

**Purpose.** Show composition of a total in one horizontal bar (spend by agent, evidence by source type,
runs by outcome) where a pie would be unreadable.
**Anatomy.** 8px-tall stacked bar (`--iz-radius-xs`), segments from `--iz-viz-1..6` or status stems,
4px gaps; legend below as labelled swatches with values.
**Variants.** `stacked` · `segmented` (fixed 10 slots, used for 10-point eval distributions).
**States.** default · hover segment (raises 1px, shows value in the legend) · empty · loading.
**Data shape.** `{ total, unit, segments: [{key, label, value, color}] }`.
**Use when.** Composition of 3–6 categories. More than 6 → table.
**Don't.** Use for a single percentage — that is a budget bar. Don't rely on the legend being hover-only.

---

## C. Data display

### C1. Data table

**Purpose.** The primary instrument of the product. Must handle 200 rows, 9 columns, selection, expansion,
sorting, sticky headers, and bulk actions without losing legibility.
**Anatomy.** `<table>` with `<caption class="iz-sr-only">` · `<colgroup>` for widths · sticky `<thead>`
(`--iz-row-header-h`, `--iz-text-micro`, sortable headers are `<button>` inside `<th aria-sort>`) ·
`<tbody>` rows · optional leading checkbox column (40px) · optional expand toggle column (32px) ·
trailing actions column (48px, right-aligned, icon buttons with labels) · expanded detail row
(`<tr>` with a single `<td colspan>`, `aria-controls`) · footer: selection summary + bulk actions +
pagination.
**Variants.** `default` (32px rows) · `compact` (28px) · `comfortable` (40px) · `tree` (expandable
hierarchy for project → task → run) · `readonly` (no selection column).
**Column types.** text (left, truncates) · numeric (right, tabular) · status (left, pill) · risk (bar) ·
identity (mono chip) · actor (avatar + name) · time (relative, absolute in `title`) · actions.
**States.** default · row hover (`--iz-color-surface-2`) · row selected (`--iz-color-surface-3` + 2px
`--iz-ink-1` inset left bar, checkbox checked) · row focused (2px `--iz-focus` ring inset) · sortable
asc/desc (`aria-sort`) · sorted column header emphasised (`--iz-ink-1`, 500) · expanded · loading
(8 skeleton rows matching column widths) · empty · filtered-empty · error · permission-limited
(rows the user cannot see are absent, with a count note) · stale (rows older than the polling window
carry a 2px `--iz-status-degraded-fg` dot in the time cell).
**Data shape.** `{ columns: [{key, label, type, width, sortable, align, hiddenBelow?}], rows: T[], rowKey, selectable, expandable, bulkActions, selection, sort, onSort }`.
**Density.** Controlled by `data-density`; header always 32px; never reduce type below 12px.
**Use when.** Runs, approvals, projects, agents, findings, sources, logs summaries, audit entries.
**Don't.** Use cards instead of rows for comparable objects. Don't reorder rows on poll. Don't hide the
status column at any breakpoint. Don't put a shadow on the sticky header.

### C2. Filter bar

**Purpose.** Narrow the current dataset, with state that survives reload and sharing.
**Anatomy.** Row of controls: search-within (200px), facet selects, date range, `Clear all`, result count
(`18 of 214 runs`), density toggle, column picker.
**Variants.** `full` (≥1280px, all facets inline) · `compact` (facets collapse into a `Filters` button
with a count badge, opening a popover) · `minimal` (search only, used inside drawers).
**States.** default · active (chips visible, `Clear all` present) · loading (controls disabled, 140ms) ·
error (facets unavailable: only free-text search remains, with a note) · zero-results (bar stays,
chips removable, table shows filtered-empty state).
**Data shape.** `{ facets: [{key, label, type: 'select'|'multiselect'|'daterange'|'text', options?}], value: Record<string,string[]>, resultCount, totalCount }`.
**Use when.** Every list screen with >20 objects.
**Don't.** Put filters in a modal. Don't apply filters without updating the URL. Don't reset filters on
workspace change silently — reset and toast that they were reset.

### C3. Filter chips

**Purpose.** Show what is currently excluded from view, and let each exclusion be removed in one action.
**Anatomy.** Wrapping row of chips: `status: Failed ×`, each with a remove button carrying
`aria-label="Remove filter: status Failed"`.
**Variants.** `removable` · `readonly` (inside a saved view summary) · `overflow` (`+3 filters` opens the
filter popover).
**States.** default · hover · focus-visible · removing (opacity 0.5, 90ms) · group (a chip representing a
multi-select value shows `status: 2 selected` and removes the whole group).
**Data shape.** `{ key, label, values: string[], display: 'single'|'group' }`.
**Use when.** Directly under the filter bar, only when ≥1 filter is active.
**Don't.** Render chips for default filters. Don't use chips as navigation.

### C4. Tabs

**Purpose.** Switch between views of the same object without leaving it.
**Anatomy.** `<div role="tablist">` with `<button role="tab" aria-selected>`; 2px active indicator
(`--iz-ink-1`) on the bottom edge; optional count badge per tab; optional overflow menu.
**Variants.** `underline` (default, 36px) · `contained` (segmented appearance, 28px, for 2–3 views inside
a panel) · `vertical` (left column, used in settings).
**States.** default · hover (text `--iz-ink-1`) · selected · focus-visible · disabled (with reason) ·
overflow.
**Data shape.** `{ id, label, badge?, href?, disabledReason? }`.
**Use when.** Detail views with 2–6 orthogonal views (Activity, Runs, Artifacts, Config).
**Don't.** Use tabs for sequential steps — that is a stepper, and this product does not use one. Don't
nest tabs more than one level.

### C5. Segmented control

**Purpose.** Choose exactly one of 2–4 mutually exclusive, immediately-applied options.
**Anatomy.** `role="radiogroup"`, container with `--iz-color-surface-2` fill and 1px inner border, each
option 28px tall, selected option gets `--iz-color-canvas` + 1px `--iz-border-default` + `--iz-ink-1` text.
**Variants.** `sm` (24px, table toolbars) · `md` (28px, default) · `icon+label` · `icon-only` (requires
`aria-label` per option and a visible tooltip).
**States.** default · hover · focus-visible · selected · disabled · loading (each option shows a 12px
spinner only when the change is slow, >400ms).
**Data shape.** `{ options: [{value, label, icon?}], value, onChange }`.
**Use when.** Window selector (`24h / 7d / 30d`), severity filter (`All / Mine / Blocking`), view mode
(`Table / Timeline`).
**Don't.** Use for more than 4 options. Don't use where multi-select is possible — that is a chip set.

### C6. Drawer

**Purpose.** Show detail without losing the list — the default detail surface in this product.
**Anatomy.** Fixed right panel (`--iz-trace-rail-w` 400px, or 560px for `wide`), 1px left border,
`--iz-shadow-drawer`, sticky header (title, subtitle, close), scroll body, optional sticky footer
(actions). Scrim at `--iz-z-scrim` only below 1024px; on desktop the list stays interactive and visible.
**Variants.** `standard` 400px · `wide` 560px · `full` (100% below 768px) · `bottom-sheet` (<1024px for
lineage/evidence) · `persistent` (no close, part of the layout).
**States.** default · opening (translateX 16px→0, 200ms) · closing · loading (skeleton header + 3 blocks) ·
error · permission-denied · focus-trapped (mobile only) · scroll-locked (mobile only).
**Data shape.** `{ id, title, subtitle?, content, footer?, width, onClose, returnFocusTo }`.
**Use when.** Evidence, lineage, notifications, filters on tablet, object peek from a table.
**Don't.** Stack two drawers. Don't use a drawer for a destructive confirmation — that is a dialog.

### C7. Modal / dialog

**Purpose.** Interrupt for a decision that cannot be deferred or undone.
**Anatomy.** Native `<dialog>` (or `role="dialog" aria-modal="true"`), scrim, max-width 480px
(`sm`) / 640px (`md`) / 880px (`lg`), title (`--iz-text-md`), body, footer with actions
(right-aligned; primary rightmost).
**Variants.** `confirm` · `destructive` (requires a typed confirmation or a checkbox for Critical risk) ·
`form` · `palette` (owned by A6).
**States.** default · opening (opacity + scale 0.98→1, 140ms) · submitting (primary button loading,
others disabled) · error (inline error region above the footer, `role="alert"`) · permission-denied.
**Data shape.** `{ title, description, consequences?: string[], confirmLabel, cancelLabel, destructive, requireTypedConfirmation? }`.
**Use when.** Approving a Critical-risk item, rejecting with a mandatory reason, deleting a schedule,
changing mode to Autopilot, disconnecting an integration.
**Don't.** Use for routine editing, filters, or detail views. Don't auto-focus the destructive button —
focus the cancel, and never bind `Enter` to a destructive default.

### C8. Dropdown menu

**Purpose.** A short list of actions attached to a trigger, or a facet selector.
**Anatomy.** Trigger button + `aria-haspopup="menu"`; `position: fixed` panel (`--iz-z-dropdown`),
`--iz-radius-md`, `--iz-shadow-popover`; items 32px (`--iz-text-sm`), optional leading icon 16px,
optional trailing shortcut hint or checkmark for selectable items; separators; destructive item
last, in `--iz-status-failed-fg`.
**Variants.** `action` · `select` (single, checkmark) · `multiselect` (checkbox) · `context` (right-click
on a table row).
**States.** default · open · item hover · item focus-visible · item selected · item disabled (with
reason) · empty (rare: a single muted line).
**Data shape.** `{ items: [{id, label, icon?, shortcut?, destructive?, disabledReason?, checked?, onSelect}] }`.
**Use when.** Row actions, overflow menus, facet selection, account menu.
**Don't.** Nest submenus more than one level. Don't render inside an `overflow:hidden` ancestor without a
portal. Don't use for navigation lists longer than 12 items.

### C9. Tooltip

**Purpose.** Name an icon-only control, or reveal a truncated value; never to carry information that is
required to complete a task.
**Anatomy.** Trigger wrapper, `role="tooltip"`, 4px offset, `--iz-color-chrome` background,
`--iz-on-chrome-1` text, `--iz-text-xs`, max-width 280px, `--iz-z-tooltip`, 400ms open delay, 80ms close.
**Variants.** `label` (short) · `rich` (two lines: label + `--iz-on-chrome-2` explanation) · `id` (mono
full identifier + `Copy`).
**States.** default · open · dismissed by Escape (must not reopen until pointer leaves).
**Data shape.** `{ content, placement: 'top'|'right'|'bottom'|'left', delay? }`.
**Use when.** Icon-only buttons, truncated IDs, environment chips, disabled reasons.
**Don't.** Put interactive content inside. Don't rely on it for keyboard users — the accessible name must
already exist. Don't show it on touch.

### C10. Toast

**Purpose.** Confirm a completed action, or surface a P0/P1 event that just happened.
**Anatomy.** Bottom-right stack (max 3), 360px, `--iz-color-chrome`, `--iz-on-chrome-1`, 4px left severity
bar is **not** used — severity is a 16px glyph + label; message; optional `Undo` or `Open`; close button.
**Variants.** `success` · `info` · `warning` · `error` (P0/P1 only) · `with-action` · `with-undo` (8s).
**States.** default · entering (opacity + 8px, 200ms) · hover (pauses auto-dismiss) · dismissing ·
actioned.
**Data shape.** `{ severity, title, description?, action?: {label, onClick}, duration: 4000|8000|0 }`.
**Use when.** After a mutation that has no visible result on screen, or a P0/P1 event.
**Don't.** Use for failures that need a decision (those go to the notification centre and the ledger).
Don't auto-dismiss anything with an `Undo` in under 8s. Don't stack more than 3.

### C11. Approval card

**Purpose.** The unit of the governance queue: enough to decide whether to open, not enough to decide.
**Anatomy.** Row/card 1: risk badge + risk score · title (`--iz-text-sm`, 500) · object chip
(`run_…`) · requested-by (agent avatar + name) · age · cost impact chip · `Awaiting approval` pill ·
one-line blast radius (`7 files · 3 repos · prod`) · 4 guardrail micro-lines (permission, budget,
environment, rollback) · affordances `Review` and `Quick approve` (only when risk ≤ Medium and mode ≠
Manual).
**Variants.** `queue-row` (compact, 96px, in the queue pane) · `card` (160px, in the Overview needs-you
rail) · `expanded` (with inline diff summary and policy checks).
**States.** default · hover · focused · selected (in the queue, `aria-current="true"`) · critical (row
tint `#FAF1F0` + `Critical` label) · stale (`Waiting 26h` in `--iz-status-awaiting-fg`) · blocked
(policy check failed: `Blocked by policy` pill replaces `Awaiting approval`) · decided (read-only, shows
decision stamp) · loading (skeleton).
**Data shape.** `{ approvalId, title, risk: {level, score}, requestedBy: {agentId, name}, createdAt,
blastRadius: {files, repos, environments[]}, costImpact: {amount, period}, guardrails:
{permission, budget, repos[], environment, rollback}, policyChecks: [{name, status}], canQuickApprove }`.
**Use when.** Approvals queue, Overview needs-you rail, notification rows (compact).
**Don't.** Offer quick approve above Medium risk. Don't hide the blast radius behind a hover.

### C12. Pagination

**Purpose.** Move through a result set without losing filter or sort state, and without implying a
total the client does not have.
**Anatomy.** Footer row: range text (`1–50 of 214`) · page-size `Select` (25 / 50 / 100 / 200) ·
`Previous` / `Next` buttons with 16px glyph + text label (never icon-only) · optional `Jump to ID`
input for cursor-based sets.
**Variants.** `cursor` (default: prev/next only, no page numbers — the API is cursor-based) ·
`load-more` (research sources, activity history: a 32px bordered button showing the remaining count) ·
`virtual` (tables over 500 rows: scroll with a sticky `Showing 50 of 1,204 · Load more` footer).
**Sizes.** 40px row height; buttons `--iz-control-sm`; text `--iz-text-xs`.
**States.** default · first page (`Previous` disabled with `aria-disabled`, not removed) · last page
(`Next` disabled) · loading (buttons disabled, range text shows a 24px skeleton) · error (`Could not
load more. Retry` inline) · count-unknown (`Showing 50 · total unavailable` — never `of 0`).
**Data shape.** `{ cursor?: string, nextCursor?: string|null, prevCursor?: string|null, pageSize,
total?: number, shown: number, onChange, onPageSize }`.
**Use when.** Every table with more rows than one screen, and every list longer than 50 items.
**Don't.** Use numbered page links against a cursor API — the numbers would be a lie. Don't reset
scroll position on page change for cursor pagination; keep the table header anchored. Don't hide
pagination when there is one page — render the range text so the user knows the size of the set.

---

## D. Evidence and governance

### D1. Diff viewer

**Purpose.** Show exactly what will change, at file and line level, with enough context to judge it.
**Anatomy.** Header: file count, `+128 −64`, view toggle (`Unified`/`Split`), `Hide whitespace`,
`Expand all`, file filter. Body: per-file collapsible sections (path, change kind, `+/−` counts),
hunk headers, line numbers in both gutters, `+`/`−` prefixes in addition to tint, 13px mono.
**Variants.** `unified` (default, ≥768px) · `split` (≥1024px) · `readonly-compact` (inline summary in an
approval card, max 3 hunks) · `readonly-mobile` (<768px: unified, horizontal scroll inside a labelled
region, note `Full diff available on desktop`).
**States.** default · collapsed file · expanded file · whitespace hidden · loading (3 skeleton file
blocks) · error · truncated (`Diff truncated at 2,000 lines. Open in repository`) · large-diff warning
(>5,000 lines: summary first, `Load full diff` explicit).
**Data shape.** `{ files: [{path, change: 'added'|'modified'|'deleted'|'renamed', additions, deletions, hunks: [{header, lines: [{kind:'ctx'|'add'|'del', oldNo?, newNo?, text}]}]}], truncated, totalAdditions, totalDeletions }`.
**Use when.** Approvals, Code Intelligence reviews, artifact inspection.
**Don't.** Encode add/delete by colour alone. Don't syntax-highlight at the cost of diff clarity —
diff tint wins; token colour is secondary and optional.

### D2. Evidence list

**Purpose.** The proof set behind a claim, approval, or finding. First-class, never a tooltip.
**Anatomy.** `<ul>` of evidence rows; each row: type glyph (test-run, log, diff, source, artifact,
policy-eval, human-note), label, producer (agent or person), timestamp, `Verified` / `Unverified` /
`Failed` marker, optional confidence, `Open` action. Header: `12 items · 9 verified · 2 failed · 1
unverified` + `Verify all` (only when permitted) + filter by kind.
**Variants.** `full` (approval detail, research finding) · `compact` (3 rows + `View all 12`) · `inline`
(single evidence reference).
**States.** default · loading (4 skeleton rows) · empty (`No evidence attached. An approval without
evidence requires an explicit override.`) · partial (some items `Unverified`, header states the ratio) ·
failed-item expanded (shows the failure output) · stale (item older than the freshness window: `41d old`
in `--iz-status-awaiting-fg`).
**Data shape.** `{ id, kind, label, producer: {type:'agent'|'human', id, name}, createdAt, status:
'verified'|'unverified'|'failed', confidence?, href, summary }`.
**Use when.** Every approval, every research finding, every report claim.
**Don't.** Allow approving a Critical-risk item with zero verified evidence — disable the action and
state why. Don't collapse evidence into a single "evidence: yes".

### D3. Source provenance row

**Purpose.** One research source with everything needed to judge whether to trust it: who published it,
when, when we retrieved it, and whether it held up.
**Anatomy.** Favicon-less domain glyph · title (link, wraps to 2 lines max) · domain · published date ·
retrieval date · source type (`primary` / `secondary` / `vendor` / `forum`) · status marker
(`Retrieved` / `Stale` / `Unreachable` / `Paywalled` / `Contradicted`) · cited-by count · `Open` and
`Copy citation`.
**Variants.** `row` (default, 2 lines) · `compact` (title + domain + status) · `detail` (adds excerpt,
archive link, and the exact claim it supports).
**States.** default · hover · stale (amber `Stale · 41d`) · unreachable (`Unreachable at verification`,
`--iz-status-failed-fg`) · paywalled (`Abstract only`) · contradicted (`Contradicted by 2 sources`,
links to them) · loading · archived-only.
**Data shape.** `{ sourceId, title, url, domain, publishedAt?, retrievedAt, type, status, citedBy, excerpt?, archiveUrl? }`.
**Use when.** Research Lab evidence rail; anywhere a claim cites an external source.
**Don't.** Show a source without a retrieval date. Don't hide failed sources — the brief requires
disclosure, so they are always rendered, sorted after healthy ones but never collapsed by default.

### D4. Guardrail summary

**Purpose.** The brief's non-negotiable: every workflow visibly declares permission level, budget limit,
allowed repositories, execution environment, and rollback strategy.
**Anatomy.** `<dl>` of exactly five rows, fixed order: `Permission`, `Budget`, `Repositories`,
`Environment`, `Rollback`. Label `--iz-text-micro` in `--iz-ink-3` (88px column), value `--iz-text-sm`
with mono for scopes/paths. Rows are 24px; the block has a 1px `--iz-border-default` top and bottom rule
and no background.
**Variants.** `full` (5 rows, approval detail, workflow header) · `compact` (5 rows at 20px, approval
card) · `inline` (single line: `Copilot · $40/run · 3 repos · sandbox · revert+slot` — used in table
rows only when the row is already expanded).
**States.** default · incomplete (a missing field renders `Not declared` in `--iz-status-failed-fg` and
blocks approval) · expanded value (long repo lists truncate to `3 repos +2` with a tooltip listing all).
**Data shape.** `{ permission: string, budget: {amount, currency, scope: 'run'|'day'|'month'}, repos: string[], environment: string, rollback: string }`.
**Use when.** Every approval, every workflow version header, every agent run detail.
**Don't.** Collapse it behind a disclosure on an approval. Don't paraphrase the values — show the
machine-readable scope string.

### D5. Policy check row

**Purpose.** Show which governance rules were evaluated against an action, and which one blocks it.
**Anatomy.** Status glyph (pass / fail / warn / skipped) + policy name + policy id chip + one-line
result (`Scope limited to reveilchat/backend`) + `View policy` link + evaluated-at timestamp.
**Variants.** `row` · `group` (collapsible set with `4 passed · 1 failed`) · `inline-summary`.
**States.** pass · fail (`--iz-status-failed-fg`, blocks the decision) · warn (`--iz-status-awaiting-fg`,
requires acknowledgement) · skipped (`Not applicable to this action`) · not-evaluated (stale evaluation:
`Re-evaluate` action).
**Data shape.** `{ policyId, name, status: 'pass'|'fail'|'warn'|'skipped', message, evaluatedAt, href }`.
**Use when.** Approval detail, workflow publish, integration connect.
**Don't.** Show only failures — passes are the evidence that the check ran.

### D6. Lineage trace rail

**Purpose.** Make the object chain navigable in one column: where this came from, what it produced.
**Anatomy.** Right rail (`--iz-trace-rail-w`) with two sections. `Upstream` (ancestors, 1 level
expanded by default, each row: type glyph, label, id chip, state). `Downstream` (children grouped by
type with counts and state breakdown: `Artifacts 4 · Evidence 12 · Approvals 1`). Footer: `Open full
trace` → a dedicated trace view.
**Variants.** `rail` (desktop) · `sheet` (<1024px, bottom sheet 70vh) · `embedded` (inside a drawer).
**States.** default · loading (3 skeleton rows per section) · empty upstream (`Root object — created
directly`) · empty downstream (`No artifacts yet`) · truncated (`+48 more` with a filter) · error.
**Data shape.** `{ upstream: [{type,id,label,state,href}], downstream: [{type, count, states: Record<string,number>, href}], totalDownstream }`.
**Use when.** Any object detail; default-open on Approvals.
**Don't.** Render the whole graph — one level each way, with counts. Don't make it the only path to an
ancestor (the breadcrumb must also work).

### D7. Cost / usage meter

**Purpose.** Show consumption of a resource (tokens, credits, minutes, API calls) against a ceiling.
**Anatomy.** Value + unit + `/ limit` + percentage + 6px bar (`--iz-radius-xs`) + optional projection
(`On pace for $612 by 18:00`).
**Variants.** `bar` (default, 120px min) · `ring` (never — see Don't) · `inline` (`$27.60 / $40.00 · 69%`).
**States.** under 80% (`--iz-viz-1`) · warning 80–99% (`--iz-status-awaiting-fg`) · breached 100%+
(`--iz-status-failed-fg`, bar full, `Ceiling reached` label) · unknown (`—`, `Usage not reported`) ·
loading.
**Data shape.** `{ used, limit, unit, format, projection?, period: 'run'|'day'|'month' }`.
**Use when.** Run detail, agent detail, project header, Overview cost panel.
**Don't.** Use a donut. Don't omit the numeric values in favour of the bar.

### D8. Budget bar

**Purpose.** The workspace/project-level version of D7, with threshold markers and policy consequence.
**Anatomy.** Full-width bar in a panel: label (`Daily budget`), values, 6px bar, tick marks at 80% and
100%, and a consequence line under it (`At 100%, new runs queue until reset 00:00 UTC`).
**Variants.** `daily` · `monthly` · `per-run` · `multi-segment` (spend by agent as a distribution bar
overlaid on the ceiling).
**States.** on-plan · warning · breached (bar red, consequence line bold, `Adjust ceiling` link if
permitted) · no-ceiling (`No ceiling set — unlimited spend` with a `Set a ceiling` action, shown in
amber because unlimited is a risk, not a neutral state).
**Data shape.** `{ period, used, limit?, currency, forecast?, thresholds: [0.8, 1.0], consequence }`.
**Use when.** Overview cost panel, project header, Approvals cost impact.
**Don't.** Hide the "no ceiling" state. Don't render a limit as `$0`.

---

## E. Domain objects

### E1. Agent status card

**Purpose.** One agent's identity, assignment, health, and throughput in a 240×120px block.
**Anatomy.** Header: agent avatar/monogram (24px) + name + runtime chip (`OpenCode` / `Codex` /
`Claude Code` / `OpenHands` / `Pi`) + model route chip. Body: current assignment (truncated, 1 line) +
status pill. Footer: runs today, success rate, median duration, cost today.
**Variants.** `card` (default 240×120) · `row` (list item, 48px: avatar, name, assignment, status,
throughput) · `compact` (fleet grid, 160×96: avatar, name, status dot + label, one metric).
**States.** active (live elapsed timer that updates every 10s — the only permitted ticking number,
because it is a clock not a metric) · idle (`Idle · 18m`) · queued · failed (with `Retry` inline) ·
degraded (`Runtime latency 4.2s, p95 target 1.5s`) · offline (`Last heartbeat 12m ago`) · paused
(`Paused by operator`, with resume action) · loading.
**Data shape.** `{ agentId, name, runtime, modelRoute: {reasoner, engineer, verifier}, status, assignment?: {type,id,label}, metrics: {runsToday, successRate, medianDurationMs, costToday}, lastHeartbeatAt }`.
**Use when.** Agent Command Centre registry, Overview fleet grid, agent pickers.
**Don't.** Animate the status dot. Don't show a card without the model route — routing is the product's
central claim about quality and cost.

### E2. Live activity stream

**Purpose.** A chronological, append-only feed of what agents are doing right now, readable at a glance.
**Anatomy.** `<ol aria-live="polite">` of events, newest first (pinned to top; no auto-scroll-jacking).
Each event: time (`04:18:22Z` mono), agent chip, verb, object chip, optional duration/result, expandable
payload (tool call, command, error).
**Variants.** `rail` (360px, Agent Command Centre) · `panel` (Overview, max 8 rows) · `embedded`.
**States.** streaming (`Streaming` indicator with a 1.5s pulse on a 6px dot — reduced-motion: static) ·
paused (`Paused — 14 new events` instead of silent jumping) · empty (`No activity. Events appear when an
agent starts work.`) · disconnected (`Reconnecting in 4s · 3 attempts`, degraded banner above) ·
filtered (by agent or event type; filter changes surface as chips).
**Data shape.** `{ eventId, at, agentId, agentName, verb: string, object?: {type,id,label}, durationMs?, result?: 'ok'|'failed', payload?: object }`.
**Use when.** Agent Command Centre, Overview, run detail.
**Don't.** Auto-scroll when the user has scrolled up. Don't insert above the viewport without a "new
events" affordance. Don't animate reordering of existing rows.

### E3. Log viewer

**Purpose.** Read a run's raw output with enough structure to find the failure.
**Anatomy.** Sticky toolbar: level filter (`All/Error/Warn/Info/Debug`), text filter, `Follow tail`
toggle, wrap toggle, `Download`, line count. Body: mono 11px/14px, line numbers optional, timestamp
column (mono), level chip, message, expandable structured payload. Virtualised above 2,000 lines.
**Variants.** `panel` (400px tall, in a drawer) · `full` (detail tab, full height) · `compact` (last 8
lines inline in a failed step row).
**States.** default · following (auto-scroll, indicator on) · paused-follow (`14 new lines`) · filtered ·
no-matches (`No lines match "ECONNREFUSED" · Show all 4,182`) · empty · error · truncated.
**Data shape.** `{ lines: [{n, at, level, message, payload?}], totalLines, truncated, stream: boolean }`.
**Use when.** Run detail, step detail, integration health.
**Don't.** Colour the whole line by level — colour the level chip and the message text only. Don't render
5,000 lines without virtualisation.

### E4. Timeline

**Purpose.** Show a bounded sequence of events with durations, where position carries meaning (schedules,
run steps, notification history).
**Anatomy.** Horizontal (time axis) or vertical (event list). Each item: time marker, title, duration bar
or duration text, state, actor, and a link. A single `now` rule in `--iz-ink-1` for live views.
**Variants.** `vertical-steps` (run execution, 8 steps) · `horizontal-gantt` (schedules next 24h) ·
`event-log` (audit history, dense).
**States.** default · now-marker · item hover (shows exact times) · empty · loading · degraded (a gap in
data rendered as a hatched band labelled `No data 02:10–02:40`, never as zero).
**Data shape.** `{ items: [{id, label, startAt, endAt?, state, actor, href}], now?: string, scale: 'minutes'|'hours'|'days' }`.
**Use when.** Run steps, schedule windows, approval audit history.
**Don't.** Use a timeline for unordered data. Don't animate the now-marker (it would be a decorative
second hand).

### E5. Code / ID chip

**Purpose.** Render a machine identifier so it can be read, copied, and trusted.
**Anatomy.** Mono `--iz-text-mono-sm`, `--iz-color-surface-2` background, 1px `--iz-border-subtle`,
`--iz-radius-xs`, 4px×6px padding, optional type prefix tint (`run_` in `--iz-ink-3`), copy button on
hover/focus.
**Variants.** `id` (truncated to 14 chars + `…`) · `full` (detail headers, wraps with `word-break`) ·
`code` (inline code, e.g. `services/auth/token.ts`) · `sha` (7-char git sha) · `copyable` (explicit
button, always visible in detail headers).
**States.** default · hover (copy affordance appears) · copied (`Copied` label for 1.2s, `aria-live`) ·
focus-visible · truncation-expanded (tooltip shows full value).
**Data shape.** `{ value, kind: 'id'|'code'|'sha'|'path', prefix?: string, truncate?: boolean }`.
**Use when.** Any identifier, path, or hash in a table or detail header.
**Don't.** Use for human names. Don't truncate an ID in a detail header. Don't hide copy behind a
right-click.

---

## F. States

### F1. Empty state

**Purpose.** Teach the surface, not announce absence.
**Anatomy.** Optional 32px glyph, title (`--iz-text-md`), 1–2 line explanation (`--iz-text-base`,
`--iz-ink-2`, max 52ch), one primary action, optional secondary link. Centred, `--iz-space-40` vertical.
**Variants.** `first-run` (no data ever: explains the object and offers the create action) · `filtered`
(no match: states active filters + `Clear filters`) · `cleared` (all work done: `No approvals waiting.
Queue is clear.` with last-cleared time) · `inline` (inside a panel, glyph omitted, 16px padding).
**States.** static only.
**Data shape.** `{ kind, title, body, primaryAction?, secondaryAction?, activeFilters? }`.
**Use when.** Every list, table, panel, and drawer body.
**Don't.** Say "Nothing here" or "No data". Don't show an empty state while loading — that is a skeleton.

### F2. Skeleton loader

**Purpose.** Reserve the real layout while data arrives, so nothing jumps.
**Anatomy.** `--iz-color-surface-3` blocks at the exact dimensions of the eventual content, 4px radius,
1.6s opacity pulse 0.55→1 (reduced-motion: static).
**Variants.** `table` (8 rows × column widths) · `text` (3 lines, last at 60%) · `panel` (header + 4
rows) · `card` · `chart` (axis + 12 bars) · `diff` (3 file blocks).
**States.** animating · static (reduced motion).
**Data shape.** none; sizing comes from the real component's layout.
**Use when.** Any fetch longer than 150ms.
**Don't.** Use a centred spinner for content. Don't skeleton something that resolves in <150ms (it
flashes). Don't put skeletons inside a button — that is B-button loading.

### F3. Error state

**Purpose.** Explain a failure in terms the operator can act on.
**Anatomy.** Glyph, title (`Could not load runs`), cause line (what failed and where), one primary
retry action, `Copy error details` (id + trace id), optional link to status page. `role="alert"`.
**Variants.** `region` (panel or table area) · `full-page` (module failed to load) · `inline` (a single
field or metric) · `partial` (some data loaded: banner above the table plus the loaded rows).
**States.** static; `retrying` (action in loading state).
**Data shape.** `{ title, cause, traceId, retryable, documentationHref? }`.
**Use when.** Any failed fetch or mutation that is not a validation error.
**Don't.** Show a raw stack trace as the primary message. Don't offer retry for a non-retryable 403.

### F4. Permission-denied state

**Purpose.** Tell the user the capability exists, who can grant it, and what they can do instead.
**Anatomy.** Lock glyph, title (`You need the Approver role`), explanation naming the required role and
the workspace owner, actions `Request access` (if the tenant supports it) and `Back to Overview`.
**Variants.** `module` (whole screen) · `action` (inline, under a disabled control) · `data`
(`This run belongs to a project you cannot access`) · `environment` (`Production access is restricted to
the Release role`).
**States.** static.
**Data shape.** `{ requiredRole, currentRole, owner: {name, email}, requestable: boolean }`.
**Use when.** Any 403 surface.
**Don't.** Bounce the user back silently. Don't show a 404 for a permission problem — leaking
nonexistence is a different (and worse) contract.

### F5. Offline banner

**Purpose.** State that the connection is gone, what still works, and what is queued.
**Anatomy.** 40px bar directly under the scope bar, `--iz-status-degraded-bg`, glyph + `Offline — showing
data from 04:12Z. 2 approvals queued and will submit when reconnected.` + `Retry now`. Persistent
(sticky with the scope bar), never dismissable; a `Reconnecting` variant shows attempt count.
**Variants.** `offline` · `reconnecting` · `read-only` (server unreachable but cached data fresh) ·
`resumed` (4s green confirmation then removed).
**States.** offline · reconnecting (attempt `2 of 5`) · resumed.
**Data shape.** `{ since, lastSyncedAt, queuedWrites: number, attempt?, maxAttempts? }`.
**Use when.** Any connectivity loss.
**Don't.** Let the user believe a queued approval succeeded. Mark queued writes explicitly in the
affected rows (`Queued — not submitted`) until confirmed.

### F6. Degraded-system banner

**Purpose.** State that a dependency is operating below contract, the impact, and the workaround.
**Anatomy.** 40px bar, `--iz-status-awaiting-bg`, warning glyph, dependency name, impact sentence,
`View status`, dismiss (session only, restorable from the notification centre).
**Variants.** `dependency` (model provider, VCS, CI, sandbox) · `partial-data` (`Agent metrics are 6m
stale`) · `feature-limited` (`Diff view unavailable for >5,000-line changes`).
**States.** default · multiple (stack to max 2, then `+2 more systems degraded`) · resolved (auto-dismiss
after 4s with a confirmation toast).
**Data shape.** `{ dependency, impact, workaround, startedAt, statusHref, severity: 'P1'|'P2' }`.
**Use when.** A dependency breaches its contract but the product still functions.
**Don't.** Use it for a total outage (that is the error state or offline banner). Don't leave a resolved
banner up.

---

## G. Composite patterns (assembled from the above, not separate components)

These are documented so screens compose consistently. They are not new primitives.

| Pattern | Composition | Used on |
|---|---|---|
| **Posture strip** | 4 × `MetricTile/posture` + `StatusPill` for overall posture + `BudgetBar/inline`, divided by 1px rules | Overview |
| **Needs-you rail** | `ApprovalCard/card` × 3 + `NotificationRow` (compact) + `EmptyState/inline` when clear | Overview |
| **Queue–detail–evidence** | `DataTable` or list of `ApprovalCard/queue-row` + detail region + `LineageTraceRail` | Approvals |
| **Agent fleet grid** | `AgentStatusCard/compact` in `repeat(auto-fit, minmax(160px, 1fr))` | Overview, Agent CC |
| **Finding ledger** | `DataTable` (claim, confidence, sources, age) + `EvidenceList` + `SourceProvenanceRow` | Research Lab |
| **Decision record** | `GuardrailSummary` + `PolicyCheckRow/group` + `EvidenceList` + decision stamp + `Timeline/event-log` | Approvals, audit |
