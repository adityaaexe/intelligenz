# Known limitations

> Phase 2, measured 2026-11-13. Each line is a limitation with its consequence. None is
> a roadmap promise. Where a document explains the cause, it is linked.

## Product surface

1. **Fifteen of sixteen navigation destinations are placeholders.** Only Overview is
   implemented. Every other route renders a page that names the module, states that it
   is not built, and names the API surface that does or does not exist. The links work;
   the screens do not.
2. **Approvals has an API but no screen.** `GET /v1/orgs/:orgId/approvals` and
   `POST /v1/orgs/:orgId/approvals/:approvalId/decision` are implemented and tested.
   The navigation item leads to a placeholder. A user cannot approve anything in the
   browser.
3. **Task detail has an API but no screen.** `GET /v1/orgs/:orgId/tasks/:taskId` returns
   the latest run, artifacts and approvals. No web route renders it. The Overview table
   is the only task view.
4. **There is no mutation UI at all.** The web app can sign in, read the Overview and
   refresh it. It cannot create a project, create a task, start a run, cancel a run or
   decide an approval. This is not a mobile-only limitation; the desktop surface is
   read-only too.
5. **Three areas on the Overview say `Not instrumented`.** Two are among the eight
   required regions: **Active workflows** (no endpoint lists `WorkflowRun` rows) and
   **Recent decisions** (no endpoint lists `AuditEvent` rows). The third is the
   **operating constraints** line in the posture strip (no API source for mode, max
   risk, daily budget, sandbox or rollback policy). The design counts the constraints
   line separately from the eight regions; this document does not inflate it into a
   third region.
6. **The Overview shows proof-run rows from the development database.** Task titles
   beginning `AG-001` and `SEC-002` are artifacts of the test cycles. They are real rows
   and can appear in Task queues, Agent activity and Critical alerts. The seed is not
   the only data in `intelligenz_dev`.
7. **Two seeded workflow runs are stuck `running`.** They carry fixture workflow ids of
   the form `run-task-…` and no worker will ever finish them. They are seed data, not
   orphaned executions, but they look like live work in the task queue.
8. **No search, command palette, notifications or saved filters.** The design specifies
   them. Phase 2 has none.
9. **The approvals queue is risk-ranked, but a task stays approved for its lifetime.**
   An `APPROVED` request authorises every future run of that task, including a run
   started later by a different member. There is no per-run approval.
10. **An `ADMIN` can approve their own request.** The decision endpoint does not compare
    `requestedById` with the deciding user. The approvals queue therefore overstates
    the control. Recorded as `D-001` in `docs/decisions/OPEN-DECISIONS.md`.

## Agent runtime and data

11. **The agent runtime is simulated.** `LocalSimulatedRuntime` has no shell, no
    network, no browser, no MCP, and no model call. It does not read the repository or
    produce a code change. It writes a deterministic report and reports `$0.0000` cost.
    A run proves plumbing, not engineering.
12. **The failure rate is a hash, not a measurement.** Roughly 15% of task ids land in
    the simulated failure bucket. `[simulate:fail]` and `[simulate:ok]` override it per
    task; `LOCAL_SIMULATED_OUTCOME` overrides it per process. Do not read a failure as a
    real defect or a success as a real capability.
13. **Token counts are plausible, not metered.** The runtime derives them from a hash.
    They are stored in `AgentRun.tokensIn` and `tokensOut` and displayed as usage. No
    provider billed them.
14. **`AgentRun.tokensIn` and `tokensOut` default to `0` for unknown.** The schema uses
    `Int @default(0)`, so “not reported” and “zero” are indistinguishable. ADR-006 wants
    `undefined`; the column cannot express it.
15. **Budget is recorded, not enforced.** `budgetUsd` is advisory. Nothing blocks a run
    on cost, and there is no pricing source of truth. Contract §15 A7 says to state
    this; it is stated.
16. **Artifacts are written but never read back.** The worker stores the file,
    checksum and size. The API returns the checksum as metadata. No route serves the
    bytes and nothing re-reads the file to verify the checksum after write.
17. **Disk and database disagree.** Six `result.md` files exist under `.artifacts/`;
    three are referenced by `Artifact` rows. The other three are unreferenced. No
    garbage collection, reconciliation or retention job exists.
18. **Artifact paths are disclosed to any member.** `TaskDetail.artifacts[].uri` is an
    absolute path under `ARTIFACT_ROOT`. It reveals the host layout. The bytes are not
    fetchable through the API. Recorded as `D-002`.
19. **The audit trail is append-only by convention.** `AuditEvent` has no update
    timestamp, API writes go through `AuditService`, and the worker writes through
    `emitEventActivity`. Both validate the envelope, but the application database role
    holds `UPDATE` and `DELETE` on the table, so a compromised API can rewrite its own
    history. Recorded as `D-003`. Audit idempotency is also check-then-insert: the
    schema has a non-unique index on `(orgId, idempotencyKey)`, not a unique
    constraint, so two concurrent writers can create duplicate events with the same
    key. The worker returns an existing row when it sees one, which narrows the race
    but does not close it.
