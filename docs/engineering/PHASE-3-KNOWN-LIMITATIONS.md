# Phase 3 known limitations

**Measured 2026-11-13.** One line per limitation, with its consequence and what would
unblock it. Nothing here is a roadmap promise. Items 1–9 are security or correctness and
should be read first; the rest are operational or product gaps.

Where a limitation is a recorded finding from the audit, its `F` number is given so the
evidence can be found in `PHASE-3-SECURITY-RESULTS.md`.

---

## Evaluation and assurance

1. **The evaluation framework from directive §10 is not implemented.**
   There is no benchmark set, no task corpus, no completion-rate metric, and no
   cost-per-task aggregate across runs. What exists is six tests and **one** real run
   (`$0.0006`, one fixture bug). That proves the chain works; it says nothing about
   whether the agent is good, how often it succeeds, or what a real task costs.
   *Unblocks with:* a repository corpus, a scoring rubric, a per-run budget, and a runner
   that stores results per task — none of which exists.

2. **No load testing.**
   Nothing has been run concurrently beyond the worker's default limit. Ten simultaneous
   real runs would each copy up a ~1.1 GB provider database into tmpfs; the host has
   7.6 GB. Concurrency behaviour is unmeasured, and the failure mode is an OOM or a full
   `/tmp`, not a clean rejection.
   *Unblocks with:* a cgroup-bound load test and a measured overlay cost per run.

3. **No multi-tenant live fixture.**
   Tenant isolation is proved at the database and API layers with fixtures. Two
   organisations with two configured repositories and two concurrent real agent runs do
   not exist.
   *Unblocks with:* a second source repository and a two-org integration suite.

4. **No CI execution.**
   `.github/workflows/ci.yml` is authored and has never run: no `gh`, no git remote, no
   push credential on this host. Every green result in this repository is a local run.
   *Unblocks with:* a remote and a runner. Until then, treat CI status as `IMPLEMENTED`,
   never `VERIFIED`.

5. **No screen-reader session.**
   Accessibility evidence is axe (zero violations on Overview and the execution screen),
   landmark assertions and keyboard tests. None of those is a session with a real
   assistive technology.
   *Unblocks with:* a manual NVDA/VoiceOver pass over the execution detail screen.

6. **The live-provider cases spend provider credit, and skip silently without it.**
   `pnpm test` contacts a real provider only when `IZ_REAL_PROVIDER=1` **and** `AGENT_MODEL`
   are both set (Phase 4 replaced the old `OPENCODE_CLI_SKIP` opt-out). Without them the two
   contract cases that need a provider are skipped, so the suite reports green while testing
   nothing about a live model.
   *Unblocks with:* a separate, clearly-labelled paid test job, and a CI check that fails
   when a required suite is skipped.

---

## Security residuals

> **Phase 4 supersedes items 7, 8 and 10.** The credential is no longer in the sandbox
> (host broker), aggregate cgroup limits exist although they are opt-in, and D-006 is
> decided and implemented server-side. The text below is the Phase 3 record and is kept
> unedited; read `PHASE-4-CREDENTIAL-ISOLATION.md`, `PHASE-4-RESOURCE-ENFORCEMENT.md` and
> `PHASE-4-TEST-RESULTS.md` §5 for the current state. Items 9 (shared kernel, no seccomp)
> remains true.

7. **The provider credential is readable inside the sandbox (F2).**
   `<data>/opencode/opencode.db` — 1.07 GB — holds the credential and, by the audit's
   count, 696 operator sessions. It is mounted because the agent must authenticate to think. The
   platform-mediated path to a `VIEWER` is closed (redaction, 5 MiB cap, `ADMIN` gate on
   raw transcripts), but the **provider-mediated** path is not: the agent can put the
   credential in a prompt and the egress proxy will forward it to an allowlisted host:443.
   *Unblocks with:* removing the credential from the sandbox — proxy-injected auth or a
   short-lived per-run token. See `WORKSPACE-SECURITY-MODEL.md` §5.

8. **No cgroup, no CPU or disk quota (F3).**
   `nofile=1024`, `nproc=4096`, `AS=6 GiB` via `prlimit`. `RLIMIT_NPROC` is **per uid**,
   so it counts the worker's own processes; `RLIMIT_AS` bounds virtual memory, not RSS;
   there is no `RLIMIT_FSIZE` (it was removed because the 1 GiB database copy-up exceeded
   it) and no workspace quota. A run can fill the disk through `/workspace`.
   *Unblocks with:* a cgroup v2 scope per run (`MemoryMax`, `CPUQuota`, `TasksMax`,
   `io.max`), a workspace quota, and a supervisor outside the adapter with a hard
   `SIGKILL` deadline.

