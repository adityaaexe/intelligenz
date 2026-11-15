# Phase 5 commit audit

**Auditor:** IT Leader (primary executor)
**Branch audited:** `phase-5/isolation-readiness`
**Range:** `5bc69cf21941fdaf755a164c5d618cca8ee22b9f` → `6eda7c896e390dbce5a8be743e5337ed194777fd`
**Working tree at audit time:** clean (0 entries)

## Why this audit exists

Phase 5 opened with a worktree containing 40 dirty entries and closed with
`git add -A ':!docs'`. A clean final tree proves everything was committed. It does
not prove that everything committed was intended. This audit resolves the full
SHAs, walks each commit, and answers one question: *was anything committed that
does not belong to Phase 5?*

## Identity

| Fact | Value | Method |
|---|---|---|
| Final SHA | `6eda7c896e390dbce5a8be743e5337ed194777fd` | `git rev-parse 6eda7c8` |
| Starting SHA | `5bc69cf21941fdaf755a164c5d618cca8ee22b9f` | `git rev-parse 5bc69cf` |
| Ancestry | linear: `8d1e8e9` → `2666e4a` → `6eda7c8` | `git log --oneline --graph 5bc69cf..HEAD` |
| Files changed in range | 53 | `git diff --name-only 5bc69cf..6eda7c8 \| wc -l` |
| Local remotes | none | `git remote -v` |
| Pushed | no | no remote exists |

## Per-commit review

### `8d1e8e9` — phase 5 resource enforcement, approval-to-attempt binding, verification suites

The commit that carried the broad staging command, and therefore the one that
needed the closest reading.

| Area | Path | Verdict |
|---|---|---|
| Volume quotas | `packages/workspace-manager/src/volumes.ts` | Phase 5 unit |
| Output cap | `packages/workspace-manager/src/output-cap.ts` | Phase 5 unit |
| cgroup capability probe | worker cgroup module + tests | Phase 5 unit |
| Approval binding | `apps/api/src/approvals/approval-gate.service.ts` | Phase 5 unit |
| Orchestrator wiring | `apps/api/src/orchestrator/orchestrator.service.ts` | Phase 5 unit |
| Task contract surface | `apps/api/src/tasks/tasks.controller.ts`, `tasks.response.ts` | Phase 5 unit |
| Dependency change | `apps/api/package.json` | Phase 5 unit (test typechecking) |
| **Root `api-contract.md`** | `api-contract.md` (new, 5,167 bytes) | **Misplaced — see below** |

### `2666e4a` — fail closed on VM-required isolation profiles

`apps/api/src/executions/isolation-report.ts` (new), `executions.service.ts`,
`tasks.response.ts`. Four files, all Phase 5. No unexpected paths.

### `6eda7c8` — Phase 5 recovery documentation

Documentation only. No source.

## The one anomaly

`api-contract.md` was created at the **repository root** by BE-501 instead of
under `apps/api/`. It is not a copy of the canonical contract — the canonical
file is `apps/api/api-contract.md` (26,620 bytes) and the root file is a
5,167-byte *Phase 5 delta* titled "API contract — Phase 5 delta (BE-501)".

Real content, wrong location. Five documents under `docs/engineering/` reference
`/api-contract.md`, which is why the path resolved at all during Phase 5.

**Action taken:** moved, not deleted, to
`docs/engineering/phase5-recovery/API-CONTRACT-DELTA.md` so the delta remains
part of the record and the canonical contract path is unambiguous again. No
content was altered.

## Conclusion

Every path in `5bc69cf..6eda7c8` maps to a Phase 5 unit or to Phase 5
documentation. Nothing unrelated was smuggled in by the broad staging command.
One file was in the wrong place and has been relocated without loss.

## What this audit does not establish

- **Intent.** A diff shows what changed, not why. The per-commit reading above
  establishes scope, not authorship intent.
- **Correctness.** That the resource controls work is Phase 5's own evidence, and
  Phase 6 re-runs those suites against the new candidate rather than trusting it
  (see `TEST-RESULTS.md`).
- **Review of `8d1e8e9`'s implementation.** Read at the level needed to classify
  each path. Phase 6 did not re-audit Phase 5 logic it did not change.

## Evidence paths

- `git log --oneline --graph 5bc69cf..HEAD`
- `git show --name-status <sha>` per commit
- `git diff --name-only 5bc69cf..6eda7c8` (53 paths)
- `docs/engineering/phase5-recovery/API-CONTRACT-DELTA.md` (relocated)
