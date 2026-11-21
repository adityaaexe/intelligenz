# INTELLIGENZ — Open-Source Readiness Scorecard

**Date:** 2026-11-21  
**Branch/HEAD at audit:** `phase-6/trust-boundary-closure` @ `64df54c80019ef6e8d4b4bb7e599d4c033fbea99` (local, rewritten history; remote push pending)  
**Method:** Evidence-backed status only. File existence alone is insufficient. "VERIFIED" requires command/output or observed artifact from the current cycle.

## Score (evidence-backed)

- **P0 VERIFIED:** 0 / 6
- **P1 VERIFIED:** 0 / 4
- **Total VERIFIED:** 0 / 10 (0%)

> This is a baseline scorecard. It is intentionally strict. Existing implementation maturity is documented in `BASELINE_AUDIT.md`.

## Requirement tracker

| # | Requirement | Priority | Status | Evidence | Owner | Last verification | Outstanding work |
|---:|---|---:|---|---|---|---|---|
| 1 | Dedicated public GitHub repository | P0 | IN_PROGRESS | GitHub repo `adityaaexe/intelligenz` exists/public (API 2026-11-21), renamed from run-journal; local `origin` configured; remote has legacy `main` only; current branch not pushed due GH push protection (GH013) on historical fake secret fixtures. | repo owner / release engineer | 2026-11-21 | Remediate push-protection blockers, push current branch, confirm default branch/repo contents reflect INTELLIGENZ, no secret exposure. |
| 2 | Complete README and architecture documentation | P0 | IN_PROGRESS | `README.md`, `docs/PROJECT-WALKTHROUGH.md`, many `docs/engineering/*`, `docs/design/*`, ADRs present. Missing required named deliverables/accuracy pass: `docs/architecture/OVERVIEW.md`, `AGENT_EXECUTION.md`, `RUNTIME_ADAPTERS.md`, `GOVERNANCE.md`; README has stale/publication-state drift. | docs + lead engineer | 2026-11-21 | Create/align required architecture docs to actual implementation; update README for current state, limitations, and setup proof. |
| 3 | Explicit open-source license | P0 | BLOCKED | GitHub API reports MIT license metadata, but **no LICENSE file is tracked in repo**. Dependency/ownership/license authority not fully reviewed. | repo owner/legal | 2026-11-21 | Add canonical LICENSE file, verify authority to license all included code/assets, record dependency license review. |
| 4 | Runnable agent execution workflow | P0 | IN_PROGRESS | Core workflow components exist: API task/approval routes, Temporal worker/workflows/activities, agent runtime package (simulated + opencode-cli adapter), workspace manager, egress broker, audit/evidence paths. Historical phase docs report end-to-end proofs. | platform/runtime engineers | 2026-11-21 (historical evidence only) | Re-run and document a reproducible end-to-end task execution+verification demo in current tree; resolve open blockers (P87-011, P88-001 etc.) where relevant. |
| 5 | One real coding-agent runtime end-to-end | P0 | IN_PROGRESS | `packages/agent-runtime/src/runtimes/opencode-cli.ts`, broker credential isolation, workspace sandbox, proof scripts (`p3-real-run.ts`, `p4-broker-proof.ts`), Phase 3/4 docs report narrow verified path. | runtime engineer | 2026-11-21 (historical evidence only) | Provide reproducible, credentialed, policy-compliant real-runtime demo or clearly mark experimental/blocked with exact prerequisites; ensure independent verification evidence is current. |
| 6 | Automated tests and GitHub Actions CI | P0 | IN_PROGRESS | Vitest/Playwright configs and many tests exist; `infra/scripts/verify.sh`; `.github/workflows/ci.yml` exists but limited (no DB/Temporal/E2E, never observed remotely). | QA/DevOps | 2026-11-21 | Rerun local gates, fix CI to be credible for declared scope, observe remote CI run on GitHub after push. |
| 7 | CONTRIBUTING.md and SECURITY.md | P1 | NOT_STARTED | No root `CONTRIBUTING.md`; no root `SECURITY.md` (only `docs/engineering/SECURITY-RESULTS.md`). | maintainer | 2026-11-21 | Add root contribution guide and responsible disclosure/security policy aligned with actual project. |
| 8 | Issue and pull-request templates | P1 | NOT_STARTED | `.github/ISSUE_TEMPLATE/` and PR template absent. | maintainer | 2026-11-21 | Add bug/feature/security-question templates and PR template. |
| 9 | Initial versioned release and changelog | P1 | NOT_STARTED | No CHANGELOG, no product release tags, packages `0.0.0 private`; deployment NO-GO. | release manager | 2026-11-21 | Establish semver policy, changelog, alpha release criteria; only tag/release after P0 gates and security/publication review pass. |
| 10 | Benchmarks and known limitations | P1 | IN_PROGRESS | Evaluation package and benchmark fixtures exist; known limitations/deployment readiness docs exist; missing `docs/benchmarks/README.md` and current reproducible benchmark report. | evaluation engineer | 2026-11-21 | Publish honest benchmark doc with environment/commands/results or pending status; consolidate known limitations and non-claims. |

## P0 blocker summary

1. **GH013 push protection blocks publishing current branch** — historical fake Stripe/GitLab-shaped fixtures still present in tree/history as currently rewritten; must be replaced with non-detectable inert placeholders while preserving intent.
2. **Canonical LICENSE missing in repo** — GitHub metadata is not enough.
3. **CI is not a credible remote-verified gate** — workflow incomplete vs actual stack.
4. **Current verification not rerun** — cannot mark runtime/tests/build complete from historical reports alone.
5. **Security/governance production blockers remain** — deployment NO-GO, host privilege/identity split blocked, P87-009/P87-011/P88-* unresolved.

## Evidence references

- `docs/readiness/BASELINE_AUDIT.md`
- `docs/readiness/IMPLEMENTATION_PLAN.md`
- `docs/readiness/SECURITY_REVIEW.md`
- `docs/engineering/programme/EXECUTION-STATE.json`
- `docs/engineering/DEPLOYMENT-READINESS.md`
- `docs/engineering/PHASE-4-TEST-RESULTS.md`
- `docs/engineering/PHASE-4-SECURITY-RESULTS.md`
- `docs/engineering/phase8.9-operator-preview/PHASE89-REPORT.md`
- `.github/workflows/ci.yml`
