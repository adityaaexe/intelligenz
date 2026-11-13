# INTELLIGENZ — Design System

> Version 1.0 · Phase 1a · Canonical token source for `prototype/` and the later Next.js migration.
> Every token below is a real CSS custom property name with the `--iz-` prefix. Hex values are
> computed from OKLCH and contrast ratios are measured, not estimated. Ratios in parentheses are
> against `--iz-color-canvas` unless stated otherwise.

---

## 1. Register and the job of this interface

**Register:** product (design serves the task), not brand.

The operator is not browsing. They are answering four questions under time pressure, often while
screen-sharing with someone who has authority over them:

1. Is the system healthy?
2. What is it doing right now?
3. What needs a human decision?
4. What did it cost, and can I prove what happened?

Every visual decision below is justified by one of those four. Anything that does not serve them is
removed.

---

## 2. Visual direction — "Operational Ledger"

**The scene:** 06:40 in a dispatch office. Paper flight-progress strips in a rack, each one a fixed
grid of fields you can read at arm's length; a graphite equipment rack behind them; one crimson tag
on the single strip that needs a controller's signature.

That is the aesthetic, and it is literal about three things:

| Decision | Why it fits this product |
|---|---|
| **Light canvas, dark graphite chrome** | The content is paper: white, high-contrast, printable, legible when screen-shared on a projector or captured into an audit PDF. The chrome is the rack: structurally dark, always present, never competing with data. The split makes "tool" and "work product" instantly separable. |
| **Rules, not cards** | A governance surface must not imply containment it cannot prove. Panels are regions divided by 1px rules on a shared grid. No floating cards, no shadows on content, no nested elevation. A run is not a card; it is a row in a ledger. |
| **Colour is data, never decoration** | Every chromatic pixel on screen is a status, a risk, a confidence, or the human signature. There is no accent gradient, no tinted hero, no brand wash. A reader can trust that colour means something, because it always does. |