20. **`WorkflowRun` and `AgentRun` have no uniqueness constraint per task.** Idempotency
    comes from deterministic workflow ids and `upsert` on derived row ids. A code path
    that bypasses those ids can create a second run. The artifact and evidence tables
    do have unique indexes; the run tables do not.
21. **A retried activity is not covered by a test.** Deterministic ids and unique
    indexes make a duplicate row unlikely. The only evidence that a retry produces one
    artifact is a manual proof run, not a gate. See `TEST-RESULTS.md` §3, case 4.
22. **Cancellation is proven by inspection, not by a test.** Three cancelled proof runs
    exist with `task.cancelled.v1` events and no artifacts. No automated test starts a
    workflow, cancels it, and asserts the final rows.
23. **There is no worker-level integration test.** The worker is not started by the
    test suite. Workflow completion, failure persistence and cancellation rest on
    manual proof runs in the development database.

## Security and assurance

24. **No screen-reader session has been performed.** Keyboard reachability is tested
    (skip link), landmarks are tested, and roles are asserted. No NVDA, JAWS, VoiceOver
    or Orca session exists. Accessibility conclusions come from DOM inspection, not
    assistive technology.
25. **Dark theme is token-verified and unreviewed — and unreachable.** The dark token
    block exists in `packages/design-system/src/tokens.css`. No UI path sets
    `data-theme="dark"` and there is no theme switcher, so the dark theme has never
    rendered in this build. Its contrast values were measured in `DESIGN.md`; no screen
    was visually reviewed in dark mode.
26. **The test suite is Chromium-only.** Four viewport sizes, one browser engine.
    Firefox, WebKit and Safari are untested. No visual regression comparison exists.
27. **No test asserts that secrets stay out of logs.** Redaction paths are configured
    for authorization headers, cookies, passwords, hashes, tokens and secrets. No test
    captures log output and greps it. Case 8 in `TEST-RESULTS.md` is a gap.
28. **Revocation is untested.** The code re-reads role and membership from the database
    on every request, so deleting a membership should revoke access on the next call.
    No test deletes a membership mid-session and asserts the next request fails.
29. **Tenant isolation has not been exercised against two live tenants.** It is proven
    by API tests against a separate two-organisation test database and by query
    inspection of the service layer. The seeded development database has one
    organisation, so no browser session has switched between two.
30. **`pnpm audit` reports seven advisories, two high.** All are transitive build
    tooling, chiefly `postcss` nested in `next@15.5.29`. None is reachable from request
    handling. The build is not dependency-clean. Recorded as `D-004`.
31. **The access token is readable by JavaScript.** It lives in `sessionStorage`, not an
    `httpOnly` cookie. An XSS in the origin can read it. There is no BFF to hold a
    cookie. The trade-off is documented in `apps/web/src/lib/session.ts`.
32. **Login rate limiting is per process.** Five attempts per 15 minutes per
    `(ip, email)`, held in a `Map`. Two API replicas mean `2 × 5`. A restart clears the
    window. Redis is running but unused.
33. **Readiness caching is per process.** Two replicas probe independently. The cache
    reduces load per process; it does not coordinate.
34. **No TLS, WAF, monitoring or alerting exists.** A forged-token attempt produces a
    `401` on stdout that nobody collects. A successful forgery would look like normal
    traffic. See `DEPLOYMENT-READINESS.md` §4.
35. **The seeded password is public.** `Passw0rd!demo` is in the repository. It is
    correct for a local fixture and must never exist in a shared environment.

## Operations

36. **The working tree is not committed.** There is one scaffold commit and 93
    uncommitted entries. There is no remote and no push credential. Nothing has been
    backed up off-host. See `DEPLOYMENT-READINESS.md` §2.3.
37. **No CI run has been observed.** The workflow is a file. It omits the API E2E gate
    and carries a `JWT_SECRET` value the hardened validator rejects.
38. **No backup or point-in-time recovery.** `archive_mode=off`, no dump schedule, no
    restore drill. A bad migration is unrecoverable beyond re-seeding.
39. **Temporal is a dev server on a SQLite file.** Workflow state survives a worker
    restart and does not survive host loss. No TLS, no auth, no retention policy.
40. **No process supervision.** Three foreground processes. A worker crash stops
    execution until a human restarts it.
41. **No load, soak or concurrency testing.** No latency or throughput numbers exist.
42. **No container image, no cloud environment, no DNS, no certificate.** Deployment is
    not implemented. This is scope, not an accident.

---

For the evidence behind each item, see `IMPLEMENTATION-STATUS.md`,
`TEST-RESULTS.md`, `SECURITY-RESULTS.md` and `DEPLOYMENT-READINESS.md`.