9. **The sandbox shares the kernel, runs as the worker's uid, and has no seccomp.**
   `Seccomp: 0`, no user namespace, `uid=1000` inside equals `uid=1000` outside. On this
   host `ubuntu` has passwordless `sudo` and is in `lxd`, so **any escape is
   root-equivalent**. `NoNewPrivs=1` protects nothing once code runs outside.
   *Unblocks with:* a dedicated unprivileged worker user, a seccomp profile, and
   `--unshare-user` where the host permits it.

10. **Approval policy D-006 is unresolved: a `MEMBER` can run real work unapproved.**
    `riskClass` comes from the request body. A `MEMBER` creates a task labelled `LOW` and
    `POST /run` accepts it with zero approval rows — which is exactly how the real run in
    this phase was started. The check does what it says; the question is who may decide
    that work is low risk.
    *Unblocks with:* a decision on D-006 (recommendation: a per-project minimum risk
    class, option B). The current behaviour is pinned by a test in `tasks.e2e-spec.ts` so
    a change cannot pass silently.

11. **A goal beginning with `-` is still parsed as an `opencode` flag (F12).**
    `opencodeArgv()` appends the goal as the final argv element with no `--` terminator.
    A goal of `--help` exits 0, parses to zero events, and is recorded as `succeeded`. The
    proposed guard (`--`, and an `OPENCODE_EMPTY_STREAM` failure for an empty stream) is
    **not in the code**.
    *Unblocks with:* two lines in `opencodeArgv()` and a test that a `--help` goal fails.

12. **Redaction still misses three credential shapes.**
    Measured against `redact()`: Stripe `sk_live_…` (the pattern is `sk-`, hyphen),
    an AWS secret access key (`wJalr…`), and GitLab `glpat-…` all pass through
    unredacted. The suite's 13 shapes pass; these three are not in it. Redaction is a
    denylist by construction, and the primary controls are the mount allowlist and the
    `ADMIN` gate on transcripts.
    *Unblocks with:* three patterns and three test cases. It will still be a denylist.

13. **No audit event for artifacts, checksums, tool calls or workspace provisioning.**
    `AuditEvent` covers task and workflow transitions only. "Who wrote this artifact" is
    answerable from `Evidence`, not from the audit trail; a checksum failure produces an
    HTTP `409` but no audit row. The table's `(orgId, idempotencyKey)` is an **index, not a
    unique constraint**; `emitEventActivity` checks before creating, but a race between two
    writers with no shared key can still produce a duplicate.
    *Unblocks with:* audit writes at artifact persist and on `ARTIFACT_INTEGRITY_FAILED`,
    a unique constraint on `(orgId, idempotencyKey)`, and grants that make the table
    append-only (D-003).

14. **`pnpm audit --audit-level high` fails: 7 advisories, 2 rated high.**
    Both high advisories are PostCSS, reached through `next`. D-004 classifies these as
    "Low–Medium (build-time)"; the advisory database now rates two of them high, so the
    decision's severity statement is out of date. They are build-time transitive
    dependencies, not request-path code.
    *Unblocks with:* a Next.js/ESLint upgrade, which is a separate change with its own
    regression surface. Do not suppress with a blanket override.

