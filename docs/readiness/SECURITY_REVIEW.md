# INTELLIGENZ — Security Review (Baseline, Open-Source Readiness)

**Date:** 2026-11-21  
**Scope:** repository/documentation review for open-source publication readiness. This is **not** a penetration test and **not** a production sign-off.  
**Status:** DRAFT — evidence-backed baseline; several items require rerun verification and external authorization.

## Summary

| Area | Status | Evidence | Notes |
|---|---|---|---|
| Secret exposure (tracked current HEAD) | IN_PROGRESS | `git grep` scan; GH push protection GH013 during push attempts | Fake Stripe/GitLab-shaped fixtures in tests/docs triggered push protection; contiguous forms remediated in working tree, history rewrite required before push. No real secrets intentionally committed; local `.env` is untracked. |
| Secret exposure (git history) | BLOCKED for publication | push protection remote rejection; `git log -S` history hits for prior fake fixtures | History contains/remediated fake scanner-trigger strings across rewrites; must be verified clean before public push. |
| AuthN/AuthZ | IMPLEMENTED_BUT_UNVERIFIED | `apps/api/src/auth/*`, `tenancy/*`, JWT config tests, phase security docs | Rerun required on current HEAD. |
| Approval/governance boundaries | PARTIALLY_IMPLEMENTED | approval binding/gate, server-derived risk, programme/plan controls; P87-009/P87-011 open | Planning != execution authority preserved in design; open policy/resumption issues remain. |
| Workspace isolation / sandbox | PARTIALLY_IMPLEMENTED | workspace-manager bwrap, egress broker, cgroups, execution enforcement docs/scripts | Shared-kernel boundary; host privilege/identity split (P83-003/004) blocked; not VM-grade isolation. |
| Credential handling | IMPLEMENTED_BUT_UNVERIFIED | egress broker, redaction, env/credential isolation docs | Real-runtime paths depend on external provider credentials; never publish secrets. |
| Dependency/security scanning | PARTIALLY_IMPLEMENTED | CI has no dedicated security scan job; local audit not rerun in this pass | Add dependency/secret scanning in CI before release claim. |
| Deployment readiness | NO-GO | `docs/engineering/DEPLOYMENT-READINESS.md` | Not production/staging ready. |

## Key findings / blockers

### P0
1. **GitHub push protection blocks publication** until history/HEAD are free of scanner-triggering secret-like fixtures. Remediation in progress; verify with push + grep before claiming clear.
2. **No canonical LICENSE in repo**; ownership/authority to license must be confirmed before public release.
3. **Production NO-GO / host-boundary blockers unresolved** (P83-003/P83-004, R-05..R-10 historical host boundary gaps, P87-009/P87-011, P88 backlog). Do not claim production readiness.

### P1
1. Root `SECURITY.md` disclosure policy missing (this file is an internal readiness review, not the public disclosure policy).
2. CI lacks dedicated security scanning and full-stack verification.
3. Historical fake secret fixtures exist in old docs/tests; they must remain inert and scanner-safe.

## Publication safety checklist (must pass before push/release)

- [ ] `git grep` finds no real secrets/tokens/private keys.
- [ ] No tracked `.env`, dumps, credentials, SSH keys, internal-only configs.
- [ ] Push protection allows push (or findings are confirmed false positives and resolved through approved process; do not bypass blindly).
- [ ] LICENSE authority confirmed.
- [ ] README/SECURITY/THREAT_MODEL accurately describe limitations; no "production ready" claim.

## Evidence references

- `docs/readiness/BASELINE_AUDIT.md`
- `docs/readiness/OPEN_SOURCE_READINESS.md`
- `docs/engineering/SECURITY-RESULTS.md`
- `docs/engineering/PHASE-3-SECURITY-RESULTS.md`
- `docs/engineering/PHASE-4-SECURITY-RESULTS.md`
- `docs/engineering/WORKSPACE-SECURITY-MODEL.md`
- `docs/engineering/phase8.9-operator-preview/PREVIEW-SECURITY-REVIEW.md`
- `docs/engineering/DEPLOYMENT-READINESS.md`