**What this explicitly is not.** Not a dark "AI ops" NOC (the category's first reflex). Not an
editorial-magazine treatment of a tool (the second reflex: serif display, generous whitespace,
oversized headings). The ceiling on type size is 28px and it is used only for posture metrics;
there is no display type, no hero, no marketing register anywhere in the product.

**Density is the feature.** A senior SRE should see 18 runs, their states, costs, and durations
without scrolling. A founder should see the same screen and read "three things need me, spend is
on plan" in five seconds. The layout answers both by layering: posture strip first, then the
operational table, then the detail a click away.

---

## 3. Design principles

Each principle has an operational consequence. If a proposal violates the consequence, it is
rejected regardless of how it looks.

| # | Principle | Operational consequence |
|---|---|---|
| 1 | **State before story** | Every object shows its state, age, and owner before its description. No screen leads with prose. A run's status pill and elapsed time appear to the left of its title. |
| 2 | **Colour never carries meaning alone** | Every status, risk, and confidence value ships a glyph and a text label. Removing all colour must leave the screen fully readable. Reviewers reject colour-only diffs. |
| 3 | **Evidence is a first-class object, not a tooltip** | Claims, approvals, and findings link to `evd_` records with source, timestamp, and retrieval window. Evidence never hides behind hover. |
| 4 | **Destructive actions restate their blast radius** | Any action that changes code, spend, or permissions shows the affected repos, the budget delta, and the rollback path in the confirmation, in that order. |
| 5 | **Density over decoration, but never below legibility floors** | Tables may run at 28px rows. Type never drops below 11px; targets never below 24px; contrast never below 4.5:1 for text. Compression comes from spacing, not from shrinking type. |
| 6 | **The system admits what it does not know** | Unknown, stale, partial, and simulated are visible states with their own treatment. Absence of data is rendered as absence, never as zero and never as a blank cell. |

---

## 4. Colour

### 4.1 Strategy

**Restrained, achromatic chrome, semantic-only chroma.** Neutrals carry structure; colour carries
state. There is exactly one non-semantic colour in the product — the seal crimson — and it appears
in three places only (§4.5).

Rejected alternatives and why: a saturated brand hue as primary (every usable hue is already a
status: blue = active, green = completed, amber = awaiting, orange = degraded, red = failed);
violet/indigo accent (the AI-tool reflex, and it collides with focus); warm-tinted neutrals (they
desaturate amber and red, the two colours that matter most here).

Neutrals are tinted 0.003–0.014 chroma toward hue 258 (cool blue-grey). Reason: cool neutrals keep
maximum perceptual separation from the warm status band (25°–85°). Chrome sits at chroma 0.014 so it
reads as graphite, not as black.

### 4.2 Light theme — surfaces and structure

| Token | OKLCH | Hex | Contrast | Use |
|---|---|---|---|---|
| `--iz-color-canvas` | `oklch(1 0 0)` | `#FFFFFF` | — | Content surface, table background, document body |
| `--iz-color-surface-1` | `oklch(0.981 0.003 255)` | `#F7F9FB` | 1.02 | Panels, side panels, filter bars, inset regions |
| `--iz-color-surface-2` | `oklch(0.962 0.004 255)` | `#F1F3F5` | 1.07 | Table headers, row hover, input wells, code blocks |
| `--iz-color-surface-3` | `oklch(0.938 0.005 255)` | `#E8EBEE` | 1.14 | Pressed states, selected row base, skeletons |
| `--iz-color-chrome` | `oklch(0.215 0.014 258)` | `#151A20` | 17.51 | Sidebar, top bar, scope bar |
| `--iz-color-chrome-raised` | `oklch(0.262 0.014 258)` | `#20252B` | 14.83 | Menus inside chrome, sidebar footer block |
| `--iz-color-chrome-hover` | `oklch(0.245 0.014 258)` | `#1C222A` | — | Nav item hover |
| `--iz-color-chrome-selected` | `oklch(0.283 0.015 258)` | `#232930` | — | Active nav item fill (text must use `--iz-on-chrome-1`) |

### 4.3 Light theme — text, borders, focus, seal

| Token | OKLCH | Hex | Contrast | Use |
|---|---|---|---|---|
| `--iz-ink-1` | `oklch(0.205 0.012 258)` | `#14171D` | 17.91 | Primary text, table cell text, headings |
| `--iz-ink-2` | `oklch(0.395 0.012 258)` | `#42474D` | 9.40 | Secondary text, descriptions, form help |
| `--iz-ink-3` | `oklch(0.495 0.011 258)` | `#5E6268` | 6.13 (5.80 on surface-1) | Meta, timestamps, units, column headers |
| `--iz-ink-disabled` | `oklch(0.660 0.008 258)` | `#8F9297` | 3.11 | Disabled labels only (WCAG 1.4.3 exemption). Never body copy. |
| `--iz-on-chrome-1` | `oklch(0.985 0.002 258)` | `#F9FAFB` | 16.78 on chrome | Nav labels, active nav |
| `--iz-on-chrome-2` | `oklch(0.800 0.008 258)` | `#BBBEC3` | 9.38 on chrome | Group labels, secondary chrome text, icons |
| `--iz-on-chrome-3` | `oklch(0.660 0.008 258)` | `#8F9297` | 5.63 on chrome | Counts, keyboard hints. Not on `chrome-raised` (4.96) below 12px. |
| `--iz-border-subtle` | `oklch(0.925 0.006 258)` | `#E4E6EA` | 1.19 | Row dividers, decorative separators (not a control boundary) |
| `--iz-border-default` | `oklch(0.885 0.007 258)` | `#D6D9DE` | 1.41 | Panel and region borders |
| `--iz-border-strong` | `oklch(0.780 0.009 258)` | `#B4B8BD` | 2.00 | Emphasis rules, table header underline, split handles |
| `--iz-border-control` | `oklch(0.640 0.009 258)` | `#898C92` | **3.36** (3.18 on surface-1) | Input, select, checkbox, radio, toggle boundaries — the only border allowed to identify a control, because 1.4.11 needs 3:1 |
| `--iz-focus` | `oklch(0.500 0.170 285)` | `#5D4DBE` | **6.40** | Focus ring on light surfaces |
| `--iz-focus-on-chrome` | `oklch(0.720 0.140 285)` | `#9C96F8` | **6.81** on chrome | Focus ring inside dark chrome |
| `--iz-seal` | `oklch(0.520 0.195 22)` | `#C01B31` | 6.11 | Brand mark and recorded human decision stamp only (§4.5) |

**Border rule.** A border used to identify an interactive control must use `--iz-border-control`
(≥3:1). Decorative dividers use `--iz-border-subtle` and are never the sole means of separating two
interactive targets — those are separated by ≥8px of space as well.

### 4.4 Status semantics

Seven operational states, fixed vocabulary. Each ships `-fg`, `-bg`, `-border` (derived at 24%
opacity of fg), a **glyph**, and an **always-present text label**. Pill radius is 4px, not a pill.

| State | Token stem | fg | bg | Contrast | Glyph | Label | Meaning |
|---|---|---|---|---|---|---|---|
| Active | `--iz-status-active-*` | `#0059A7` | `#E8F3FF` | 6.28 | filled circle + halo arc | `Running` | Executing now; has a live process |
| Queued | `--iz-status-queued-*` | `#4A4D52` | `#F1F2F4` | 7.58 | three stacked bars (dashed top) | `Queued` | Accepted, waiting for a worker or a slot |
| Completed | `--iz-status-completed-*` | `#006731` | `#E4F8E8` | 6.31 | check in circle | `Completed` | Finished and verified |
| Failed | `--iz-status-failed-*` | `#B71824` | `#FFEDEB` | 5.86 | cross in circle | `Failed` | Terminal failure; retry available |
| Awaiting approval | `--iz-status-awaiting-*` | `#8A5700` | `#FEF0D4` | 5.44 | pause bars in circle | `Awaiting approval` | Blocked on a human decision |
| Degraded | `--iz-status-degraded-*` | `#A14206` | `#FFECE2` | 5.57 | half-filled diamond | `Degraded` | Operating below contract; results unreliable |
| Offline | `--iz-status-offline-*` | `#4B4D50` | `#EEEEF0` | 7.31 | circle with slash | `Offline` | No heartbeat; last seen shown |

Secondary state words used inside pills where a workflow needs more resolution (all reuse the
seven stem colours, never introduce new hues): `Nominal` (posture only, completed stem), `Blocked`,
`Retrying`, `Cancelled`, `Timed out`, `Skipped`, `Stale`.

**Prohibited:** a status pill without a text label; a status dot used as the only encoding of state;
green as a brand accent anywhere; red used for anything other than failure, destruction, or a
blocking risk.

### 4.5 Risk levels

Risk is a **different visual form** from status — four segments filled, plus the word — so the two
dimensions never get confused when they sit side by side in a row.

| Level | Token stem | Ink | Segments filled | Label | Threshold (composite score 0–100) |
|---|---|---|---|---|---|
| Low | `--iz-risk-low` | `--iz-ink-3` | 1 / 4 | `Low` | 0–24 |
| Medium | `--iz-risk-medium` | `#8A5700` | 2 / 4 | `Medium` | 25–49 |
| High | `--iz-risk-high` | `#A14206` | 3 / 4 | `High` | 50–74 |
| Critical | `--iz-risk-critical` | `#B71824` | 4 / 4 | `Critical` | 75–100 |

The composite score is always shown numerically next to the label in approvals (`High · 68`). Risk
never uses a pill shape; it uses the segmented bar so it cannot be mistaken for status.

### 4.6 Confidence

Confidence is a number with a band label and a 5-segment meter in `--iz-ink-1`. It is **not**
coloured green/amber above thresholds; that would smuggle a verdict into a measurement.

| Band | Range | Label | Treatment |
|---|---|---|---|
| High | 0.80–1.00 | `High` | ink meter, 5/5 segments |
| Moderate | 0.60–0.79 | `Moderate` | ink meter, 4/5 or 3/5 |
| Low | 0.40–0.59 | `Low` | ink meter + `--iz-ink-3` label |
| Insufficient | < 0.40 | `Insufficient evidence` | meter empty, label in `--iz-status-failed-fg`, decision actions disabled |

Two decimals always (`0.87`). A confidence value without a source count beside it is a defect:
render `0.87 · 12 sources`.

### 4.7 Data visualisation palette

Ordered categorical ramp. All ≥3:1 against `--iz-color-canvas`; none is a status hue.

| Token | Hex | Use |
|---|---|---|
| `--iz-viz-1` | `#2A61B1` | Primary series, spend, throughput |
| `--iz-viz-2` | `#007C84` | Second series |
| `--iz-viz-3` | `#946900` | Third series |
| `--iz-viz-4` | `#93398E` | Fourth series |
| `--iz-viz-5` | `#1F6F3D` | Fifth series |
| `--iz-viz-6` | `#6A727E` | Sixth series, "other" bucket |

Rules: max 6 series; a 7th becomes "Other". Every chart ships a legend with labels (never colour
alone) and a table fallback behind a "View as table" control. No gradients in chart fills; area
fills use 12% opacity of the series colour. Grid lines `--iz-border-subtle`; axes `--iz-border-default`.

### 4.8 Dark theme

Dark is a first-class override, not an inversion. It exists for on-call and NOC walls. It is
selected by `:root[data-theme="dark"]` and respects `prefers-color-scheme` when
`data-theme="system"`.

| Token | Hex | Contrast |
|---|---|---|
| `--iz-color-canvas` | `#101316` | — |
| `--iz-color-surface-1` | `#171A1E` | — |
| `--iz-color-surface-2` | `#1E2125` | — |
| `--iz-color-surface-3` | `#24282D` | — |
| `--iz-color-chrome` | `#0A0C0F` | — |
| `--iz-ink-1` | `#F0F2F4` | 16.59 |
| `--iz-ink-2` | `#B8BBBE` | 9.98 |
| `--iz-ink-3` | `#96989D` | 6.98 (6.56 on surface-1) |
| `--iz-border-subtle` | `#23272C` | — |
| `--iz-border-default` | `#2B2E33` | — |
| `--iz-border-control` | `#70757C` | 4.01 |
| `--iz-focus` | `#9C96F8` | 6.81 |
| `--iz-status-active-fg` | `#7ABDFF` | 9.34 |
| `--iz-status-completed-fg` | `#7FCC94` | 9.72 |
| `--iz-status-failed-fg` | `#FB817A` | 7.58 |
| `--iz-status-awaiting-fg` | `#E8BE62` | 10.61 |
| `--iz-status-degraded-fg` | `#FC9B6F` | 8.93 |
| `--iz-status-queued-fg` | `#A8ACB2` | 7.9 |
| `--iz-status-offline-fg` | `#8A8D93` | 5.6 |

Dark status backgrounds are derived, not hand-picked:
`--iz-status-*-bg: color-mix(in oklab, var(--iz-status-*-fg) 16%, var(--iz-color-canvas))`.
Seal crimson stays `#C01B31` on dark (3.4:1) and is therefore only used there at ≥16px or as a fill
behind `#FFFFFF` text.

### 4.9 Colour usage rules

- Maximum two chromatic surfaces in one viewport region. If a screen needs more, the information
  architecture is wrong, not the palette.
- Tinted backgrounds are only for status pills, risk bars, alert rows, and selected rows. Never for
  a panel header, a card, or a page section.
- Selected row: `--iz-color-surface-3`, plus a 2px `--iz-ink-1` left inset bar **only inside
  tables** (it marks selection, not decoration). Hover row: `--iz-color-surface-2`.
- Critical-row tint: `#FAF1F0` (measured 16.13:1 with ink-1) is reserved for rows whose risk is
  Critical and which are awaiting a decision.
- No gradient anywhere. No `background-clip: text`. No glassmorphism.

---

## 5. Typography

### 5.1 Families

| Token | Stack | Use |
|---|---|---|
| `--iz-font-sans` | `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif` | Everything except code and identifiers |
| `--iz-font-mono` | `ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace` | IDs, hashes, paths, model slugs, log lines, diffs |

No webfonts. The prototype must run from `file://` offline, and an operations tool should render in
the operator's OS text settings — including at 125% and 150% display scaling. One family, three
weights.

### 5.2 Scale

Fixed px, not fluid. Product UI is viewed at consistent DPI; a heading that shrinks inside a 400px
panel looks broken.

| Token | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|
| `--iz-text-micro` | 11px / 14px | 500 | `0.04em`, uppercase | Table column headers, unit labels, badge text. **The only uppercase style in the product.** |
| `--iz-text-xs` | 12px / 16px | 400 | `0` | Meta rows, timestamps, pill labels, secondary cells, help text |
| `--iz-text-sm` | 13px / 18px | 400 | `0` | **Default.** Body, table cells, inputs, buttons, menu items |
| `--iz-text-base` | 14px / 20px | 400 | `0` | Prose blocks, dialog body, drawer descriptions, empty-state copy |
| `--iz-text-md` | 16px / 22px | 600 | `-0.005em` | Panel and section headings (h3) |
| `--iz-text-lg` | 18px / 24px | 600 | `-0.01em` | Sub-screen headings (h2) |
| `--iz-text-xl` | 22px / 28px | 600 | `-0.012em` | Screen title (h1), one per screen |
| `--iz-text-2xl` | 28px / 32px | 600 | `-0.016em` | Posture metrics only. Hard ceiling. |
| `--iz-text-mono-sm` | 12px / 16px | 400 | `0` | IDs in tables, inline code |
| `--iz-text-mono-xs` | 11px / 14px | 400 | `0` | Log lines, diffs, hash fragments |

Weights: `400` body, `500` labels/micro/emphasis, `600` headings and metric values. No 700+. No
italic except quoted user text and legal disclaimers.

### 5.3 Numeric treatment

This product is full of durations, costs, token counts, and identifiers. They have their own rules.

| Rule | Specification |
|---|---|
| Alignment | All numeric table columns are right-aligned; headers right-aligned to match. Text left, status left, actions right. |
| Figures | `font-variant-numeric: tabular-nums slashed-zero` on every numeric element (`.iz-num`). Proportional figures are prohibited in tables, metrics, and comparisons. |
| Units | Unit rendered at 0.85em in `--iz-ink-3` with a 2px gap. `14m 22s`, not `14m22s`. Unit never wraps to its own line. |
| Durations | `< 1s` → `412ms`; `< 1min` → `8.4s`; `< 1h` → `14m 22s`; `≥ 1h` → `1h 04m`. Never `00:14:22` outside log lines. |
| Costs | `$2.14` at ≥$1; `$0.0083` below $1 (4dp); per-unit costs always name the unit (`$0.0083 / 1K tok`). Currency symbol always present. |
| Token counts | `184.3k`, `1.42M`, one decimal, never raw seven-digit integers in a table cell. |
| Percentages | Integer `69%` in tables; one decimal `68.7%` in detail views when the distinction matters. |
| Timestamps | Lists: relative `3m ago` inside `<time datetime>`, with the absolute UTC value in `title` and in the accessible name. Audit surfaces: absolute `2026-11-13 04:18:22Z` only. Never mix the two in one column. |
| Identifiers | Display full in detail headers (`run_01JB7Q2K8M4X7T3R9W`), truncated to 14 chars + `…` in tables, with a copy control carrying `aria-label="Copy run ID"`. Truncation never removes the prefix. |
| Unknown values | `—` with `aria-label="Not reported"`. Never `0`, never `N/A`, never an empty cell. |

### 5.4 Text rules

- Line length for prose: 62–72ch. Tables may run to any width.
- `text-wrap: balance` on screen titles and panel headings; `text-wrap: pretty` on prose blocks.
- Sentence case for all headings, labels, and buttons. Uppercase is reserved for `--iz-text-micro`.
- No tracked uppercase eyebrow above any section. No numbered section markers (`01 / 02`) outside a
  genuine ordered sequence such as an execution timeline.
- Truncation: table cells truncate with ellipsis and expose the full value on focus and hover. Never
  truncate a status label, a cost, or a duration.

---

## 6. Spacing, density, and sizing

### 6.1 Spacing scale

4px base. Token names are the pixel value — no lookup table needed at implementation time.

| Token | Value | Typical use |
|---|---|---|
| `--iz-space-0` | 0 | Reset |
| `--iz-space-2` | 2px | Icon-to-label gap inside pills |
| `--iz-space-4` | 4px | Chip padding-y, tight stacks |
| `--iz-space-6` | 6px | Button padding-y (sm), cell gap |
| `--iz-space-8` | 8px | Default gap between related items, cell padding-y |
| `--iz-space-10` | 10px | Compact cell padding-y |
| `--iz-space-12` | 12px | Cell padding-x, form field gap |
| `--iz-space-16` | 16px | Panel padding, card padding, stack gap |
| `--iz-space-20` | 20px | Section gap inside a panel |
| `--iz-space-24` | 24px | Page gutter, region gap |
| `--iz-space-32` | 32px | Between major regions |
| `--iz-space-40` | 40px | Empty-state vertical padding |
| `--iz-space-48` | 48px | Page top padding on sparse screens |
| `--iz-space-64` | 64px | Maximum stack separation |
| `--iz-space-80` | 80px | Reserved, full-page empty states only |

### 6.2 Density modes

A user preference (`data-density` on `<html>`), persisted per user, defaulting to `default`.

| Mode | Row height | Cell padding-y | Cell padding-x | Body size | Applies to |
|---|---|---|---|---|---|
| `compact` | 28px (`--iz-row-compact`) | 5px | 10px | 12px | Power users, 1440px+ tables with >40 rows |
| `default` | 32px (`--iz-row-default`) | 7px | 12px | 13px | Everything, unless stated |
| `comfortable` | 40px (`--iz-row-comfortable`) | 11px | 16px | 13px | Touch-first, tablet |

Density changes spacing only. It never changes type below 12px, never reduces a hit target below
24×24px, and never hides a status label. A compact row still shows status glyph + label.

### 6.3 Component sizing

| Token | Value | Use |
|---|---|---|
| `--iz-control-sm` | 24px | Table row actions, icon buttons in dense toolbars |
| `--iz-control-md` | 28px | Default button, select, segmented control |
| `--iz-control-lg` | 32px | Primary form inputs, search fields |
| `--iz-control-xl` | 36px | Command palette input, approval decision buttons |
| `--iz-sidebar-w` | 264px | Expanded sidebar |
| `--iz-sidebar-rail-w` | 64px | Collapsed icon rail |
| `--iz-topbar-h` | 56px | Global top bar |
| `--iz-scopebar-h` | 40px | Scope bar (workspace / project / environment) |
| `--iz-row-header-h` | 32px | Table header height, all densities |
| `--iz-trace-rail-w` | 400px | Lineage / evidence rail |
| `--iz-queue-pane-w` | 360px | Approval queue, research campaign list |
| `--iz-activity-rail-w` | 360px | Live activity stream |
| `--iz-max-content` | 1760px | Content max width beyond 3xl breakpoint |

---

## 7. Layout and grid

### 7.1 Shell regions

```
┌──────────────────────────────────────────────────────────────────────┐
│ Top bar 56px — workspace · global search · mode · env · notifications │
├──────────┬───────────────────────────────────────────────────────────┤
│ Sidebar  │ Scope bar 40px — workspace / project / environment / branch │
│ 264px    ├───────────────────────────────────────────────────────────┤
│ (or 64)  │                                                           │
│          │  Screen header  (title 22px · description · actions)       │
│          │  ─────────────────────────────────────────────────────    │
│          │  Content grid — 12 columns, 24px gutter                   │
│          │                                                           │
└──────────┴───────────────────────────────────────────────────────────┘
```

- Sidebar is fixed, independently scrollable, and never scrolls with content.
- Top bar and scope bar are sticky; both stay visible at every breakpoint above 640px.
- Screen header is part of the scroll container, not sticky, except on Approvals where the decision
  bar is sticky to the bottom of the viewport.
- Content padding: `--iz-space-24` horizontal at ≥1280px, `--iz-space-16` at 768–1279px,
  `--iz-space-12` below 768px.

### 7.2 Grid

12 columns, `--iz-space-24` gutter, no outer margin beyond content padding. Panel internals use a
4-column sub-grid. Standard spans:

| Pattern | Span | Used by |
|---|---|---|
| Primary table + secondary rail | 8 / 4 | Overview, Research Lab |
| Queue + detail + trace | 3 / 5 / 4 (fixed+fluid+fixed) | Approvals |
| Agent list + detail + activity | 3 / 6 / 3 | Agent Command Centre |
| Full width | 12 | Posture strip, ledger tables |
| Metric row | 3 × 4 | Posture metrics, cost tiles |

### 7.3 Breakpoints and collapse behaviour

| Token | Width | Behaviour |
|---|---|---|
| `--iz-bp-sm` | 640px | Nav becomes an off-canvas drawer; scope bar collapses to two chips + overflow; tables drop to 4 priority columns with a row-expand drawer |
| `--iz-bp-md` | 768px | Single column content; rails become full-width stacked sections; screen header actions move into an overflow menu |
| `--iz-bp-lg` | 1024px | Sidebar collapses to 64px icon rail; three-pane layouts become two-pane; trace rail becomes a bottom sheet |
| `--iz-bp-xl` | 1280px | Full sidebar 264px; two-pane layouts active |
| `--iz-bp-2xl` | 1440px | Base desktop design; three-pane layouts active |
| `--iz-bp-3xl` | 1680px | Content caps at 1760px, centred |

Column priority when a table loses columns: `status` and `name` never drop; then `age`; then `cost`;
then `model`; then `owner`; then `id`. The dropped values remain reachable in the expanded row.

---

## 8. Surfaces, elevation, borders, shadows

| Layer | Surface | Border | Shadow |
|---|---|---|---|
| Canvas | `--iz-color-canvas` | — | none |
| Panel / region | `--iz-color-surface-1` | `1px solid --iz-border-default` | none |
| Inset (table header, code) | `--iz-color-surface-2` | `1px solid --iz-border-subtle` | none |
| Sticky table header | `--iz-color-surface-2` | bottom `1px --iz-border-strong` | none; a 1px rule, not a shadow |
| Dropdown / popover | `--iz-color-canvas` | `1px solid --iz-border-default` | `--iz-shadow-popover` |
| Drawer | `--iz-color-canvas` | left `1px --iz-border-default` | `--iz-shadow-drawer` |
| Dialog | `--iz-color-canvas` | `1px solid --iz-border-default` | `--iz-shadow-modal` |
| Toast | `--iz-color-chrome` | none | `--iz-shadow-toast` |

```css
--iz-shadow-popover: 0 1px 2px rgb(16 18 23 / 0.06), 0 6px 16px -4px rgb(16 18 23 / 0.14);
--iz-shadow-drawer:  -8px 0 24px -8px rgb(16 18 23 / 0.18);
--iz-shadow-modal:   0 2px 4px rgb(16 18 23 / 0.06), 0 20px 40px -12px rgb(16 18 23 / 0.22);
--iz-shadow-toast:   0 1px 2px rgb(16 18 23 / 0.10), 0 10px 24px -6px rgb(16 18 23 / 0.20);
```

**No static content ever carries a shadow.** Elevation is reserved for surfaces that float above the
document (menus, drawers, dialogs, toasts, tooltips) and therefore must be dismissed. Cards are not
used as a layout primitive anywhere in this product.

Radii: `--iz-radius-xs: 2px` (checkbox, tag), `--iz-radius-sm: 4px` (button, input, status pill,
risk bar end), `--iz-radius-md: 6px` (panel, dropdown, drawer edge), `--iz-radius-lg: 8px` (dialog).
Nothing above 8px except the circular avatar and the 6px status dot.

Z-index scale: `--iz-z-base: 0`, `--iz-z-sticky: 10`, `--iz-z-chrome: 20`, `--iz-z-dropdown: 100`,
`--iz-z-drawer: 200`, `--iz-z-scrim: 290`, `--iz-z-modal: 300`, `--iz-z-palette: 320`,
`--iz-z-toast: 400`, `--iz-z-tooltip: 500`.

---

## 9. Iconography

- Inline SVG only. No icon font, no sprite fetch, no external library.
- Grid 16×16, `viewBox="0 0 16 16"`, `stroke-width="1.5"`, `stroke-linecap="round"`,
  `stroke-linejoin="round"`, `fill="none"` unless the glyph is intentionally solid (status dots only).
- Two optical sizes: 16px in dense UI and tables, 20px in the sidebar and screen headers. Never scale
  a 16px icon to 24px — author a 20px version.
- Colour is `currentColor`; an icon never hardcodes a hue.
- **Every icon-only control carries an accessible name** via `aria-label`, and a tooltip. In the
  64px rail, the nav label moves into the tooltip and the `<a>` keeps its text in a visually hidden
  span — accessible name never comes from the tooltip alone.
- Stroke joins must not be simulated with CSS transforms. No emoji as icons.

Core glyph set (42): overview-grid, projects-folder, agent-hex, research-flask, code-brackets,
design-pen, workflow-nodes, schedule-clock, knowledge-book, creative-spark, reports-doc,
integrations-plug, security-shield, marketplace-bag, approvals-check-badge, search, command,
bell, chevron-down/right/left, arrow-right, plus, close, filter, sort-asc/desc, more-horizontal,
more-vertical, copy, external-link, refresh, pause, play, stop, retry, warning-triangle,
info-circle, check, x, lock, key, git-branch, terminal, diff, download, expand, collapse, pin.

---

## 10. Interaction states

Every interactive element implements all eight. A component shipping five of them is not done.

| State | Treatment (light) | Notes |
|---|---|---|
| Default | Border `--iz-border-control`; text `--iz-ink-1`; bg `--iz-color-canvas` | Primary button: bg `--iz-color-chrome`, text `--iz-on-chrome-1` |
| Hover | bg `--iz-color-surface-2`; border unchanged | Never move the element; never change size. Cursor `pointer` only on actionable elements. |
| Active (pressed) | bg `--iz-color-surface-3`; primary button bg `#0B0F14` | 1px inset translate is prohibited (layout shift in dense rows) |
| Focus-visible | `outline: 2px solid var(--iz-focus); outline-offset: 2px;` | `:focus-visible` only. On chrome: `--iz-focus-on-chrome`. The ring is never removed, never clipped by `overflow:hidden` — parents of focusable children get `overflow: visible` or 4px padding. |
| Selected | bg `--iz-color-surface-3` + 2px `--iz-ink-1` inset left bar (tables) or `--iz-color-chrome-selected` (nav) | Selection also sets `aria-selected`/`aria-current`; never colour alone |
| Disabled | text `--iz-ink-disabled`, bg `--iz-color-surface-1`, border `--iz-border-subtle`, `cursor: not-allowed` | Must carry a reason: `title` plus helper text, or a lock glyph with an explanation. A disabled control with no stated reason is a defect. |
| Loading | label replaced by an 12px spinner + `aria-busy="true"`; width locked to the pre-loading width | Buttons only. Content areas use skeletons, never a centred spinner. |
| Invalid | border `--iz-status-failed-fg` (2px) + 16px alert glyph + message in `--iz-text-xs` | Message is programmatically associated (`aria-describedby`), placed below the field, and states the fix, not the fault. |

Hit targets: minimum 24×24px (WCAG 2.2 §2.5.8) for every pointer target including table row-action
icons; 32×32px for primary actions in toolbars; 44×44px minimum on touch layouts (≤1024px). Icon-only
targets in a table cell get an 8px negative-margin padding box to reach 24px without changing visual
row height.

---

## 11. Motion

Motion exists to explain a state change, never to decorate a page load. Durations are short because
the user is mid-task.

| Token | Value | Use |
|---|---|---|
| `--iz-dur-0` | `0ms` | Reduced motion |
| `--iz-dur-fast` | `90ms` | Hover, press, focus ring appear |
| `--iz-dur-base` | `140ms` | Disclosure, tab switch, chip add/remove |
| `--iz-dur-slow` | `200ms` | Drawer slide, toast enter/exit |
| `--iz-dur-enter` | `240ms` | Dialog enter, command palette open |

Easings: `--iz-ease-out: cubic-bezier(0.22, 1, 0.36, 1)` (default),
`--iz-ease-in-out: cubic-bezier(0.65, 0, 0.35, 1)` (drawer), `--iz-ease-linear: linear` (progress).

**Animates:** row expansion (opacity + 4px translateY), drawer (translateX), dialog (opacity +
scale 0.98→1), toast (opacity + 8px translateY), tab underline (transform), live-stream row insert
(one 600ms background flash from `--iz-status-active-bg` to transparent, then never again).

**Must not animate:** table row reordering (no FLIP on live data — rows must stay put while the
operator reads them), number count-ups, chart redraws on poll, page transitions between screens,
background gradients, spinners longer than 2s without a progress fallback, anything that moves a
control under the pointer.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
  /* Opacity-only crossfades may keep 80ms where the change would otherwise be invisible. */
  .iz-allow-fade { transition-duration: 80ms !important; }
}
```

---

## 12. Accessibility (WCAG 2.2 AA)

### 12.1 Contrast — measured

| Pair | Ratio | Requirement | Result |
|---|---|---|---|
| `--iz-ink-1` on canvas | 17.91 | 4.5 | pass |
| `--iz-ink-2` on canvas | 9.40 | 4.5 | pass |
| `--iz-ink-3` on canvas | 6.13 | 4.5 | pass |
| `--iz-ink-3` on `surface-1` | 5.80 | 4.5 | pass |
| `--iz-ink-1` on `surface-2` | 16.04 | 4.5 | pass |
| `--iz-on-chrome-1` on chrome | 16.78 | 4.5 | pass |
| `--iz-on-chrome-2` on chrome | 9.38 | 4.5 | pass |
| `--iz-on-chrome-3` on chrome | 5.63 | 4.5 | pass |
| Status fg / status bg (all 7) | 5.44–7.58 | 4.5 | pass |
| `--iz-border-control` on canvas | 3.36 | 3.0 (1.4.11) | pass |
| `--iz-border-control` on `surface-1` | 3.18 | 3.0 | pass |
| `--iz-focus` on canvas | 6.40 | 3.0 (1.4.11) | pass |
| `--iz-focus-on-chrome` on chrome | 6.81 | 3.0 | pass |
| Dark ink-1 / ink-2 / ink-3 on canvas | 16.59 / 9.98 / 6.98 | 4.5 | pass |
| Dark `--iz-border-control` | 4.01 | 3.0 | pass |

`--iz-ink-disabled` (3.11) is used only for disabled controls, which WCAG 1.4.3 exempts; disabled
state additionally carries a non-colour cue (lock glyph + stated reason).

### 12.2 Requirements

| Requirement | Specification |
|---|---|
| Target size (2.5.8) | ≥24×24px pointer targets, ≥8px spacing between adjacent targets. 44×44px on touch. |
| Focus visible (2.4.7 / 2.4.11) | 2px solid ring, 2px offset, never obscured by sticky headers: sticky regions reserve `scroll-margin-top: calc(var(--iz-topbar-h) + var(--iz-scopebar-h) + 8px)` on all focusable descendants. |
| Colour independence (1.4.1) | Status = glyph + label. Risk = segment count + label. Confidence = number + band word. Chart series = legend text. Diff = `+`/`−` markers in addition to tint. |
| Keyboard (2.1.1) | Every surface reachable and operable. No keyboard traps in dialogs, drawers, or the palette. Escape always closes the topmost layer and returns focus to the trigger. |
| Reflow (1.4.10) | At 320px width equivalent (400% zoom on 1280), content reflows to one column with no horizontal scrolling except inside a deliberately scrollable data table, which is labelled `role="region" tabindex="0" aria-label="Runs table, scrollable"`. |
| Text spacing (1.4.12) | Layout survives line-height 1.5×, letter-spacing 0.12em, word-spacing 0.16em, paragraph spacing 2em without clipping. |
| Dragging (2.5.7) | No drag-only interaction. Every drag (column reorder, resize) has a menu or keyboard equivalent. |
| Redundant entry (3.3.7) | Approval and rejection forms pre-fill operator identity and last-used reason category; never re-ask within a session. |
| Consistent help (3.2.6) | Help is always the last item in the account menu, same position on every screen. |
| Accessible auth (3.3.8) | SSO plus paste-friendly TOTP; no cognitive-test CAPTCHA. |
| Name, role, value (4.1.2) | Custom controls use native elements or complete ARIA. The segmented mode control is `role="radiogroup"` with `aria-checked`; the data table uses `<table>` with `<th scope>`; the timeline is an `<ol>`. |
| Status messages (4.1.3) | Toasts and live-stream updates announce through `aria-live="polite"`; P0 alerts through `role="alert"`. Announcements are rate-limited to one per 3s per region. |
| Reduced motion | §11 media query, plus every animated component documents its reduced variant. |
| Semantic structure | One `<h1>` per screen; panels are `<section aria-labelledby>`; nav is `<nav aria-label="Primary">`; the sidebar uses a nested `<ul>`; tables have captions. |

### 12.3 Screen-reader conventions

- Status pills read as `"Status: Running"`, not `"Running"` alone, via a visually hidden prefix.
- Durations read as `"14 minutes 22 seconds"` using `<span class="iz-sr-only">` expansion plus the
  visual short form marked `aria-hidden="true"`.
- Relative timestamps expose the absolute value: `<time datetime="2026-11-13T04:18:22Z"
  aria-label="13 November 2026 at 04:18 UTC">3m ago</time>`.
- Data tables announce sort state on the `<th aria-sort>`; expandable rows use
  `aria-expanded` on the row toggle and `aria-controls` pointing at the detail row.

---

## 13. Content rules for operational copy

| Surface | Rule | Example |
|---|---|---|
| Button labels | Verb + object. No "OK", "Submit", "Yes". | `Approve merge`, `Reject with reason`, `Retry run` |
| Destructive confirmation | Restates object, blast radius, and recovery, in that order | `Merge 7 files into reveilchat/backend? Affects 3 services. Revert: git revert + blue/green slot 2.` |
| Errors | What failed, on what object, why, and the next action. Never a bare code. | `Run failed at step 4 (test): 12 of 214 tests failing in services/auth. Retry from step 4 or roll back to build 8841.` |
| Empty states | State what would appear here, why it is empty, and the one action that changes it | `No runs in the last 24 hours. Runs appear once a workflow is triggered or scheduled. [Run a workflow]` |
| Degraded banners | Name the dependency, the impact, and the workaround | `Model router degraded: 3 of 5 providers responding. New runs are queued, not dropped. Approvals still function.` |
| Numbers | Always with a unit and a comparison where one exists | `$27.60 of $40.00 (69%)`, not `$27.60` |
| Simulated data | Labelled at the surface, not in a footnote | A persistent `Simulated` chip in the top bar and a `data-simulated` marker on any fixture-driven panel |

Banned words in product copy: elevate, seamless, unleash, delve, robust, powerful, cutting-edge,
revolutionise, next-generation.

---

## 14. Token reference

Copy-paste block for the token layer. This is the authoritative list; every name used in the
component inventory and screen specs resolves here.

```css
:root {
  /* colour — surfaces */
  --iz-color-canvas: #FFFFFF;
  --iz-color-surface-1: #F7F9FB;
  --iz-color-surface-2: #F1F3F5;
  --iz-color-surface-3: #E8EBEE;
  --iz-color-chrome: #151A20;
  --iz-color-chrome-raised: #20252B;
  --iz-color-chrome-hover: #1C222A;
  --iz-color-chrome-selected: #232930;

  /* colour — text */
  --iz-ink-1: #14171D;
  --iz-ink-2: #42474D;
  --iz-ink-3: #5E6268;
  --iz-ink-disabled: #8F9297;
  --iz-on-chrome-1: #F9FAFB;
  --iz-on-chrome-2: #BBBEC3;
  --iz-on-chrome-3: #8F9297;

  /* colour — borders + focus + seal */
  --iz-border-subtle: #E4E6EA;
  --iz-border-default: #D6D9DE;
  --iz-border-strong: #B4B8BD;
  --iz-border-control: #898C92;
  --iz-focus: #5D4DBE;
  --iz-focus-on-chrome: #9C96F8;
  --iz-seal: #C01B31;

  /* colour — status */
  --iz-status-active-fg: #0059A7;    --iz-status-active-bg: #E8F3FF;
  --iz-status-queued-fg: #4A4D52;    --iz-status-queued-bg: #F1F2F4;
  --iz-status-completed-fg: #006731; --iz-status-completed-bg: #E4F8E8;
  --iz-status-failed-fg: #B71824;    --iz-status-failed-bg: #FFEDEB;
  --iz-status-awaiting-fg: #8A5700;  --iz-status-awaiting-bg: #FEF0D4;
  --iz-status-degraded-fg: #A14206;  --iz-status-degraded-bg: #FFECE2;
  --iz-status-offline-fg: #4B4D50;   --iz-status-offline-bg: #EEEEF0;

  /* colour — risk + viz */
  --iz-risk-low: #5E6268;
  --iz-risk-medium: #8A5700;
  --iz-risk-high: #A14206;
  --iz-risk-critical: #B71824;
  --iz-viz-1: #2A61B1; --iz-viz-2: #007C84; --iz-viz-3: #946900;
  --iz-viz-4: #93398E; --iz-viz-5: #1F6F3D; --iz-viz-6: #6A727E;

  /* type */
  --iz-font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --iz-font-mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace;
  --iz-text-micro: 11px;   --iz-leading-micro: 14px;
  --iz-text-xs: 12px;      --iz-leading-xs: 16px;
  --iz-text-sm: 13px;      --iz-leading-sm: 18px;
  --iz-text-base: 14px;    --iz-leading-base: 20px;
  --iz-text-md: 16px;      --iz-leading-md: 22px;
  --iz-text-lg: 18px;      --iz-leading-lg: 24px;
  --iz-text-xl: 22px;      --iz-leading-xl: 28px;
  --iz-text-2xl: 28px;     --iz-leading-2xl: 32px;
  --iz-text-mono-sm: 12px; --iz-leading-mono-sm: 16px;
  --iz-text-mono-xs: 11px; --iz-leading-mono-xs: 14px;
  --iz-weight-regular: 400;
  --iz-weight-medium: 500;
  --iz-weight-semibold: 600;
  --iz-tracking-micro: 0.04em;
  --iz-tracking-tight: -0.012em;
  --iz-tracking-tighter: -0.016em;

  /* space */
  --iz-space-0: 0;    --iz-space-2: 2px;   --iz-space-4: 4px;   --iz-space-6: 6px;
  --iz-space-8: 8px;  --iz-space-10: 10px; --iz-space-12: 12px; --iz-space-16: 16px;
  --iz-space-20: 20px; --iz-space-24: 24px; --iz-space-32: 32px; --iz-space-40: 40px;
  --iz-space-48: 48px; --iz-space-64: 64px; --iz-space-80: 80px;

  /* sizing */
  --iz-control-sm: 24px; --iz-control-md: 28px; --iz-control-lg: 32px; --iz-control-xl: 36px;
  --iz-row-compact: 28px; --iz-row-default: 32px; --iz-row-comfortable: 40px;
  --iz-row-header-h: 32px;
  --iz-sidebar-w: 264px; --iz-sidebar-rail-w: 64px;
  --iz-topbar-h: 56px; --iz-scopebar-h: 40px;
  --iz-trace-rail-w: 400px; --iz-queue-pane-w: 360px; --iz-activity-rail-w: 360px;
  --iz-max-content: 1760px;

  /* radius + shadow */
  --iz-radius-xs: 2px; --iz-radius-sm: 4px; --iz-radius-md: 6px; --iz-radius-lg: 8px;
  --iz-radius-full: 999px;
  --iz-shadow-popover: 0 1px 2px rgb(16 18 23 / 0.06), 0 6px 16px -4px rgb(16 18 23 / 0.14);
  --iz-shadow-drawer: -8px 0 24px -8px rgb(16 18 23 / 0.18);
  --iz-shadow-modal: 0 2px 4px rgb(16 18 23 / 0.06), 0 20px 40px -12px rgb(16 18 23 / 0.22);
  --iz-shadow-toast: 0 1px 2px rgb(16 18 23 / 0.10), 0 10px 24px -6px rgb(16 18 23 / 0.20);

  /* motion */
  --iz-dur-0: 0ms; --iz-dur-fast: 90ms; --iz-dur-base: 140ms;
  --iz-dur-slow: 200ms; --iz-dur-enter: 240ms;
  --iz-ease-out: cubic-bezier(0.22, 1, 0.36, 1);
  --iz-ease-in-out: cubic-bezier(0.65, 0, 0.35, 1);
  --iz-ease-linear: linear;

  /* z */
  --iz-z-base: 0; --iz-z-sticky: 10; --iz-z-chrome: 20; --iz-z-dropdown: 100;
  --iz-z-drawer: 200; --iz-z-scrim: 290; --iz-z-modal: 300; --iz-z-palette: 320;
  --iz-z-toast: 400; --iz-z-tooltip: 500;

  /* breakpoints (documentation tokens; use literal px in media queries) */
  --iz-bp-sm: 640px; --iz-bp-md: 768px; --iz-bp-lg: 1024px;
  --iz-bp-xl: 1280px; --iz-bp-2xl: 1440px; --iz-bp-3xl: 1680px;
}

