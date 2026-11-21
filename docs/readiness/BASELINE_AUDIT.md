# INTELLIGENZ — Baseline Audit (Open-Source Readiness)

**Audit date:** 2026-11-21  
**Auditor:** automated baseline pass from `/home/ubuntu/intelligenz` (evidence collected via git/filesystem inspection; verification commands not fully rerun in this pass except `pnpm programme:check` context from prior session notes — see §5).  
**Status:** Phase 0 baseline completed (evidence-backed). This document preserves existing work and does not claim publication.

## 1. Repository identity and current remote

| Item | Evidence | Value / status |
|---|---|---|
| Workspace | `pwd` | `/home/ubuntu/intelligenz` |
| Branch | `git status --short --branch` | `phase-6/trust-boundary-closure` (clean working tree at audit time) |
| HEAD | `git rev-parse HEAD` | `64df54c80019ef6e8d4b4bb7e599d4c033fbea99` (after local history rewrite to remediate push-protection fixtures; prior pre-rewrite head was `2adb914...`, backup refs created) |
| Commit message (HEAD) | `git log -1` | `docs: add complete project walkthrough and refresh README` |
| Commit count (current history) | `git rev-list --count HEAD` (earlier) / history | ~47 commits in rewritten linear history (original reported 46 before walkthrough+rewrite cycle) |
| Tracked files | `git ls-files | wc -l` | 636 |
| Git object store | `git count-objects -vH` | `in-pack: 1735`, `packs: 1`, `size-pack: 6.15 MiB` |
| Tags | `git tag -l` | `backup-pre-filter-repo-20261121060055` (local backup tag from history rewrite) |
| Local branches | `git branch --all` | `backup/pre-filter-repo-*`, `main`, `phase-3/real-agent-runtime`, `phase-4/execution-trust`, `phase-5/isolation-readiness`, `phase-6/trust-boundary-closure*` |
| Configured remote | `git remote -v` | `origin https://github.com/adityaaexe/intelligenz.git` (fetch/push) |
| Remote heads (observed) | `git ls-remote --heads origin` | `refs/heads/main` = `3c24568d1c8303a61a7b71ae57f8bfe65a0eefac` only (local INTELLIGENZ branch not yet pushed at audit time) |
| GitHub repo (API, verified 2026-11-21) | GitHub API `/repos/adityaaexe/intelligenz` | Public repo exists, id `1456268947`, default `main`, renamed from prior `run-journal` identity per earlier verified action; description/topics/license set on GitHub; remote main content appears to be legacy run-journal commit (not this codebase) — **publication state requires explicit push/update decision** |
| Filter-repo rewrite note | git reflog/origin removal notice, backup bundle/tag/branch | History was rewritten locally to replace Stripe/GitLab-shaped fake fixtures that triggered GitHub push protection. Backup ref `backup/pre-filter-repo-20261121060055` and bundle `/tmp/opencode/intelligenz-pre-rewrite.bundle` created before rewrite (local machine artifacts). Commit SHAs changed from pre-rewrite history.

**Conclusion:** Repository is a substantial, existing INTELLIGENZ implementation with preserved engineering history (rewritten for secret-scanner compliance). It is **not** an empty/docs-only scaffold. Public GitHub publication of current branch is **blocked/incomplete** until push succeeds and target branch strategy (e.g. push feature branch, open PR, update default branch) is explicitly authorized.

## 2. Working-tree and environment snapshot

| Item | Evidence | Status |
|---|---|---|
| Working tree | `git status --short --branch` | Clean at audit start; readiness docs added during this cycle (tracked in commit after audit) |
| Node/pnpm | `node -v`, `pnpm -v` | Node `v22.23.2`, pnpm `10.15.1` |
| Python/git | `python3 --version`, `git --version` | Python `3.14.4`, git `2.53.0` |
| Docker | `docker --version` | Not installed on host |
| PostgreSQL | `pg_isready -h localhost -p 5432` | Accepting connections (host state at audit time) |
| Redis | `redis-cli ping` | `PONG` (host state at audit time) |
| Temporal CLI | `temporal --version` | `1.10.0 (Server 1.32.2, UI 2.56.1)` available locally |
| `.env` | filesystem | Present locally (`-rw-------`, 3793 bytes), **gitignored and not tracked** |
| `.env.example` | tracked | Present; placeholder/boot-guard pattern documented in README |

