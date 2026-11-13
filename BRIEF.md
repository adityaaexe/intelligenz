# INTELLIGENZ — Design Brief v1.0

> Shared context artifact. Written by IT Leader. Read by @designer, then by implementers.
> Source: product definition + architecture blueprint supplied by the founder.

---

## 1. What INTELLIGENZ is

A persistent, self-directing **AI engineering and intelligence organisation**. You give it a business goal; it researches, understands the codebase, plans, executes through specialist agents, verifies its own work, documents, and reports.

**Product category:** autonomous AI engineering harness with an enterprise control plane.
**First vertical workspace:** ReveilChat. **Commercial model:** multi-tenant SaaS + private deployment.

**One intelligence layer. Multiple specialist brains. One autonomous engineering organisation.**

### The six layers (this is the mental model the UI must communicate)

| # | Layer | Responsibility |
|---|-------|----------------|
| 1 | Intelligence & Planning | Goal decomposition, self-questioning, research synthesis, architecture reasoning, independent review |
| 2 | Research Engine | Web, GitHub, papers, trends, competitors, documentation |
| 3 | Engineering Engine | Code intelligence, refactoring, UI audits, tests, security |
| 4 | Creative Engine | Design, Figma, brand, social assets, video |
| 5 | Memory & Learning | Project knowledge, decisions, evaluations, skills, model routing |
| 6 | Durable Execution & Governance | Temporal workflows, queues, schedules, permissions, sandboxes, audit logs, recovery |

### Operating modes (cool concept — surface it in the UI)

- **Autopilot** — executes previously approved, bounded tasks.
- **Copilot** — prepares work, requests approval before material change.
- **Manual** — operator controls all execution.

Every workflow must visibly declare: permission level, budget limit, allowed repositories, execution environment, rollback strategy.

---

## 2. The product surface being designed

The **INTELLIGENZ Control Centre** — a web application (desktop-first) where an operator runs the whole organisation:

Dashboard · Agent Console · Projects · Approvals · Schedules · Analytics · Reports

### Full navigation module set (13 — all appear in IA)

Overview · Projects · Agent Studio · Model Intelligence · Research Lab · Code Intelligence · Design Intelligence · Workflow Studio · Schedules · Knowledge Base · Creative Studio · Reports · Integrations · Security · Marketplace

Only the four screens listed in §3 are specified in full this cycle. The rest must be represented in the information architecture so the product reads as complete, not partial.

### Users

| Persona | Primary need |
|---------|-------------|
| Founder / operator | What is running, what needs me, what did it cost, what broke |
| Agency account owner | Per-client workspaces, delivery evidence, utilisation |
| Enterprise engineering lead | Audit trail, policy compliance, isolation proof, cost attribution |

---

## 3. Screens in scope — specify in full

### 3.1 Overview — real-time operations dashboard

System health · active workflows · agent activity · task queues · recent decisions · usage and cost · critical alerts.
This is the landing screen. It answers: *is the organisation healthy, what is it doing right now, what needs me?*

### 3.2 Agent Command Centre

Agent registry · assignments · execution status · live activity stream · task handoffs · logs · artifacts · model/runtime selection · failure recovery.
Runtime adapters are replaceable: Pi, OpenCode, Codex, Claude Code, OpenHands, custom. Model routing is a first-class concept (reasoning model vs fast engineering model vs independent verifier).

### 3.3 Approvals

Risk-ranked approval queue · action details · evidence · policy checks · diffs · cost impact · audit history · approve / reject / request-changes workflows.
This is the governance surface. Trust is earned here. Evidence and traceability outrank polish.

### 3.4 Research Lab

Research campaigns · source provenance · evidence collection · findings · confidence levels · comparisons · generated reports.
Non-negotiable: every finding shows its sources, publication dates, retrieval window, and known coverage gaps. Failed and stale sources must be disclosed.

---

## 4. Cross-cutting requirements

- **Application shell:** navigation, workspace/project selector, global search, command palette, notifications, user/account controls, contextual actions.
- **Reusable component inventory:** variants, interaction states, usage guidance.
- **Navigation & IA map:** complete module coverage.
- **States for every surface:** empty, loading, error, permission-denied, offline, degraded-system.
- **Operational states in data:** active, queued, completed, failed, awaiting approval, degraded, offline.
- **Responsive:** desktop-first, with tablet and mobile adaptations. Do not design a phone app that ignores the desktop.
- **Accessibility:** WCAG 2.2 AA target. Keyboard operable, focus visible, contrast verified, semantic HTML, no colour-only encoding of status.