:root[data-theme="dark"] {
  --iz-color-canvas: #101316;
  --iz-color-surface-1: #171A1E;
  --iz-color-surface-2: #1E2125;
  --iz-color-surface-3: #24282D;
  --iz-color-chrome: #0A0C0F;
  --iz-color-chrome-raised: #14171B;
  --iz-color-chrome-hover: #121519;
  --iz-color-chrome-selected: #1B1F24;
  --iz-ink-1: #F0F2F4;
  --iz-ink-2: #B8BBBE;
  --iz-ink-3: #96989D;
  --iz-ink-disabled: #6C6F74;
  --iz-on-chrome-1: #F0F2F4;
  --iz-on-chrome-2: #B8BBBE;
  --iz-on-chrome-3: #8A8D93;
  --iz-border-subtle: #23272C;
  --iz-border-default: #2B2E33;
  --iz-border-strong: #3A3E44;
  --iz-border-control: #70757C;
  --iz-focus: #9C96F8;
  --iz-focus-on-chrome: #B6B3FF;
  --iz-status-active-fg: #7ABDFF;    --iz-status-active-bg: color-mix(in oklab, #7ABDFF 16%, #101316);
  --iz-status-queued-fg: #A8ACB2;    --iz-status-queued-bg: color-mix(in oklab, #A8ACB2 14%, #101316);
  --iz-status-completed-fg: #7FCC94; --iz-status-completed-bg: color-mix(in oklab, #7FCC94 16%, #101316);
  --iz-status-failed-fg: #FB817A;    --iz-status-failed-bg: color-mix(in oklab, #FB817A 16%, #101316);
  --iz-status-awaiting-fg: #E8BE62;  --iz-status-awaiting-bg: color-mix(in oklab, #E8BE62 16%, #101316);
  --iz-status-degraded-fg: #FC9B6F;  --iz-status-degraded-bg: color-mix(in oklab, #FC9B6F 16%, #101316);
  --iz-status-offline-fg: #8A8D93;   --iz-status-offline-bg: color-mix(in oklab, #8A8D93 14%, #101316);
  --iz-risk-low: #96989D;
  --iz-risk-medium: #E8BE62;
  --iz-risk-high: #FC9B6F;
  --iz-risk-critical: #FB817A;
  --iz-viz-1: #6FA3F0; --iz-viz-2: #4FC3CB; --iz-viz-3: #D9AE5A;
  --iz-viz-4: #D08BCB; --iz-viz-5: #6FC08A; --iz-viz-6: #9AA1AB;
  --iz-shadow-popover: 0 1px 2px rgb(0 0 0 / 0.4), 0 6px 16px -4px rgb(0 0 0 / 0.5);
  --iz-shadow-drawer: -8px 0 24px -8px rgb(0 0 0 / 0.55);
  --iz-shadow-modal: 0 2px 4px rgb(0 0 0 / 0.4), 0 20px 40px -12px rgb(0 0 0 / 0.6);
  --iz-shadow-toast: 0 1px 2px rgb(0 0 0 / 0.5), 0 10px 24px -6px rgb(0 0 0 / 0.55);
}
```

---

## 15. Anti-patterns — rejected on sight

| Pattern | Why it is rejected here |
|---|---|
| Card grids as the primary layout | Hides comparability. A run is a row; 18 of them must be scannable in one pass. |
| Stat-card hero row with gradient numbers | Vanity-metric decoration. Posture metrics are one strip, ink-on-white, no gradients. |
| Colour-only status dots | Violates principle 2 and 1.4.1. |
| Icon-only buttons without `aria-label` and tooltip | Violates 4.1.2 and the brief's explicit anti-goal. |
| Animated number tickers | Numbers changing under the operator's eye destroy trust in the figure. |
| Side-stripe coloured card borders | Decorative. Use a full tint, a rule above the region, or nothing. |
| Dark mode as default | Light canvas is the document. Dark is the on-call override. |
| Soft 16px+ blur shadows on static panels | Impersonates elevation that has no behavioural meaning. |
| Toasts for anything that matters | Toasts are transient. Failures, approvals, and policy violations belong in the ledger and the notification centre. |
| Modals for routine editing | Use a drawer (keeps context) or inline edit. Dialogs are reserved for confirmation of destructive or irreversible acts, and for the command palette. |
| Uppercase eyebrow labels above sections | Landing-page grammar. The only uppercase in this product is table column headers. |
