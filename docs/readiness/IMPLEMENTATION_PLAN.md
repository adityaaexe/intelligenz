# INTELLIGENZ — Open-Source Readiness Implementation Plan

**Date:** 2026-11-21  
**Baseline:** `docs/readiness/BASELINE_AUDIT.md`  
**Scorecard:** `docs/readiness/OPEN_SOURCE_READINESS.md`

## Guiding constraints

- Preserve existing implementation, migrations, history, and governance controls.
- Do not rewrite, do not fake verification, do not weaken tests, do not publish secrets.
- Stop before irreversible public publication/release if licensing/ownership/security authorization is unresolved.
- Treat historical gate results as **recorded evidence**, not current proof until rerun.

## Phase 0 — Baseline and repository forensics (COMPLETED)

**Deliverables:** `BASELINE_AUDIT.md`, `OPEN_SOURCE_READINESS.md`, `IMPLEMENTATION_PLAN.md`, `SECURITY_REVIEW.md` (draft).  
**Evidence:** git/filesystem/API inspection, existing phase docs, programme ledger.  
**Gate 0:** PASS (documented, no destructive changes).

## Phase 1 — Public GitHub repository (IN PROGRESS / BLOCKED)

### Immediate actions
1. **Remediate GH013 push protection blockers** (highest priority).
   - Replace remaining Stripe-shaped fake fixtures (`sk_live_sample...`, `sk_test_sample...`) in affected files/history with non-detectable, inert placeholders that still satisfy redaction tests/intent.
   - Re-run targeted redaction tests and grep checks; verify no flagged patterns remain.
   - Use minimal history rewrite only if required for push (backup refs/bundle exist); record old/new SHAs.
2. **Push current branch** `phase-6/trust-boundary-closure` to `origin` (or agreed branch) and verify remote ref.
3. **Resolve branch strategy**: keep legacy `main` untouched until explicit decision; prefer PR from pushed branch into a designated integration branch or new default branch after review.
4. **Publication safety**: confirm no `.env`, credentials, private ops config, dumps, or personal data tracked; re-run secret scan where available.

**Acceptance:** remote branch visible on GitHub, push protection clear, no secrets exposed, no force-push/reset performed.

## Phase 2 — Project identity and documentation (IN PROGRESS)

### Create/align required files
- Root: `LICENSE` (canonical, authority-verified), `CONTRIBUTING.md`, `SECURITY.md`, `CODE_OF_CONDUCT.md`, `CHANGELOG.md`, `SUPPORT.md`, `.editorconfig`.
- `.github/ISSUE_TEMPLATE/bug_report.yml`, `feature_request.yml`, `security_question.yml`, `PULL_REQUEST_TEMPLATE.md`.
- `docs/architecture/OVERVIEW.md`, `AGENT_EXECUTION.md`, `RUNTIME_ADAPTERS.md`, `GOVERNANCE.md`.
- `docs/security/THREAT_MODEL.md`.
- `docs/benchmarks/README.md`.
- Update `README.md` to reflect actual current state (branch/push state, historical vs current verification, known limitations, setup commands, runtime prerequisites).

**Acceptance:** documentation matches implementation; no fabricated metrics/screenshots/capabilities.

## Phase 3 — Core execution workflow verification (P0)

1. Identify canonical end-to-end path in current code (API task -> validation -> approval/policy -> Temporal workflow -> runtime -> artifacts/evidence -> independent verification).
2. Run reproducible demo in controlled local environment:
   - Simulated runtime path (always reproducible).
   - Real `opencode-cli` path only if credentials/provider/cgroup/bwrap prerequisites are satisfied and authorized; otherwise document exact blocker.
3. Capture evidence artifacts (commands, logs summary, task/run IDs, verification outputs) under `docs/readiness/evidence/` without secrets.

**Acceptance:** at least one fully reproducible verified execution path; real-runtime claim only if actually demonstrated.

## Phase 4 — Runtime adapter hardening (P0, scoped)

- Preserve existing `opencode-cli` adapter; fix only blocking defects discovered by tests/demo.
- Ensure runtime contract, secure credential handling, workspace isolation, timeout/cancellation, structured outputs, and independent verification are documented and tested.
- Do not add new providers unless trivial and non-blocking.

## Phase 5 — Governance, security, trust (P0/P1)

- Complete `docs/security/THREAT_MODEL.md` and root `SECURITY.md`.
- Review authz boundaries, credential handling, secret redaction, audit events, workspace/cgroup controls.
- Triage open findings: P83-003/004, P87-009, P87-011, P88-001/002/003, host-boundary residuals.
- Add/adjust tests only where necessary to prove fixes; do not weaken existing tests.

## Phase 6 — Testing and CI (P0)

1. **Local gate rerun (current HEAD):** `pnpm install --frozen-lockfile`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm programme:check` (and e2e suites if services available).
2. **CI improvements:** make workflow reflect real reproducible checks (services/migrations/Temporal as feasible), remove misleading placeholders or gate them safely, ensure skip reasons visible.
3. **Remote CI:** observe at least one GitHub Actions run on pushed branch/PR and record result.

## Phase 7 — Contributor experience (P1)

- CONTRIBUTING, templates, CODE_OF_CONDUCT, SUPPORT, local dev docs, PR/commit guidance aligned with existing conventions.

## Phase 8 — Release management (P1, conditional)

- Keep project as **experimental/alpha** until P0 and critical security blockers resolved.
- Add CHANGELOG with Added/Changed/Fixed/Security/Known limitations.
- Prepare v0.1.0-alpha (or agreed) release notes only after verified gates and authorized publication.

## Phase 9 — Benchmarks and technical evidence (P1)

- `docs/benchmarks/README.md` documenting existing harness, scenarios, how to run, current/pending results, limitations; no fabricated or comparative superiority claims.

## Phase 10 — Readiness scorecard update (continuous)

- Update `OPEN_SOURCE_READINESS.md` after each verified milestone with evidence links/commands and dates.

## Stop conditions (must halt and report)

- Any unresolved actual secret exposure or inability to guarantee safe publication history.
- Lack of authority to choose/publish license or to publish repository contents.
- Irreversible public release requested before P0/security/licensing gates are satisfied.
- External credential/host privilege requirements that cannot be met safely in-session.

## Next milestone (immediate)

**Milestone M1 — Safe publish unblock + OSS minimum docs**
- Replace push-blocking fake secrets with inert placeholders preserving test intent; verify redaction tests/grep.
- Push branch to GitHub and verify.
- Add LICENSE, root SECURITY, CONTRIBUTING, CoC, CHANGELOG, SUPPORT, templates, threat model, architecture overview, benchmark README.
- Rerun local verification gates and update scorecard.

**Acceptance criteria:** GH push succeeds for rewritten safe history; required OSS files exist and are accurate; local `typecheck/lint/test/build/programme:check` results recorded (pass/fail/skip with reasons); scorecard updated with evidence.