### Explicit anti-goals

- Not a marketing landing page.
- Not a decorative dashboard of vanity metrics.
- No gradient-heavy "AI startup" aesthetic, no floating glass cards over stock imagery, no hero sections.
- No icon-only controls without accessible names.
- No status conveyed by colour alone.
- No fabricated realtime claims — simulated data must be labelled as simulated.

### Register

Professional, enterprise-grade, information-dense, calm under pressure. Prioritise hierarchy, scanability, traceability, operational clarity. A senior SRE and a founder should both be able to read it in five seconds.

---

## 5. Deliverables

All under `/home/ubuntu/intelligenz/`.

| # | Artifact | Path |
|---|----------|------|
| 1 | Design system | `DESIGN.md` |
| 2 | Screen specs (4) | `docs/design/screens/01-overview.md`, `02-agent-command-centre.md`, `03-approvals.md`, `04-research-lab.md` |
| 3 | Navigation & IA | `docs/design/INFORMATION-ARCHITECTURE.md` |
| 4 | Component inventory | `docs/design/COMPONENT-INVENTORY.md` |
| 5 | Prototype | `prototype/index.html` + `prototype/assets/**` |
| 6 | README | `README.md` |
| 7 | Review checklist + known limitations | `docs/design/REVIEW-CHECKLIST.md` |

### DESIGN.md must cover
Visual direction · design principles · colour tokens · typography · spacing · grid · surfaces/elevation · borders · shadows · iconography · responsive rules · accessibility · interaction states · motion.

### Screen specs must cover, per screen
Purpose and primary jobs · layout and regions with measurements · information hierarchy · every component used · data model shown (field-level, with realistic example values) · all states · interactions and keyboard paths · responsive adaptations · evidence/traceability treatment · accessibility notes.

---

## 6. Prototype technical constraints (these are traps — respect them exactly)

The prototype must open by double-clicking `index.html` from the filesystem.

| Constraint | Reason |
|-----------|--------|
| **No `type="module"` scripts** | `file://` blocks ES modules via CORS. Use classic `<script src>` only. |
| **No external network requests** | No CDN fonts, no icon libraries, no analytics. Offline must work. |
| **No build step, no npm install** | Plain HTML, CSS, vanilla JS. |
| **System font stack** | No webfont downloads. |
| **Inline SVG icons** | Hand-authored, consistent stroke set. |
| **Relative asset paths only** | `assets/css/…`, not absolute paths. |
| **No backend** | All data is a local JS fixture object. |

### Prototype must include
- Application shell + working navigation between the four screens.
- High-fidelity representation of each of the four screens.
- Realistic sample data (engineering-plausible, not Lorem ipsum).
- Working interactions: filters, tabs, search, dropdowns, expandable detail rows, approval dialogs, status indicators.
- Reusable CSS custom properties aligned 1:1 with DESIGN.md tokens.
- Responsive desktop / tablet / mobile layouts.
- Realistic operational states: active, queued, completed, failed, awaiting approval, degraded, offline.
- A visible, persistent way to tell simulated interactions from real backend functionality.

### Organisation for later migration
Structure CSS so it maps cleanly onto Next.js + TypeScript + Tailwind + shadcn/ui: token layer → primitive components → screen composition. Keep class names semantic. Do not write framework-specific hacks.

---

## 7. Definition of done

- [ ] Every deliverable file exists at the stated path.
- [ ] Tokens in DESIGN.md appear as CSS custom properties in the prototype with matching names.
- [ ] All four screens reachable in the prototype without console errors.
- [ ] Keyboard-only path exists to: navigate screens, open command palette, approve an item, filter a table.
- [ ] Contrast ratios stated and passing for text and UI boundaries.
- [ ] Status is never encoded by colour alone.
- [ ] Empty, loading, error, permission-denied, offline and degraded states are all demonstrated somewhere in the prototype.
- [ ] README explains preview, structure, and handoff to Next.js.
- [ ] Known limitations documented honestly — no overclaiming.