15. **F6, F7, F8, F14, F16, F17 and F18 remain open.**
    - F6: `req.taskId` reaches the filesystem unvalidated in the adapter (not reachable
      through today's API).
    - F7: the artifact writer copies any absolute path an adapter returns.
    - F8: artifact reads are root-scoped, not tenant-scoped.
    - F14: workspace reuse ignores the requested source and base commit.
    - F16: `probeSandbox` is a test, not a startup gate; `capabilities()` is a literal.
    - F17: `<workspace>/repo` is not re-asserted before the `rw` bind.
    - F18: `executeAgentActivity` does not re-check approval.
    *Unblocks with:* the fixes named in `PHASE-3-SECURITY-RESULTS.md` §6, in that order.

---

## Operations and retention

16. **No workspace reaper.**
    A hard kill leaves a directory on disk and an `ExecutionWorkspace` row stuck in
    `provisioning`/`executing`. `expiresAt` exists in the schema and is read by nothing.
    Cancelled workspaces are never cleaned at all (F13): `cleanup()` early-returns for
    `cancelled`, and `cleanedAt` is deliberately left null.
    *Unblocks with:* a sweeper keyed on `cleanedAt IS NULL AND state IN (…)` plus a
    retention policy for cancelled runs.

17. **Nothing schedules `workspace-manager.recover()`.**
    `recover()` and `adopt()` are called only from tests. Every activity invocation builds
    a new manager with an empty handle map, so `recover(id)` on a fresh process throws
    `WORKSPACE_NOT_FOUND` ("adopt its row first"). A crash mid-provision is repaired by
    hand or not at all.
    *Unblocks with:* a startup pass that adopts non-terminal rows and calls `recover()`,
    then writes the resulting state back.

18. **Adapter scratch directories are not garbage-collected.**
    `OpencodeCliRuntime` creates `<scratch>/opencode-cli/<taskId>-<suffix>/` containing a
    per-run config, the entry shim, the egress socket and the raw transcript. There is no
    `rm` and no sweeper in the adapter. The directory grows with every real run.
    *Unblocks with:* deletion in the adapter's `finally`, or an age-based sweep of the
    scratch root.

19. **No remote push, no branch, no pull request, no cloud deployment.**
    The agent's work stays in a disposable clone and is visible only as a diff. There is
    no mechanism to land it anywhere.
    *Unblocks with:* a git remote and a push credential the agent is allowed to use.

20. **The `executions` list is not paginated.**
    Every attempt for a task is returned in one response, and the tool trace is capped at
    500 rows per attempt. Fine at today's volume; a long-lived task will eventually make
    the response large.
    *Unblocks with:* a cursor, when a measured response size justifies it.

21. **`AgentRun.tokensIn`/`tokensOut` default to `0` for unknown.**
    The schema uses `Int @default(0)`, so "the provider did not report" and "the run used
    zero tokens" are indistinguishable in the column. `costUsd` is nullable, so unknown
    cost is honest; unknown tokens are not.
    *Unblocks with:* nullable columns (a migration).

---

## Surface

22. **Attempt↔artifact attribution is a time window, not a foreign key.**
    `Artifact` has no `attemptId`. The attempt detail endpoint attributes artifacts by
    `(taskId, runtimeId, createdAt between startedAt−1s and finishedAt+1s)`. That is
    unambiguous while one workflow per task is open; a repair script, a second concurrent
    run, or a slower artifact write would list the wrong file against the attempt.
    *Unblocks with:* an `attemptId` column on `Artifact` (a migration) and a backfill.

23. **Fifteen of sixteen navigation destinations are still placeholders.**
    Only Overview and the execution detail route (`/[workspace]/tasks/[taskId]`) render
    real data. Approvals, Projects, Agent Command Centre and the other twelve name the
    module and state that it is not built.
    *Unblocks with:* building them, one at a time, against real endpoints.

24. **The web app is read-only.**
    It cannot create a project or task, start a run, cancel a run or decide an approval.
    The execution detail screen reads attempts; it does not control them.
    *Unblocks with:* mutation UI and the API calls it would use (most exist).

25. **The execution screen was verified against seeded data, not the real run.**
    `apps/web/e2e/executions.e2e.ts` reads attempts created by the seed
    (`local-simulated`). The real `opencode-cli` run's rows come from the same endpoints
    and the same response shapes, but nobody opened that run in a browser.
    *Unblocks with:* a fixture that seeds a real attempt, or a manual pass on the run in
    §2 of the status document.

---

## Runtime interface

26. **No streaming progress to the user.**
    `execute()` returns once, at the end; events are persisted after the run. A long task
    shows "running" and nothing else, and the UI refuses to draw a progress bar because
    no step total is reported.
    *Unblocks with:* a progress channel (queue or SSE) and a `progress` contract on the
    port.

27. **`budgetUsd` is advisory.**
    The port records it and never enforces it. The real adapter has a separate `maxUsd`
    that kills the run when the provider-reported cost passes it — a cap on reported
    spend, not on authorised spend. Do not describe either as a spend control without
    naming which one.
    *Unblocks with:* metering in the worker, outside the adapter.

28. **`workspaceRoot` is a directory, not a checkout contract.**
    The request does not say which repository, commit or branch. The
    `ExecutionWorkspace` row knows; the adapter does not. An adapter cannot assert "I ran
    against commit X".
    *Unblocks with:* a checkout descriptor on `ExecutionRequest` (a v2 change).

29. **One execution per `taskId`.**
    `cancel(taskId)` keys on the task, so two concurrent runs of the same task would share
    the kill entry. The platform avoids this with `task-<taskId>` + `REJECT_DUPLICATE`.
    *Unblocks with:* an execution id on the port.

30. **The capability gate has nothing to check against.**
    `requiredActionsFor()` returns `[]` because the schema has no `requiredCapabilities`
    column. `capabilities()` is documentation with a type until that changes.
    *Unblocks with:* the column and a task-level requirement.

31. **`health()` is called once, at worker startup.**
    It has no per-run effect. An adapter that becomes unhealthy between boot and execution
    must detect that inside `execute()`; the platform will not.
    *Unblocks with:* a pre-dispatch health check with a cached result and a defined
    failure mode.
