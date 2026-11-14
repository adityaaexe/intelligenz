# Phase 5 — Ownership Manifest

One writing workstream at a time. This file is the authority; if a file is not listed for an owner, that owner may not touch it.

## Active workstream

**AG-503 — resource-control verification** (sole writer)

| | |
|---|---|
| Worktree | shared working tree, but sole writer for this cycle |
| May create | `packages/workspace-manager/test/volumes.test.ts`, `packages/workspace-manager/test/output-cap.test.ts`, `apps/worker/test/cpu-budget.test.ts` |
| May fix (only on a failing test) | `packages/workspace-manager/src/volumes.ts`, `packages/workspace-manager/src/output-cap.ts`, the CPU-budget module (`startCpuBudgetWatch` / `checkCpuBudget`) |
| Prohibited | `apps/api/**`, `packages/database/**`, `packages/agent-runtime/**`, `packages/evaluation/**`, `apps/worker/src/activities/execute-agent.ts`, `apps/worker/src/activities/validate-task.ts`, any migration |
| Shared, out of scope for this cycle | `package.json`, `pnpm-lock.yaml`, `tsconfig*.json`, `eslint.config.mjs`, `packages/database/prisma/schema.prisma` |
| Deliverable | three test suites + executed results, or a named blocker per suite |

## Deferred workstream

**Integrity verification** — not started. It may not run concurrently because its file list has not been mapped against AG-503. It begins only after the resource verification is committed, at which point its files are assigned explicitly here.

## Frozen for this cycle

- Phase 1–4 code and documents (no reopening without a concrete regression).
- `/var/lib/intelligenz/volumes/*.img` and their mounts (read/lease only; never delete, never unmount, never fill).
- Host-wide cgroup configuration (`/sys/fs/cgroup/cgroup.subtree_control`) — no host-level changes to obtain `io` delegation.

## Rule applied

Parallelism is permitted only when two conditions hold: disjoint proven file ownership, and each writer has an independent worktree. Neither holds for integrity yet, so it waits.
