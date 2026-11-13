# INTELLIGENZ — Phase 2 Baseline

> Written by @software-architect (AR-001), 2026-11-13.
> Purpose: state what exists **before** any Phase 2 code is written, so that later claims can be
> checked against a recorded starting point rather than against memory.
>
> Reporting vocabulary follows contract §13: `VERIFIED` (reproduced here, output quoted),
> `IMPLEMENTED` (exists, runtime verification incomplete), `PARTIAL`, `BLOCKED`, `NOT IMPLEMENTED`.
>
> Everything in §5 was produced by a command or an inspection in this session. Nothing in this
> document is carried over from a previous report without being labelled as such.

---

## 1. Existing artifacts

19 pre-existing text files, 9,638 lines, plus 10 QA screenshots. No source code outside `prototype/`.
(Counts cover the Phase 1 artifacts only; this unit's own four documents are not included.)

| Path | Lines | Purpose | State |
|---|---:|---|---|
| `BRIEF.md` | 170 | Product definition: six layers, personas, four screens in scope, prototype constraints, definition of done | complete (Phase 1 input) |
| `DESIGN.md` | 774 | Design system: register, colour, type, spacing, layout, borders, motion, accessibility, 138-token reference | complete (Phase 1a) |
| `README.md` | 235 | Preview instructions, directory map, handoff to Next.js and shadcn/ui, explicit simulation disclosure | complete (Phase 1b) |
| `docs/design/INFORMATION-ARCHITECTURE.md` | 436 | Scope model, 16 destinations, routes, object graph, search/palette/filter boundaries, notification taxonomy | complete (Phase 1a) |
| `docs/design/COMPONENT-INVENTORY.md` | 749 | 46 components with variants, states, anti-patterns | complete (Phase 1a) |
| `docs/design/REVIEW-CHECKLIST.md` | 282 | Review procedure, 20 known limitations, declared deviations, 10 open questions | complete (Phase 1b) |
| `docs/design/screens/01-overview.md` | 330 | Overview spec incl. field-level data model | complete (Phase 1a) |
| `docs/design/screens/02-agent-command-centre.md` | 304 | Agent CC spec | complete (Phase 1a) |
| `docs/design/screens/03-approvals.md` | 401 | Approvals spec | complete (Phase 1a) |
| `docs/design/screens/04-research-lab.md` | 363 | Research Lab spec | complete (Phase 1a) |
| `docs/engineering/PHASE-2-CONTRACT.md` | 257 | **Binding** Phase 2 engineering contract | complete |
| `prototype/index.html` | 173 | Shell, 49-symbol inline SVG sprite, mount points | complete (Phase 1b) |
| `prototype/assets/css/tokens.css` | 151 | 138 tokens, light + dark, byte-parity with `DESIGN.md` §14 | complete (Phase 1b) |
| `prototype/assets/css/base.css` | 190 | Reset, type, focus, a11y utilities | complete |
| `prototype/assets/css/components.css` | 1,218 | 138 distinct `.iz-*` component classes | complete |
| `prototype/assets/css/screens.css` | 380 | Per-screen composition, breakpoints | complete |
| `prototype/assets/js/data.js` | 827 | All fixtures. Nothing is fetched | complete |
| `prototype/assets/js/app.js` | 2,324 | Rendering, interactions, state inspector, placeholder modules | complete |
| `prototype/assets/js/router.js` | 74 | Hash router for `file://` | complete |
| `qa/*.png` | 10 files | Visual evidence: 1440 (4 screens), 1024 rail, 768 tablet, 390 mobile drawer + approvals | evidence only |

**`docs/engineering/` contains exactly one file** (the contract). This baseline, the ADR set, and the
implementation plan are the first engineering artifacts of Phase 2.

---

## 2. Repository state

**Measured:** `/home/ubuntu/intelligenz` is **not a git repository** (no `.git`). There is no
`package.json`, no `pnpm-workspace.yaml`, no `tsconfig.base.json`, no `node_modules`, no lockfile,
no `infra/`, no `.github/`, no `.env.example`, no `.gitignore`.

Intended state, per contract §3 — recorded here, **not executed by this unit**:

```
git init  →  initial commit (docs/design, prototype, DESIGN.md, BRIEF.md, README.md, contract)
pnpm-workspace.yaml + package.json + tsconfig.base.json
.gitignore: node_modules, .env, .temporal, .artifacts, dist, .next, coverage
.github/workflows/ci.yml
```

`@devops` is initialising the repository concurrently. **This baseline was written without running
`git`**, per the delegation constraint, so commit state, branch name, and remote existence are
**unknown at the time of writing** and must be read from `git status` before any Phase 2 unit
assumes a clean tree.

Two consequences of the current state:

1. There is **no version control safety net** for the prototype as this phase begins. Any accidental
   overwrite of `prototype/` or `docs/design/` is unrecoverable until the first commit exists.
2. There is **no dependency graph at all** — no manifest to audit, no lockfile to reproduce, no
   advisory surface. This is a property, not an oversight (§3).

---

## 3. Dependency inventory

**Claim under test:** the Phase 1 prototype has zero dependencies by design.

| Check | Command | Result |
|---|---|---|
| Package manifest | `ls package.json pnpm-lock.yaml package-lock.json` | all absent |
| Installed tree | `ls node_modules` | absent |
| External network references | `grep -rnE "https?://\|type=\"module\"\|cdn\." prototype/` | **no matches** |
| Module loading | `grep -rnE "import \|require\(" prototype/assets/js/` | **no matches** |
| Network APIs | `grep -rnE "fetch\(\|XMLHttpRequest\|WebSocket\|import\(" prototype/assets/js/` | **no matches** |
| Browser storage | `grep -rn "localStorage\|sessionStorage"` | 2 hits, both inside `try/catch`, used only for the first-run notice |
| JS syntax | `node --check` on all three files | **OK ×3** |
| Icon dependency | `grep -c '<symbol' prototype/index.html` | 49 inline symbols, no icon package |
| Font dependency | `grep` for `@font-face` | none; system font stack only |

**Verdict: `VERIFIED` — zero runtime, build, or network dependencies.** The prototype is plain
HTML/CSS/vanilla JS served from the filesystem.

Architectural reading: this is a deliberate constraint (BRIEF §6) and it produced an artifact with
**no supply-chain surface**. It also means Phase 2 starts with **no dependency baseline to
diff against** — the first `pnpm install` will introduce the entire third-party surface at once.
That install is the single largest unreviewed change in the phase.

---

## 4. Design-system implementation status

| Layer | State | Evidence |
|---|---|---|
| Token definitions | **`VERIFIED` complete** | 138 unique `--iz-*` names, 187 declarations (138 light + 49 dark overrides) |
| Token parity `DESIGN.md` §14 ↔ `tokens.css` | **`VERIFIED` identical** | Parsed both blocks: identical name sets, **0 value differences** |
| Token naming/values vs `README.md` "138 tokens" | **`VERIFIED` correct** | 138 unique names in both files |
| Distribution as a package | **`NOT IMPLEMENTED`** | No `packages/design-system`, no build, no export map |
| Tailwind integration | **`NOT IMPLEMENTED`** | No Tailwind config of any kind exists |
| Primitive components (contract §10 set) | **`PARTIAL`** — CSS only | All eight have a CSS counterpart; none is a typed component |
| Component library (typed, tested) | **`NOT IMPLEMENTED`** | No TypeScript, no props, no tests |
| Component inventory | **`VERIFIED` 46 components** specified | 46 `### Xn.` sections in `COMPONENT-INVENTORY.md` |
| Dark theme tokens | **`VERIFIED` present** | `:root[data-theme="dark"]`, 49 overriding declarations |
| Dark theme review | **`NOT VERIFIED`** | `REVIEW-CHECKLIST.md` §3.20: no screen visually reviewed in dark mode |

### Contract §10 primitive mapping (all present as CSS, none as code)

| Contract primitive | Prototype class | Note |
|---|---|---|
| `Button` | `.iz-btn` (+ `--primary`, `--secondary`, `--ghost`, `--danger`, sizes `sm/md`) | |
| `Badge` / `StatusPill` | `.iz-pill[data-state]`, `.iz-badge` | Status pill carries glyph + text label, per `DESIGN.md` §4.4 |
| `Table` | `.iz-table` | Sort, selection, expansion, sticky header |
| `MetricTile` | `.iz-metric` | |
| `Card` / `Panel` | `.iz-panel` | **`.iz-card` does not exist and must not be created.** `DESIGN.md` §8 rejects content cards ("rules, not cards"); the contract's parenthetical "(rules not shadows)" resolves the slash in favour of Panel |
| `EmptyState` | `.iz-empty` | |
| `Skeleton` | `.iz-sk` | Deliberately *not* `.iz-skeleton` |
| `Banner` | `.iz-banner` | |

**The gap between Phase 1 and Phase 2 is not design.** Tokens are complete, internally consistent,
and reproducible. The gap is that none of it is a package, a type, or a test. Porting is mechanical;
*keeping it 1:1* under Tailwind is where it will drift, which is why contract §10 forbids new colour
values and why the plan makes token parity a gate check rather than a code-review note.

---

## 5. Verified vs unverified claims carried forward from Phase 1 QA

Phase 1 ended with claims, not a test suite. This section separates what can be reproduced from the
repository from what cannot.

### 5.1 Re-verified in this session

| Claim (source) | Method | Result |
|---|---|---|
| 138 tokens, 1:1 with `tokens.css` (`README.md`, `DESIGN.md`) | Parsed both CSS blocks and diffed name→value maps | **`VERIFIED`** — 138/138, 0 differences |
| Contrast ratios "measured, not estimated" (`DESIGN.md` §4) | Recomputed WCAG 2.x relative-luminance ratios from the hex values for **16** critical pairs | **`VERIFIED`** — all 16 within ±0.05 of the published figure (e.g. `--iz-ink-3` 6.14 vs 6.13; `--iz-border-control` 3.37 vs 3.36; `--iz-status-failed-fg` on `-bg` 5.86 vs 5.86; `--iz-focus` 6.42 vs 6.40) |
| 11px type floor, 24px target floor (`REVIEW-CHECKLIST.md` §4.1 B7) | `grep` for 9px/10px declarations; spot-check rendered controls | **`PARTIAL`** — no `font-size` below 11px found in CSS; target sizes not re-measured in a browser |
| No network access, no modules, no build (`README.md` §9) | See §3 | **`VERIFIED`** |
| 16 navigation destinations; 4 screens built; 12 placeholders (`README.md` §10) | `MODULES` object has 16 keys; render switch handles `overview`, `agents`, `approvals`, `research`; `default → renderPlaceholder` | **`VERIFIED`** — 4 implemented, 12 placeholders |
| 46 components (`README.md` §1) | Counted `### Xn.` sections | **`VERIFIED`** |
| 49 inline SVG symbols (`README.md` §9) | Counted `<symbol` | **`VERIFIED`** |
| JS files are syntactically valid | `node --check` ×3 | **`VERIFIED`** |

### 5.2 Not reproducible from the repository — carried forward as claims only

| Claim | Why it cannot be checked here | Status |
|---|---|---|
| "Zero console errors, zero warnings" across four screens | Requires a browser session; no console capture is stored | **`NOT VERIFIED`** |
| axe-core results (0 `link-name` violations at 390 and 1024; `REVIEW-CHECKLIST.md` §4.1 B1) | No axe JSON, report, or log is committed. The `qa/` directory contains PNGs only | **`NOT VERIFIED`** — the claim is real work, but the evidence did not survive |
| "Keyboard-only path exists" to nav, palette, approval, filter | No recorded traversal, no test, no video | **`NOT VERIFIED`** |
| Responsive verified at 1440/1280/1100/1024/900/768/640/390 | Screenshots exist for **5** widths (1440, 1024, 768, 390, and one mobile drawer); no artifact for 1280, 1100, 900, 640 | **`PARTIAL`** |
| Focus never clipped; dialogs trap focus and restore it | Requires interactive inspection | **`NOT VERIFIED`** |
| 200% zoom reflow | Requires browser at zoom | **`NOT VERIFIED`** |
| Colour-blind (deuteranopia) distinguishability | Requires simulation tooling | **`NOT VERIFIED`** |
| Dark theme reviewed | `REVIEW-CHECKLIST.md` §3.20 states it was **not** reviewed | **`NOT IMPLEMENTED`** (honestly self-declared) |
| Screen-reader session (NVDA/JAWS/VoiceOver) | `REVIEW-CHECKLIST.md` §3.20 states none was performed | **`NOT IMPLEMENTED`** (honestly self-declared) |

**Consequence for Phase 2.** None of the unverified items is a Phase 2 deliverable, and none should be
re-asserted as fact. When the Overview is rebuilt in Next.js, the accessibility claims must be
**re-established against the new implementation**, not inherited from the prototype. A DOM that was
inspected once in Phase 1 is not evidence for a React tree written in Phase 2.

---

## 6. Available runtimes

Measured in this session. Contract §1 values in the right-hand column for comparison.

| Capability | Measured | Contract §1 | Delta |
|---|---|---|---|
| Node | **v22.23.2** (`/home/ubuntu/.nvm/.../bin/node`) | v22.23.2 | none |
| npm | **10.9.8** | 10.9.8 | none |
| pnpm | **present on PATH**; version **not re-measured** (delegation forbids running `pnpm`) | 10.15.1 | presence verified, version per contract |
| git | **2.53.0** binary present; **not executed** | 2.53.0 | version per contract |
| PostgreSQL | **18.6**, `pg_isready` → `accepting connections` on `127.0.0.1:5432`, `LISTEN` confirmed | 18.6, running | none |
| Redis | **8.0.5**, `redis-cli ping` → `PONG`, `LISTEN` on `127.0.0.1:6379` | 8.0.5, running | none |
| Docker | **`command not found`** | absent | none |
| `gh` CLI | **`command not found`** | absent | none |
| Temporal CLI | **`command not found`** | absent — must be installed | none |
| Network | not re-tested in this session | npm/GitHub reachable (HTTP 200) | **unverified here** |

### 6.1 Port availability — a delta the contract does not record

Contract §4 assigns **web 3000** and **api 4000**. Both are already bound:

```
LISTEN 0.0.0.0:3000  users:(("node /opt/reveil/repo/backend/api-server/index.js",pid=1223))
LISTEN 0.0.0.0:4000  users:(("node /opt/reveil/repo/backend/socket-server/index.js",pid=1228))
```

Both processes belong to a **different product** under `/opt/reveil/repo/backend`, and have been
running for 1 day 2 hours. They must not be stopped by this project.

**Consequence:** `apps/web` and `apps/api` cannot bind the contract's ports on this host. The
proposed resolution (ADR-010) is to offset to **3100 / 4100**, which requires Leader ratification
because it invalidates every contract-derived command, test base URL, and `.env.example` line.
Ports **7233** and **8233** (Temporal gRPC/UI) are free.

---

## 7. Missing infrastructure

### 7.1 Docker — absent

**Consequence.** No image can be built, so no container artifact can be verified. Compose files and
Dockerfiles may be *prepared* but must be labelled unbuilt and unverified (ADR-010). More
importantly, **there is no isolation boundary for agent execution**: `allowedPaths`, `allowedActions`,
and `shell: false` are declarations the runtime cannot enforce without a sandbox (ADR-006). Any demo
of "the agent ran code" is running that code as the same user that owns this repository.

Secondary consequence: no disposable PostgreSQL for tests. Integration tests must use the host
database with a distinct schema or database name, and must clean up after themselves.

### 7.2 `gh` CLI — absent

**Consequence.** No CLI repository creation, no `gh`-based secret configuration, no `gh run` output.
`.github/workflows/ci.yml` can be authored but never observed to run. CI status in every Phase 2
report must therefore be **`IMPLEMENTED`, never `VERIFIED`**, and quality gates are local command
output that the agent reports about itself (ADR-010).

### 7.3 Temporal CLI — absent, must be installed

**Consequence.** ADR-003 depends on `temporal server start-dev`. Until the binary is installed from
GitHub releases, the worker cannot connect, `runTaskWorkflow` cannot be started, and the vertical
slice terminates at task creation. This is the **first blocking dependency of gate D**, and it is an
install step, not a design step: `infra/scripts/dev-temporal.sh` must fail loudly with an actionable
message when the binary is missing, rather than a connection timeout.

The dev server's store is SQLite at `.temporal/dev.db` (gitignored). Deleting it deletes all workflow
history. There is no backup and no HA.

---

## 8. Security and operational risks of starting from a static prototype

The prototype is a **trusted, offline, single-user document**. Phase 2 turns it into a **networked,
multi-tenant, authenticated system**. Every risk below is a consequence of that transition, ordered
by severity.

| # | Risk | Why it exists here | Mitigation in Phase 2 |
|---|---|---|---|
| 1 | **Fixture data becomes believed data.** `data.js` contains plausible runs, costs, agents, and approvals. Once the API exists, a screen with a mix of real and fixture rows is indistinguishable from a working system. | The prototype's realism is its strength and its hazard. `README.md` §8 is explicit, but a UI does not inherit a README. | A persistent `Simulated` chip in the scope bar, plus a per-region source label. Contract §11: "Forbidden: fabricated live health." Gate E makes "does this region state its source?" an acceptance check. |
| 2 | **No auth exists, so every route is a design assumption.** The prototype's permission-denied state is a visual preview; nothing enforces it. | `REVIEW-CHECKLIST.md` §3.2. | ADR-005 + the `forTenant` query guard. The permission test is a *server* test, not a state-inspector screenshot. |
| 3 | **Tenant leakage via a forgotten predicate.** One missing `orgId` in one `where` clause is a cross-customer read, and the UI will render it without complaint. | New data layer, new query surface, no existing enforcement. | Denormalised `orgId`, Prisma extension that throws, insert-only/select-only DB grants for audit, explicit test case #2. |
| 4 | **XSS through artifact and model output.** The prototype renders trusted literals with `innerHTML` (e.g. `app.js` composes markup from fixtures). Carrying that pattern into React with API data turns every artifact into a script injection vector. | The prototype's string-composition style is a template for the migration. | React escapes by default; `dangerouslySetInnerHTML` is banned outright. Artifacts served as attachments with `nosniff`. Lint rule. |
| 5 | **Secrets in logs.** `pino` structured logs plus Temporal history plus activity inputs can capture a bearer token or a provider key in a stack trace. | New logging surface, contract test case #8. | `pino` `redact` paths for `authorization`, `password`, `token`, `secret`, `apiKey`, `cookie`; never log request bodies; a test that greps serialised output. |
| 6 | **Unbounded execution.** The simulated runtime is harmless; the first real one will not be. There is no timeout enforcement, no memory cap, no kill switch. | No sandbox (Docker absent). | `timeoutMs` + Temporal `startToCloseTimeout` + `AbortSignal`. Advisory only; stated as a limitation, not sold as a control. |
| 7 | **Service-worker/browser-cache staleness** from the `file://` era is not a risk, but its cousin is: Next.js RSC caching can serve a stale Overview that looks live. | App Router caching defaults are aggressive. | Explicit `cache: 'no-store'` (or tagged revalidation) on operational data; the "last updated" timestamp must come from the payload, not the render. |
| 8 | **Unversioned, unreviewed dependency introduction.** `pnpm install` adds ~800 transitive packages to a repository with no lockfile and no advisory scanning. | §3. | Commit the lockfile in the first commit that adds dependencies; `--frozen-lockfile` in CI; record the install as a reviewable diff. |
| 9 | **No backup.** Host Postgres, SQLite Temporal store, and the artifact directory have no backup and no restore procedure. | Local-only phase. | Stated as a limitation. `.artifacts` and `.temporal` are gitignored, so they are also not versioned. |
| 10 | **Port collision with another product's running services** (§6.1). A careless `kill` or a `lsof`-driven "fix" could take down an unrelated system. | Shared host. | Offset ports; never signal a PID outside this project; ADR-010 records the blocker. |

Operational risks worth naming separately:

- **Three processes, no supervisor.** If the worker dies, runs queue silently and the UI still says
  "queued". Nothing restarts it. `GET /v1/health/ready` is the only signal, and it only helps if the
  UI actually calls it and renders the failure.
- **The Temporal dev server is a single point of execution failure** with a SQLite file that no
  process supervises.
- **`pnpm -w dev` will be the entire deployment procedure.** That is acceptable for a phase with no
  users and unacceptable the moment there is one.

---

## 9. Known limitations that must remain visible

Carried from `REVIEW-CHECKLIST.md` §3 and the contract. These must not be quietly dropped as Phase 2
adds code; each is a statement the product is not yet entitled to contradict.

| # | Limitation | Phase 2 effect |
|---|---|---|
| 1 | **12 of 16 navigation destinations are placeholders** — they render a module header and "not part of this slice". | The web app must keep them as explicit placeholders. Do not remove the destinations (the IA is complete); do not fake their content. |
| 2 | **No backend, no persistence** in the prototype; every mutation is in memory. | Superseded by Phase 2 *for the Overview slice only*. Every other screen remains fixture-only. |
| 3 | **No auth or permissions**; "M. Okafor" is a fixture; permission-denied is a preview. | Phase 2 adds real auth for the slice. The other 15 destinations inherit no enforcement. |
| 4 | **Run detail screens are out of scope**; a run row expands in place. | Phase 2 adds `GET /orgs/:orgId/tasks/:taskId` (task detail incl. latest run + artifacts) but **not** a run detail screen. Do not imply one. |
| 5 | **Only one agent (`agt_eng_04`) has a full execution trace**; the other 11 show a labelled notice. | The API has one agent runtime. Agent CC remains fixture-only in Phase 2. |
| 6 | **Only one research campaign has a full evidence set.** | Research Lab remains fixture-only. |
| 7 | **Scope switching is simulated** — workspace/project/environment do not change data. | Phase 2 has no workspace or environment concept at all (ADR-005 open item). The selector must not pretend otherwise. |
| 8 | **Global search and palette search a local array**; no index. | No search endpoint exists in the contract. Search remains fixture-only and must say so. |
| 9 | **Diff viewer is simplified** (unified, no highlighting, no virtualisation). | No diff surface in Phase 2. |
| 10 | **No virtualised tables**; 8–12 rows per screen. | The Overview will render whatever the API returns. Without pagination limits, one large org breaks the page. `GET .../tasks` is paginated by contract — use it. |
| 11 | **Charts are static SVG.** | The Overview's cost/sparkline regions have **no data source** in the Phase 2 API. They must render an explicit "not instrumented" state, not a fabricated chart. |
| 12 | **Notifications are static**; the badge does not decrement. | No notification system in Phase 2. |
| 13 | **The activity stream does not append.** | The Overview's "agent activity" region has no live source. Label it. |
| 14 | **No i18n**; English, hard-coded, fixed date strings. | Unchanged. Dates must become locale-formatted only when i18n is in scope. |
| 15 | **Below 768px is read-and-decide**; authoring is desktop-width only. | Unchanged. |
| 16 | **First-run notice reappears** if `localStorage` is blocked on `file://`. | Irrelevant once served over HTTP; do not carry the workaround into Next.js. |
| 17 | **Dark theme implemented, only token-verified**; no screen visually reviewed in dark mode. | Unchanged. Do not claim dark-mode support. |
| 18 | **No screen-reader session** was performed. Accessibility conclusions come from DOM inspection and axe-core, not AT testing. | Unchanged. Re-verify against the Next.js build; do not inherit the claim. |
| 19 | **Axe results were not retained** as artifacts. | Phase 2 must store machine-readable accessibility output if it claims an audit. |
| 20 | **The prototype proves tokens, not a component library.** | The design-system package is new code with new tests. It starts at zero. |

---

## 10. What the baseline implies for Phase 2

1. **Nothing is being migrated; everything is being built.** The only reusable assets are tokens,
   CSS patterns, and product decisions. There is no application code to port, no test to keep green,
   no build to preserve.
2. **The contract's port table is unsatisfiable on this host** and needs ratification before gate C.
3. **Temporal CLI installation is the first hard blocker** for the vertical slice (gate D).
4. **The Overview cannot be fully populated by the contract's own API.** Eight required regions
   (contract §11) versus an API (§6) with no approvals, no agents, no models, and no cost data.
   Regions must render an honest absence state, and that is a design decision the Leader must
   ratify — not something an implementer should improvise.
5. **The verification vocabulary is the deliverable as much as the code.** Phase 1's most useful
   artifact was the honest limitations list. Phase 2 must not lose that discipline as velocity
   increases.

---

## 11. Verification status of this document

| Section | Status | Basis |
|---|---|---|
| §1 artifact inventory | `VERIFIED` | `find`, `wc -l` in this session |
| §2 repository state | `VERIFIED` | `ls -la`, `find` — no `.git`, no manifests |
| §3 dependency inventory | `VERIFIED` | Greps and `node --check` quoted above |
| §4 design-system status | `VERIFIED` (parity, counts) / `NOT IMPLEMENTED` (package) | Parsed diff of 138 tokens, 0 differences |
| §5.1 re-verified claims | `VERIFIED` | Contrast recomputation, token diff, route inspection |
| §5.2 unverified claims | `NOT VERIFIED` | No artifacts exist to check |
| §6 runtimes | `VERIFIED` | `--version`, `pg_isready`, `redis-cli ping`, `ss -ltnp` |
| §6.1 port conflict | `VERIFIED` | `ss -ltnp` + `/proc/<pid>/cwd` |
| §7 missing infrastructure | `VERIFIED` | `command -v` for each, `command not found` |
| §8 risks | analysis | Not a test result; each mitigation names the gate that must prove it |
| §9 limitations | carried | Source: `REVIEW-CHECKLIST.md` §3, contract §3/§11 |

**Not performed in this unit, by constraint:** no `git`, no `pnpm`, no build, no test run, no browser
session. Any statement that depends on those is marked `NOT VERIFIED` above rather than assumed.