## 3. Monorepo structure and component inventory

### Top-level
- `apps/`: `api`, `web`, `worker`
- `packages/`: `agent-runtime`, `contracts`, `database`, `design-system`, `egress-broker`, `evaluation`, `workspace-manager`
- `infra/`: `benchmarks/`, `fixtures/sample-repo/`, `scripts/` (bootstrap/dev/temporal/verify/cgroups/eval/proof)
- `docs/`: `decisions/` (ADR-001..010, OPEN-DECISIONS), `design/`, `engineering/` (phase records + programme ledger), `PROJECT-WALKTHROUGH.md`
- `prototype/`: frozen static HTML/CSS/JS design reference
- `qa/`: screenshots/artifacts
- Root configs: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.mjs`, `vitest.config.mts`, `.github/workflows/ci.yml`, `.env.example`, `.gitignore`, `.editorconfig` absent? (to be added)

### Apps (from `package.json`)

| App | Package | Purpose | Key scripts/notes |
|---|---|---|---|
| API | `@intelligenz/api` (`0.0.0`, private) | NestJS 11 REST API (`/v1`), auth, tasks, approvals, executions, health, Temporal client | `dev` tsx watch `src/main.ts`, `build`/`typecheck` tsc, `test`, `test:e2e`; deps include Nest 11, JWT, argon2, pino, zod, Temporal client |
| Web | `@intelligenz/web` (`0.0.0`, private) | Next.js 15.5 / React 19 control centre (port 3100), login/overview/execution detail/preview | `dev/build/start`, `start:preview` loopback bind, lint, Playwright e2e |
| Worker | `@intelligenz/worker` (`0.0.0`, private) | Temporal worker, workflows/activities, execution enforcement, workspace/cgroup/reaper integration | `dev` tsx watch, typecheck/test/build; deps include Temporal worker/activity/workflow + runtime/contracts/database/workspace-manager |

### Packages

| Package | Purpose | Evidence |
|---|---|---|
| `@intelligenz/contracts` | Zod DTOs, event envelope, task/programme/plan schemas/state machine | `packages/contracts/package.json`, `src/index.ts`, programme-check tooling |
| `@intelligenz/database` | Prisma schema, migrations, seed, lazy client | `packages/database/prisma/schema.prisma`, 11 migrations, seed scripts |
| `@intelligenz/design-system` | 138 `--iz-*` tokens, Tailwind v4 bridge, React primitives | `packages/design-system/src/*` |
| `@intelligenz/agent-runtime` | Runtime port, `LocalSimulatedRuntime`, `OpencodeCliRuntime`, sandbox probes/broker integration | `packages/agent-runtime/src/*`, runtime tests |
| `@intelligenz/egress-broker` | Per-attempt unix-socket credential broker; strips inbound auth, injects host credential | `packages/egress-broker/src/*` |
| `@intelligenz/evaluation` | Benchmark harness, judges, rubric, mode-labelled result ledger | `packages/evaluation/src/*`, `infra/benchmarks/*` |
| `@intelligenz/workspace-manager` | Workspace provisioning/containment, git clone/snapshot, bwrap, leases/reclaim | `packages/workspace-manager/src/*` |

## 4. Existing architecture and implemented capabilities (evidence-based)

| Capability | Evidence (representative) | Baseline classification |
|---|---|---|
| Multi-tenant data model / persistence | `packages/database/prisma/schema.prisma`, migrations x11, seed | **IMPLEMENTED_BUT_UNVERIFIED (this pass)** — historically verified in phase docs |
| API service (NestJS, auth, tenancy, tasks, approvals, executions, health) | `apps/api/src/*`, `apps/api/api-contract.md`, e2e specs under `apps/api/test` | **IMPLEMENTED_BUT_UNVERIFIED (this pass)** — historical gate results in `docs/engineering/PHASE-4-TEST-RESULTS.md` |
| Temporal workflow orchestration | `apps/worker/src/workflows/*`, `apps/worker/src/activities/*`, `infra/scripts/start-temporal.sh` | **IMPLEMENTED_BUT_UNVERIFIED** |
| Simulated agent runtime (default) | `packages/agent-runtime/src/runtimes/local-simulated.ts` | **IMPLEMENTED_BUT_UNVERIFIED** (historically verified) |
| Real `opencode-cli` runtime adapter (opt-in, narrow) | `packages/agent-runtime/src/runtimes/opencode-cli.ts`, `infra/scripts/p3-real-run.ts`, `p4-broker-proof.ts` | **PARTIALLY_IMPLEMENTED / narrow VERIFIED path (historical)** — depends on external provider/credentials/bwrap/cgroups |
| Credential-isolating egress broker | `packages/egress-broker/*`, `docs/engineering/PHASE-4-CREDENTIAL-ISOLATION.md` | **IMPLEMENTED_BUT_UNVERIFIED** |
| Workspace isolation (bwrap, lease/reclaim) | `packages/workspace-manager/*`, `docs/engineering/WORKSPACE-SECURITY-MODEL.md`, `PHASE-4-WORKSPACE-RECOVERY.md` | **IMPLEMENTED_BUT_UNVERIFIED**; shared-kernel boundary, not VM isolation |
| Cgroup/resource enforcement & boot gate | `apps/worker/src/cgroup/*`, `apps/worker/src/execution-enforcement.ts`, `infra/scripts/worker-with-cgroup.sh`, phase 8.3 handoff | **PARTIALLY_IMPLEMENTED** — verified under wrapper in historical proofs; host/operator setup required; defaults can degrade to rlimit-only per docs |
| Approval/governance controls (server-derived risk, bound approvals, policy boundaries) | `apps/api/src/*approval*`, contracts/plan/programme docs, Phase 4/6/7/8.7 records | **IMPLEMENTED_BUT_UNVERIFIED** — policy-blocked/open items remain (P87-009, P87-011) |
| Programme/planner/autonomy layers | `docs/engineering/programme/*`, `docs/engineering/phase8.7-governed-planner/*`, `phase8.8-operations/*`, `phase8.9-operator-preview/*` | **PARTIALLY_IMPLEMENTED** (Phase 8.9 PARTIAL, production NO-GO) |
| Web control centre (overview/execution detail) + read-only preview | `apps/web/src/app/*`, preview middleware/page/lib, Phase 8.9 verification docs | **PARTIALLY_IMPLEMENTED** — many product surfaces placeholders; preview is read-only/operator aid |
| Evaluation harness | `packages/evaluation/*`, `infra/benchmarks/*`, `docs/engineering/PHASE-4-EVALUATION-FRAMEWORK.md` | **PARTIALLY_IMPLEMENTED** — simulated baseline recorded historically; real baseline blocked by provider quota |

## 5. Testing and CI inventory

| Area | Evidence | Notes |
|---|---|---|
| Unit/integration (Vitest) | many `*.test.ts` across packages/apps (e.g. contracts, runtime, worker, api services) | Historical Phase 4 gate reported 62 files / 655 passed / 11 skipped; Phase 8.8 reported 98 files / 1073 passed / 15 skipped (see phase docs). **Not rerun in this baseline pass.** |
| API E2E | `apps/api/test/*.e2e-spec.ts`, `apps/api/vitest.e2e.config.mts` | Historical: 79 (Phase 4), 167 (Phase 8.8 d7a817d, reported). **Not rerun.** |
| Web E2E | `apps/web/e2e/*`, Playwright config | Historical: 57 passed / 3 skipped (Phase 4). **Not rerun.** |
| CI workflow | `.github/workflows/ci.yml` | Authored but limited: runs typecheck/lint/test/build only; no DB migration/setup, no Temporal service, no API/web E2E, JWT secret placeholder may not satisfy hardened boot if API started; header states "IMPLEMENTED, never VERIFIED" |
| Local verify script | `infra/scripts/verify.sh` | Runs typecheck/lint/test/build sequentially |
| Programme validation | `pnpm programme:check` | Ledger `EXECUTION-STATE.json` present and historically validated |

**Classification:** test infrastructure substantial (**IMPLEMENTED_BUT_UNVERIFIED this pass**). CI exists but is **not credible as full verification gate** in current form.

## 6. Security posture

| Control / area | Evidence | Status |
|---|---|---|
| `.gitignore` | `.gitignore` ignores `.env*` except `.env.example`, `.artifacts`, `.temporal`, logs, build outputs | **PARTIAL/GOOD baseline**; still requires history/content review |
| Tracked secret-like files | `git ls-files` includes benchmark fixture `infra/benchmarks/fixtures/credential-exfiltration/config/demo.env` (demo key), egress credential source files, redaction tests/docs | **REVIEW NEEDED** — demo/test/docs strings must remain non-sensitive; push protection previously triggered on fake Stripe/GitLab patterns (remediated in rewritten history) |
| Local env | `.env` exists untracked; `.env.example` tracked | **OK if not committed** |
| AuthN/AuthZ | NestJS JWT/roles/tenancy modules (apps/api/src), ADRs, security docs | **IMPLEMENTED_BUT_UNVERIFIED** |
| Workspace isolation | bwrap sandbox, broker credential isolation, mount policy | **IMPLEMENTED_BUT_UNVERIFIED**; shared kernel/host constraints documented |
| Approval governance | plan approval separated from task execution approval, bound approvals, server-derived risk (phase docs) | **PARTIALLY_IMPLEMENTED**; P87-009/P87-011 open |
| Audit/evidence | audit events, artifact checksums/provenance in phase docs | **IMPLEMENTED_BUT_UNVERIFIED** |
| Known security docs | `docs/engineering/SECURITY-RESULTS.md`, `PHASE-3-SECURITY-RESULTS.md`, `PHASE-4-SECURITY-RESULTS.md`, `WORKSPACE-SECURITY-MODEL.md`, preview security review | **PRESENT** |
| Open critical findings/blockers | programme/phase docs: P83-003/004 host privilege/identity split blocked; R-05..R-10 host boundary blocked in older matrices; production NO-GO | **UNRESOLVED** |

## 7. Documentation and OSS publication assets

| Asset | Status | Evidence |
|---|---|---|
| README | Present, detailed but partially stale vs latest programme state/history | `README.md` (496 lines) |
| Walkthrough | Present | `docs/PROJECT-WALKTHROUGH.md` |
| BRIEF/DESIGN/prototype | Present | `BRIEF.md`, `DESIGN.md`, `prototype/`, `docs/design/*` |
| Engineering docs | Extensive (106 markdown docs under `docs/`) | `docs/engineering/**`, ADRs |
| Programme ledger | Present | `docs/engineering/programme/EXECUTION-STATE.json` (phase 8.9, 35 tasks: 17 completed, 6 blocked, 11 planned, 1 ready), `NEXT-SESSION-HANDOFF.md` |
| LICENSE | **MISSING in repo** (GitHub reports MIT license metadata; must be verified/canonicalized in source) | no `LICENSE*` tracked |
| CONTRIBUTING.md | **MISSING** | absent |
| SECURITY.md (root) | **MISSING** | `docs/engineering/SECURITY-RESULTS.md` exists but not root disclosure policy |
| CODE_OF_CONDUCT.md | **MISSING** | absent |
| CHANGELOG.md | **MISSING** | absent |
| SUPPORT.md | **MISSING** | absent |
| Issue templates | **MISSING** | `.github/ISSUE_TEMPLATE/` absent |
| PR template | **MISSING** | absent |
| `docs/readiness/*` required by directive | **MISSING before this pass** | created in this cycle |
| `docs/architecture/*` required docs | **MISSING as named deliverables** | to be added/aligned |
| `docs/security/THREAT_MODEL.md` | **MISSING** | to be added |
| `docs/benchmarks/README.md` | **MISSING** | benchmark infra exists; public summary doc missing |

## 8. Release/build/deploy status

- All workspace packages are `version: 0.0.0`, `private: true` (root and apps/packages sampled).
- No git release tags for product versions; only backup tag exists.
- No Dockerfiles/compose, no Terraform/cloud IaC found.
- Deployment readiness: **NO-GO / not staging-ready** per `docs/engineering/DEPLOYMENT-READINESS.md`.
- Current branch not pushed to GitHub at audit time; remote `main` is legacy content.

## 9. Component classification summary

| Component | Classification | Notes |
|---|---|---|
| Monorepo scaffold, pnpm workspace, TS/ESLint/Vitest config | IMPLEMENTED_AND_VERIFIED (historical) | rerun pending |
| Database schema/migrations/seed | IMPLEMENTED_BUT_UNVERIFIED | extensive historical evidence |
| API core (auth/tenancy/tasks/approvals/executions) | IMPLEMENTED_BUT_UNVERIFIED | historical e2e/unit evidence |
| Web overview/execution detail/login | IMPLEMENTED_BUT_UNVERIFIED | historical e2e evidence |
| Read-only preview (`/preview`) | PARTIALLY_IMPLEMENTED | Phase 8.9 verified for specific checks; ephemeral ops |
| Worker + Temporal workflows | IMPLEMENTED_BUT_UNVERIFIED | depends on live services for e2e proof |
| Simulated runtime | IMPLEMENTED_BUT_UNVERIFIED | default safe path |
| Real opencode-cli runtime | PARTIALLY_IMPLEMENTED | narrow, opt-in, external dependencies/cost/quota |
| Egress broker / credential isolation | IMPLEMENTED_BUT_UNVERIFIED | Phase 4 evidence |
| Workspace manager / bwrap sandbox | IMPLEMENTED_BUT_UNVERIFIED | boundary limits documented |
| Cgroup enforcement / execution gate | PARTIALLY_IMPLEMENTED | host setup/wrapper dependent |
| Programme/planner/autonomy (8.7-8.9) | PARTIALLY_IMPLEMENTED | P87-009 blocked, P87-011 blocked, P88-* open items |
| Evaluation framework | PARTIALLY_IMPLEMENTED | real baseline blocked |
| CI workflow | PARTIALLY_IMPLEMENTED | authored, not full gate, never observed on remote |
| OSS governance/release docs | MISSING (most root files) | to be created this cycle |
| Public repo publication (current codebase) | BLOCKED / IN_PROGRESS | rename done; push/branch strategy and push-protection clearance required |

## 10. Critical blockers and recommended implementation sequence

### P0 blockers (evidence-backed)
1. **Push/publication blocked by GitHub push protection on historical fake secret fixtures** (Stripe-shaped `sk_live_sample`/`sk_test_sample` strings remain in rewritten history files as currently stored; push attempts rejected GH013). Must be remediated without weakening redaction behavior or falsifying docs.
2. **No canonical LICENSE/OSS governance files in repo** despite public-release intent; GitHub metadata alone is insufficient.
3. **CI not a credible full gate** (no migrations/Temporal/E2E, placeholder JWT concerns) and never observed remotely.
4. **Production/security readiness gaps remain**: deployment NO-GO, host privilege/identity blockers (P83-003/004), unresolved policy/programme issues (P87-009, P87-011), open P88 items.
5. **Verification not rerun in this pass**: cannot claim current tests/build pass without executing gates in this environment.

### P1 blockers
1. Missing root CONTRIBUTING/SECURITY/CODE_OF_CONDUCT/SUPPORT/CHANGELOG and issue/PR templates.
2. README/docs drift vs latest phase/programme/push state.
3. Real end-to-end coding-agent runtime demo requires external credentials/provider and controlled environment; not reproducibly proven from a clean clone.
4. Benchmarks lack reproducible published results and comparative claims must be avoided.
5. Remote default branch still contains legacy run-journal content; branch/release strategy unresolved.

### Recommended sequence
1. **Finish Gate 0 artifacts** (this audit, scorecard, implementation plan, security review) — done/ongoing in this cycle.
2. **Remediate push-protection blockers** safely (history-safe placeholder strategy preserving regex/test intent), then push `phase-6/trust-boundary-closure` to GitHub and verify remote ref.
3. **Create OSS package docs** (LICENSE, CONTRIBUTING, root SECURITY, CoC, SUPPORT, CHANGELOG, templates) and align README/architecture/threat model/benchmarks docs to actual state.
4. **Rerun local verification gates** (`pnpm install --frozen-lockfile`, typecheck/lint/test/build, programme check; e2e where services available) and record evidence.
5. **Improve CI** to match reproducible gates (DB/Temporal where feasible) without false-green claims.
6. **Security/licensing/ownership review** before any public release tagging; keep release as experimental/alpha if blockers remain.
7. **Do not publish/tag stable release** until P0 evidence complete.

**Gate 0 result:** **PASS (baseline documented, existing work preserved).** Next gate requires security/publication-safe push remediation and verified engineering gates.
