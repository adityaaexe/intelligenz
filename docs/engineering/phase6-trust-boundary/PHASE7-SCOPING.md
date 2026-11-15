# Phase 7 scoping — Gate A (credential custody) and Gate M (multi-tenancy)

**Status:** scoping brief. Read-only. No source changed, no test run, no identity created,
no host configuration touched.
**Base:** `cfc1f26` on `phase-6/trust-boundary-closure` (working tree dirty; this file only).
**Author:** Security Architect (subagent).
**Supersedes for Gates A and M:** the one-line rows in `PHASE6-GATE-MATRIX.md`.

Every factual claim below carries how it was established. `measured` means a command was run
in this session and its output is quoted. `read` means the source was opened. `inferred` means
derived, not observed. `NOT TESTED` means it cannot be known without running code that this
phase is not allowed to run.

---

## 0. The finding that reorders the whole phase

Before Gate A or Gate M, one measurement changes what "boundary" can even mean here.

```
$ id
uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),4(adm),24(cdrom),27(sudo),30(dip),102(lxd)

$ sudo -n whoami
root
exit=0

$ sudo -n -l
User ubuntu may run the following commands on ip-172-31-2-178:
    (ALL : ALL) ALL
    (ALL) NOPASSWD: ALL
```

*(measured)*

The worker runs as uid 1000. uid 1000 has passwordless `sudo`. It is also in `lxd` (a
well-known root-equivalent path) and `adm` (host log read).

**Consequence: no same-host uid separation is a boundary until this is removed.** A worker
compromise today is not "a worker compromise" — it is host root, and therefore also the
Temporal server, the database, every tenant's rows, and every credential on the machine. Any
Phase 7 design that creates a `izbroker` uid without first removing uid 1000's sudo is
security theatre: the attacker runs `sudo -u izbroker cat <store>`.

This is item 0, above Gate A and Gate M. It is a configuration change, not code, and it is
the highest risk reduction available anywhere in this brief.

**Also not recorded by `CREDENTIAL-CUSTODY-ASSESSMENT.md`,** and material to the design:

| Omission | Measured value | Why it matters |
|---|---|---|
| Parent directory chain is group/other-writable by the worker's own group | `/home/ubuntu` `0750`, `.local` `0775`, `.local/share` `0775`, `.local/share/opencode` `0775`, all owner `1000` | `chmod 0600` + `chown izbroker` on the **file** is bypassable: `unlink`/`rename` needs write on the **directory**, which uid 1000 has. Tightening the file is not the control; the directory chain is. |
| A second credential file in the same directory | `mcp-auth.json`, `0600`, uid 1000, 344 bytes *(measured by `ls -ln`; contents deliberately not read)* | Custody that protects only `opencode.db` leaves a second secret store inside the worker's trust domain. |
| The broker's client is the **sandbox**, not the worker | `broker-contract.ts:87` bind-mounts `brokerDir` into the sandbox at `/run/agent-broker` (`ro`); `BROKER_RELAY_SOCKET` at `:18` | The agent-controlled process is a legitimate socket client. This is discussed in §1.3 and it is the single most overclaimed part of "custody". |

---

# 1. Gate A — credential custody

## 1.1 The boundary that must exist

**Threat to be defeated:** arbitrary code execution as uid 1000 *outside* the sandbox — a
compromised npm dependency in the worker, an adapter bug, a host-side SSRF in a runtime that
reaches `fs` — reads provider credentials.

**The boundary:** the credential store is owned by a uid that the worker is not, inside a
directory chain the worker cannot write, opened only by a long-lived process running as that
uid, reached over a unix socket whose peer uid that process verifies.

**What the boundary is not:** it is not the sandbox boundary (that already exists and is
Gate R, enforced). Gate A is about the *host-side* worker process, which today reads
`opencode.db` directly. `packages/egress-broker/src/credential.ts:8-12` says this in the
source: "The credential is read **here**, in the worker process." That sentence is the gate.

## 1.2 Where the boundary goes

| Element | Target | Rationale |
|---|---|---|
| **Process** | `iz-broker.service`, long-lived, one instance, supervised by systemd. Not started per attempt. | A per-attempt process still runs inside the worker's spawn tree with the worker's environment. A supervisor-owned unit is the only shape where the worker is a *client*, not a *parent*. |
| **Uid** | `izbroker` (system uid, `nologin`, no groups except its own), owning `/var/lib/iz-broker` `0700` and `credentials.db` `0600`. **Not under `/home/ubuntu`.** | The store cannot be owned by `izbroker` while it sits inside a path chain owned and writable by uid 1000 (§0). Moving it is not optional. |
| **Sandbox uid** | `izsandbox`, distinct from 1000, sandbox launched with that uid. | Without this, `SO_PEERCRED` returns 1000 for both the worker and the agent, and the check cannot discriminate (§1.3). This is the assessment's item 5, and it is a *prerequisite* for the check to mean anything. |
| **Socket** | `/run/iz-broker/broker.sock`, directory `0755 root:izbroker`, socket `0660 izbroker:iz-sandbox`. Path fixed, not per-attempt; the per-attempt `brokerDir` becomes a per-attempt **capability**, not a socket location. | `chmod 0600` today (`broker.ts:656`) is correct for an in-process broker and wrong for a service: the worker/sandbox must connect. Filesystem mode is the coarse gate; the peer check is the authoritative one. |
| **Check at the socket** | `getsockopt(SOL_SOCKET, SO_PEERCRED)` on accept; reject any peer uid outside `{izsandbox}`. Reject `0` (root) explicitly. Log the rejected uid. | `SO_PEERCRED` is the only identity the kernel attests for a unix socket peer. It is unforgeable by the client. **There is none today** — `grep -rn "SO_PEERCRED"` returns nothing *(read)*. |
| **Credential resolution** | The broker resolves it. The client sends only `{attemptId, capabilityToken, provider, upstreamBaseUrl}`. | Already the shape: `broker.ts:492` calls `readCredential(options.upstream.credential)` where `credential` is a **descriptor** (`{kind:'opencode-db'\|'env', …}`), not a secret. The worker passes the descriptor today (`opencode-cli.ts:714`). The cutover changes *where the call executes*, not its signature. This is the single most important thing that makes Gate A tractable. |

### What the worker may and may not do

| May | May not |
|---|---|
| Connect to the broker socket as uid 1000 for health and for minting per-attempt capabilities | Open, read, `stat`, `lstat`, `readlink`, `unlink`, or `rename` anything under `/var/lib/iz-broker` |
| Read the *descriptor* it already holds (integration id, base URL) | Read the store file, its WAL, its SHM, or `mcp-auth.json` |
| Terminate a run (fail-closed) | Hold any provider key in its own memory or environment |
| — | Be the sandbox's uid; the sandbox runs as `izsandbox` |

**The environment source is a custody hole and must be covered.** `resolveBrokerConfig`
(`apps/worker/src/config.ts:365-380`) supports `AGENT_BROKER_CREDENTIAL_ENV`, and
`readEnvCredential` (`credential.ts:219`) reads `process.env[name]` **in the worker**
*(read)*. `/proc/<pid>/environ` is readable by the owning uid, so the env source is exactly as
exposed as the SQLite store under a uid-1000 compromise. A custody design that hardens only
the DB path leaves this open. In the target, the env var lives on the **broker** unit.

## 1.3 What custody buys, and the thing it does not

This distinction must appear in the phase report, because the honest version is still a large
win and the dishonest version is a false claim.

- **Read disclosure is eliminated.** Today, uid 1000 reads a 1.1 GB store holding every
  provider credential the operator has, plus the operator's session history. After custody,
  the worker reads nothing: not this attempt's key, not another provider's key, not history.
  That is the entire value of Gate A, and it is the difference between "one provider is
  abused" and "the operator's identity is exfiltrated".
- **Spend is not eliminated, and cannot be, in this design.** The sandbox mounts the broker
  directory (`broker-contract.ts:87`); the agent's model calls traverse that socket. The agent
  therefore already reaches the broker by design. Custody bounds what such a request can do
  (`maxRequests` `DEFAULT_BROKER_MAX_REQUESTS = 400`, allowed paths/methods, per-attempt
  capability) but it does not stop it. A compromised worker can likewise mint a capability for
  a run it launches — the worker is the launcher.
- **Therefore: after Gate A, a worker compromise is not a credential *disclosure*; it is
  still a credential *use* against the attempt's own provider, capped per attempt.** That is
  the correct claim. Anything stronger is unsupported.
- **`SO_PEERCRED` is only meaningful after the sandbox uid split.** While the sandbox and the
  worker are both uid 1000, the broker's allowlist has one indistinguishable entry, and the
  check proves nothing about which of the two is calling. The sandbox's host uid is
  **inferred** as 1000: `/usr/bin/bwrap` is not setuid (`-rwxr-xr-x root root`) and the argv
  builder emits no `--uid`/`--unshare-user` (`sandbox.ts:302-333`, read). Not launched and
  observed in this session — **NOT TESTED**.

## 1.4 What must be proven before Gate A can be called enforced

Five tests, in the order they should land. Each is written to fail against today's code.

**A-1 — the worker cannot open the store (the primary negative test).**

```bash
# Positive control FIRST, or a typo in the path "passes".
setpriv --reuid=izbroker --regid=izbroker --clear-groups \
  node -e "const fs=require('node:fs'); const fd=fs.openSync('/var/lib/iz-broker/credentials.db','r'); console.log('opened', fd); fs.closeSync(fd)"
# expected: prints "opened <n>"

setpriv --reuid=1000 --regid=1000 --clear-groups \
  node -e "const fs=require('node:fs'); fs.openSync('/var/lib/iz-broker/credentials.db','r')"
# expected: Error: EACCES: permission denied, open '/var/lib/iz-broker/credentials.db'
```

The failing-today property: today the same command as uid 1000 on
`/home/ubuntu/.local/share/opencode/opencode.db` **succeeds**. That is the proof the gate is
absent, and it should be recorded as the baseline.

**A-2 — the directory chain, not just the file.** As uid 1000, attempt
`rename('/var/lib/iz-broker/credentials.db', …)`, `unlink(…)`, and `open` on the *parent*
directory for write. All must fail with `EACCES`/`EPERM`. This test exists because §0 is a
real bypass: with the store where it is now, `0600` on the file does not stop uid 1000 from
replacing it.

**A-3 — no privilege escalation from the worker uid.**

```bash
setpriv --reuid=1000 --regid=1000 --clear-groups sudo -n true   # must fail (non-zero)
getent group sudo | grep -q '\bubuntu\b' && echo FAIL            # must not match
id -nG 1000 | tr ' ' '\n' | grep -xE 'sudo|lxd|adm' && echo FAIL # must not match
```

**A-4 — `SO_PEERCRED` rejects an unauthorized peer, and the test must not be satisfiable by
file mode alone.** This is subtle: if the socket is `0660 izbroker:iz-sandbox`, an outsider
gets `EACCES` at `connect()` from *filesystem* permission, and a test that accepts
`ECONNREFUSED|EACCES` would pass even with the peer check deleted. The test must therefore use
a uid that **can** connect but is **not** authorized — put the test uid in the socket's group
and assert the broker still refuses and logs `peer uid <n> rejected`. Without that, the test
proves the mode, not the check.

**A-5 — the fail-closed path survives the cutover.** With the broker unit stopped, a real run
must fail with `BROKER_UNAVAILABLE` and execute nothing (`opencode-cli.ts:718-733`). This is
the property that makes the migration safe, and it is already tested in spirit — it must be
re-run against the service client.

## 1.5 Migration path that does not break the execution path

The current design makes this unusually cheap, because the broker is already per-attempt and
its lifetime is the attempt:

- `startEgressBroker` is called inside `execute()` at `opencode-cli.ts:711` *(read)*; the
  broker is closed in the `finally` (`broker.ts:698` unlinks the socket).
- The credential crossing the boundary is already a descriptor, not a secret (`broker.ts:492`).
- The client already fails closed on an unreachable broker (`:718-733`).

Steps, in order. Steps 1–2 are host work and are **out of scope for this phase** (do not
perform them here).

1. **Remove the escalation path** (§0): drop uid 1000 from `sudo`, `lxd`, `adm`; remove the
   `NOPASSWD` rule. No code. Re-run A-3.
2. **Create `izbroker` and `izsandbox`; move the store** to `/var/lib/iz-broker/credentials.db`
   `0700`/`0600`, owned by `izbroker`, **outside `/home/ubuntu`**. Provision from the existing
   store one-way, by an operator-run script, values piped over stdin (never argv, never a log).
   Decide explicitly whether the broker keeps a *copy of the whole* `opencode.db` (bad: it
   re-imports the operator's session history and every other provider key) or a **purpose-built
   store containing only the credentials the platform needs** (recommended: it shrinks blast
   radius from "1.1 GB, every key, all history" to "the platform's keys", and it leaves the
   operator's interactive opencode working untouched). The second option is why this migration
   need not break anything the operator does.
3. **Ship the broker unit** with systemd hardening: `NoNewPrivileges=yes`,
   `ProtectSystem=strict`, `ProtectHome=yes`, `PrivateTmp=yes`, `PrivateDevices=yes`,
   `CapabilityBoundingSet=` (empty), `RestrictAddressFamilies=AF_UNIX AF_INET` (AF_INET is
   required — the broker dials the provider), `MemoryDenyWriteExecute=yes`,
   `SystemCallFilter=@system-service`, `ReadWritePaths=/var/lib/iz-broker`.
4. **Client cutover, per attempt, not host-wide.** Add a service-client transport selected by
   config; new attempts use it; attempts already running keep their in-process broker and are
   never restarted or drained. Because the broker's lifetime == the attempt's lifetime, there
   is no long-lived process to migrate.
5. **The in-flight run during cutover is a non-event** *provided* step 4 is not done with a
   flag that can silently fall back. An in-flight attempt holds its own in-process broker and
   finishes. If its worker dies, the Temporal retry re-enters `execute()`, adopts the same
   reserved attempt (the Phase 6 CAS guarantees no second execution), and lands on the service
   path. If the service is misconfigured, the run fails `BROKER_UNAVAILABLE` — loudly, not
   silently unbrokered. **The one rule for this step: no fallback from service to in-process.**
   A fallback flag makes the phase unprovable, because the enforcement test would have to
   prove a negative about a code path that still exists.
6. **Delete the in-process path**, then re-run A-1…A-5 and *prove* the tests fail when the
   boundary is removed (delete the peer check → A-4 fails; restore the worker's read access →
   A-1 fails). Gate A is **enforced** only at this step.
7. **Split the sandbox uid** (`izsandbox`), which is what makes A-4 discriminate at all.

**What happens to an in-flight run if you cut over at step 4 without step 6: nothing, and that
is the risk.** "Nothing breaks" is also "nothing is enforced", because the old path still
reads the store. Do not report Gate A as closed at step 4.

## 1.6 What this does not fix

- **Kernel compromise.** Same kernel, same page cache. A local-privilege-escalation or a
  kernel info-leak defeats any uid boundary on this host. `unprivileged_userns_clone=1` and
  bwrap's userns use widen that surface, not narrow it.
- **Host admin.** Root reads everything, by definition. That includes a legitimate operator —
  and, until §0 is fixed, the worker.
- **A compromised broker.** It holds the keys by construction. Custody moves the secret, it
  does not reduce what the holder can do; the broker must stay small, dependency-pinned, and
  auditable. This is now the highest-value target in the system.
- **The sandbox's ability to spend.** §1.3. Bounded, not removed.
- **The operator's own shell.** uid 1000 is the operator's interactive account. Removing sudo
  affects the operator too; that is a deliberate consequence and needs sign-off, not a
  workaround.
- **`mcp-auth.json` and any other secret under `~`**, unless explicitly in scope.
- **Supply chain of the broker, and of the worker.** `pnpm audit` clean at `high` (Gate P) is
  not proof.

## 1.7 Availability

A separate host or VM is the only boundary that survives kernel compromise and host admin.
It is **BLOCKED** here: `/dev/kvm` does not exist and `/proc/cpuinfo` contains no `vmx`/`svm`
*(measured)*, consistent with Gate F. A second host is therefore an architecture decision that
**cannot be tested in this environment** and must not be written into the gate matrix as
enforced. Same-host uid separation after §0 is the enforceable minimum; label it
`restricted-same-kernel`, exactly as Gate F labels bubblewrap.

---

# 2. Gate M — multi-tenancy

## 2.1 Enforcement as it stands (measured, and better than the gate row implies)

`apps/api/src/tenancy/org-scope.guard.ts` *(read)* does the right thing and should not be
redesigned: `X-Org-Id` selects a candidate tenant, the **path must agree with the header**
before any query, membership is looked up on `@@unique([orgId, userId])` with no cache, and a
non-member gets 403 while another tenant's resource gets 404 (so an id is never confirmed).

In `apps/api/src` there is **no** query keyed on a tenant-owned id without `orgId`. Verified
two ways: `grep -rn "where: { id:" apps/api/src` returns nothing unscoped, and every
`update`/`delete`/`findUnique` in the tree was inspected — the only global lookups are
`membership` by composite key and `user` by email (correct: authentication is global). Two
multi-line `where` blocks in `approval-gate.service.ts:241,344` carry `orgId` *(read)*.

**So Gate M is not a bug hunt. It is an absence of adversarial proof, plus one structural
gap that lets the next query repeat the mistake silently.**

## 2.2 Every path where `orgId` is the only separator

All API paths below are `(id + orgId)` in the same `where`. The tenant dimension lives
entirely in the predicate; nothing below it (database, filesystem) enforces it. That is the
finding: **`orgId` is a convention in application code, not a property of the data store.**

| Path | Separator | Verdict |
|---|---|---|
| `GET /orgs` | membership rows for the token's user | Safe — no client id |
| `GET /projects?workspaceId` → `projects.service.ts:37` | `{orgId, workspaceId}` | Scoped; untested cross-tenant for *write* |
| `POST /projects` → `:121` | `{id: workspaceId, orgId}` | Scoped |
| `GET /tasks?projectId` → `tasks.service.ts:395` | `{orgId, projectId}` | Scoped; list absence tested |
| `POST /tasks` → `:155` | `{id: projectId, orgId}` | Scoped |
| `GET /tasks/:taskId` → `:422` | `{id, orgId}` | Scoped; 404 tested |
| `PATCH /tasks/:taskId` → `:669` | `updateMany {id, orgId, status}` | Scoped; **untested cross-tenant** |
| `POST /tasks/:taskId/run` → `:866`, `:926` | `{id, orgId, status}` | Scoped; **untested cross-tenant** |
| `POST /tasks/:taskId/cancel` → `:1063` | `{id, orgId, status in}` | Scoped; **untested cross-tenant** |
| `GET …/executions` → `executions.service.ts:105` | `{orgId, taskId}` | Scoped; tested |
| `GET …/executions/:attemptId` → `:127` | `{id, orgId, taskId}` | Scoped; 404 tested |
| `GET …/tool-invocations` → `:162` | `{orgId, agentRunId}` | Scoped |
| `GET …/artifacts` → `:194` | `{orgId, taskId, attemptId}` | Scoped |
| `GET /artifacts/:artifactId` → `artifacts.service.ts:136` | `{id, orgId}` | Scoped; **untested cross-tenant** |
| `GET /artifacts/:artifactId/content` → same `find` | `{id, orgId}` then URI resolution | Scoped in DB; **content path has no tenant dimension — see §2.4** |
| `GET /approvals` → `approvals.service.ts:114` | `{orgId, status}` | Scoped |
| `POST /approvals/:id/decision` → `:240` | `updateMany {id, orgId, status:'PENDING'}` | Scoped; foreign id 404 tested |
| `POST /approvals/:id/revoke` → `:351` | `{id, orgId, status:'APPROVED'}` | Scoped; **untested cross-tenant** |
| `GET /health` | public by design | Correct |
| Audit log | write-only; no controller exists | No read surface today — **becomes one the day a reader is added** |

## 2.3 Paths that take an id without `orgId` (flag these)

Six in worker code. Each is safe today, and each is safe for a reason *other than its own
predicate*. That is the definition of a latent gate.

| Location | Query | Why it is safe today | What would break it |
|---|---|---|---|
| `apps/worker/src/activities/persist-result.ts:191` | `agentRun.upsert where {id: agentRunId}` | `agentRunId` is derived from `workflowRunId` (`activities/ids.ts`), and the run was read scoped at `:143` | Any path that accepts an `agentRunId` from input, or a re-derivation change |
| `:296`, `:368` | `artifact.upsert where {id: artifactId}` | `artifactIdFor(taskId, kind, checksum)` — contains `taskId`; the task was read scoped at `:116` | Passing a `taskId` that was never scoped; `checksum` is agent-influenced |
| `:331`, `:400` | `evidence.upsert where {id: evidenceId}` | Same, plus `orgId` in `create` only | Same. `update: { uri }` would rewrite a **foreign** row's URI if the id collided |
| `apps/worker/src/activities/attempts.ts:142` | `findFirst where {workflowRunId}` | `workflowRunId` is not tenant-forgeable via the API | A worker path that accepts a caller-supplied `workflowRunId` |

**Structural fix (preferred over "add orgId to five queries"):** change these to
`updateMany({where:{id, orgId}})` + insert-if-zero, so the predicate is the guard rather than
an earlier read. Then add the invariant in §2.6 so the seventh one cannot appear.

## 2.4 Content segregation (the gap the gate row does not name)

`artifact-locator.ts:63-112` resolves a stored `uri` against configured roots with correct
containment and `realpath` checks *(read)*. But the roots are **flat with respect to tenant**:
there is no per-tenant root, no `orgId` prefix in the path, and no check at write time that a
`uri` belongs to the writing tenant's prefix. The only thing standing between tenant A and
tenant B's bytes is the single `Artifact` row's `orgId`.

A worker that is compromised or buggy can therefore persist a row in org A whose `uri` points
at a file under org B, and `GET …/content` will stream it after a passing `orgId` check. This
is a tenant-to-tenant disclosure that requires Gate A's threat (worker code execution), so the
two gates compose. It is **NOT TESTED**; it is read from the resolver and the write path.

Recommendation: make the layout `<root>/<orgId>/<taskId>/…`, reject at write any `uri` whose
resolved path is not under the writing tenant's prefix, and keep the read-side check. Cheap,
and it converts "one row is the whole boundary" into two independent separators.

## 2.5 The adversarial suite

New file: `apps/api/test/tenant-adversarial.e2e-spec.ts`, reusing the existing two-tenant
fixtures (`apps/api/test/helpers/database.ts:149-200`: `orgA`, `orgB`, `ownerA`, `memberA`,
`viewerA`, `ownerB`). One authenticated user per role per tenant; the attacker is always a
*legitimate member* of org A substituting an org B id, because that is the case the guard does
not cover by design.

| # | Case | Assertion | Today |
|---|---|---|---|
| M-1 | Cross-tenant id substitution, every resource: `taskId`, `projectId`, `attemptId`, `artifactId`, `approvalId`, `workspaceId` from org B, token+header of org A | 404 for each; body contains no org-B identifier, name, or count | Partly — task (`auth-tenancy:123`), attempt (`executions:345`), approval (`approval-attempt-binding:440`). **Missing: artifact, artifact content, project write, workspace** |
| M-2 | Cross-tenant **write**: `PATCH /tasks/:id`, `POST /run`, `POST /cancel`, `POST /projects`, `POST /approvals/:id/revoke` with an org B id | 404 **and** the org B row is byte-identical after (read back with a second client as `ownerB`) | **Not covered** |
| M-3 | Cross-task within one tenant: attempt of task X named under task Y | Refused; attempt unchanged | Partly — approval/attempt mismatch (`approval-attempt-binding`), not the general case |
| M-4 | Cross-attempt: attempt 1's id used to complete/cancel attempt 2 | Refused; attempt 2's state unchanged | **Not covered** |
| M-5 | Artifact replay: org A artifact id requested with org B credential; org B artifact bytes must not appear | 404, zero bytes (assert `content-length`/body, not just status) | **Not covered** — no artifacts e2e file exists |
| M-6 | Approval replay: a consumed approval re-submitted; an org A approval named in an org B decision; the Phase 6 one-shot claim replayed across attempts *of different tasks* | Refused with the specific code; `consumedAt` unchanged | Partly — same-task replay and foreign id are covered; cross-task replay is not |
| M-7 | Claim theft: an attempt of org B adopted/claimed by a workflow started with `orgId` A, and the inverse | `EXECUTION_CLAIM_REFUSED`; attempt stays `queued`, `claimedByWorkflowRunId` null | **Not covered** — the predicate is org-scoped (`claim.ts:308-320`) but no cross-tenant test exercises it |
| M-8 | Enumeration oracle: for each resource, compare (a) org A id that does not exist, (b) org B id that exists, (c) org A id that exists | (a) and (b) indistinguishable in status **and** body shape; 403 reserved for "you are not a member of the org you named" only | **Not covered systematically** |
| M-9 | Duplicate/conflicting `X-Org-Id` headers (`X-Org-Id: A` twice, and `A` + `B`) | Rejected, not "first wins" — `firstHeaderValue` takes `[0]` (`org-scope.guard.ts:104`) | **Not covered**; current behaviour is silently first-wins |
| M-10 | Worker write with mismatched pair: `persistResult({orgId: A, taskId: <B>})` | No foreign row written; the call refuses | **Not covered** |

M-9 and M-10 are the two cheapest and highest-value cases; M-2 is the one an attacker would
actually use, because a 404 on a write is indistinguishable from a 404 on a read only if the
row is verified unchanged.

## 2.6 The durable control (why tests are not enough)

Fifteen tests will not stop the 120th query. Add both:

1. **A static invariant in CI**: a script that parses `apps/api/src` and `apps/worker/src` for
   Prisma model access on tenant-owned models (`Task`, `Project`, `Workspace`, `AgentRun`,
   `Artifact`, `Evidence`, `ExecutionAttempt`, `ExecutionWorkspace`, `ApprovalRequest`,
   `ToolInvocation`, `WorkflowRun`, `AuditEvent`) and fails if the `where` clause does not
   contain `orgId` — with an explicit allowlist for the six paths in §2.3 and for
   system-level sweeps (the reaper). This is 80 lines of TypeScript and it is the only control
   here that scales.
2. **Postgres RLS** as the structural backstop: `SET LOCAL app.org_id` per transaction, policies
   on every tenant table, `FORCE ROW LEVEL SECURITY`. There is **no RLS today** — no
   `CREATE POLICY` in any migration *(measured)*. This is the only control that survives an
   application bug, a new endpoint, and a direct psql session. Cost: every query must run
   inside a transaction that sets the GUC, and the worker's system sweeps need a bypass role.
   That is real work; the invariant in (1) is the cheap 90%.

Note what RLS does **not** do: the worker's `orgId` comes from workflow input
(`execute-agent.ts:194`, `persist-result.ts:68`), which a compromised worker controls
entirely. Tenant isolation is an **API-edge** property. RLS narrows the worker's reach to one
tenant per transaction; it cannot make a compromised worker honest about *which* tenant.

---

# 3. Ordering

**Recommendation: Gate A first — but not all of it, and not behind a flag.**

Split A into two halves and do the cheap half immediately:

| Order | Work | Cost | Blocking |
|---|---|---|---|
| **0** | Remove uid 1000 from `sudo`, `lxd`, `adm`; delete the `NOPASSWD` rule | minutes, no code | Nothing. **Highest risk reduction in the brief.** |
| **1** | Gate M's static invariant (§2.6.1), M-9, M-10, M-2, and the §2.3 write-scope fixes | ~1 day, no host change | Nothing |
| **2** | The rest of the Gate M suite (M-1, M-3…M-8) | ~2 days | Nothing |
| **3** | Gate A: store relocation + broker unit + peer check + client cutover | days, host work | Step 0; sign-off on removing the operator's sudo |
| **4** | Delete the in-process path; sandbox uid split; A-1…A-5 as gates | days | Step 3 |
| **5** | RLS, or a separate host (blocked: no KVM) | weeks | Product decision |

**Why A before M, given M is fully closable now:** the measured exposure is asymmetric.
Gate A's failure mode is *irreversible* — one worker-level RCE yields root (§0), the whole
1.1 GB store (every provider credential plus the operator's session history), and every
tenant's rows. Gate M's failure mode today is *latent*: there is no known unscoped query in
`apps/api/src`. Deferring M risks a future bug; deferring A risks a present one. That is why
step 0 and step 1 ship together — the M work in step 1 is cheap enough that sequencing it
behind A would be gratuitous, but it should not be allowed to delay step 0.

**Risk each defers.**

- *Deferring Gate A:* a compromised dependency, adapter, or host-side SSRF gets every
  provider key and the operator's identity in one read, then root. Rotation is possible;
  un-disclosing the data is not. Also deferred: the broker stays an in-process library, so
  every future adapter change is a new chance to touch the store.
- *Deferring Gate M:* the code is correct today and the guard is well designed, so the
  concrete risk is a *regression*: a new endpoint copies a service method, drops `orgId`, and
  a 404 becomes a 200. The static invariant (step 1) reduces this from "silent" to "CI red" for
  one day of work, which is why it is not deferred with the rest.
- *Deferring step 4 (the fallback deletion):* Gate A stays **PARTIAL** no matter how good the
  broker unit is. A flag that can fall back to in-process is a code path that reads the store,
  and the enforcement test would have to prove a negative about live code. Do not report A as
  enforced while the fallback exists.
- *Doing A before M-2 (cross-tenant writes):* if a real cross-tenant *write* vulnerability
  exists and is found after custody lands, the phase will have spent its budget on a boundary
  that did not stop the thing that actually happened. This is the argument for step 1 preceding
  step 3, and it is why step 1 is scoped to the five highest-value M cases rather than the
  whole suite.

---

# 4. What is NOT TESTED, and cannot be from here

| Item | Why | How to close |
|---|---|---|
| That uid 1000 cannot read the store **after** the migration | Requires creating identities and moving files — forbidden in this phase | A-1, A-2 after steps 3–4 |
| That `SO_PEERCRED` rejects an unauthorized peer | No broker service exists to test; no second uid exists | A-4, with a connectable-but-unauthorized uid |
| The sandbox's host uid | `bwrap` not setuid and no `--uid` in argv, so **inferred** 1000; not launched | Run a probe in the sandbox and print `process.getuid()` |
| That §0 (`sudo`) is exploitable from a *worker-process* context rather than an interactive shell | Measured from an interactive shell; a worker child inherits the same uid and PAM/sudoers do not distinguish | Run A-3 with `setpriv` as uid 1000 |
| Cross-tenant behaviour of the artifact **content** path | No artifacts e2e file exists; the resolver was read, not exercised | M-1, M-5 |
| Whether more than one tenant exists in any real deployment | No production access; `orgA`/`orgB` are test fixtures | Ask the operator. **This changes M's urgency, not its design.** |
| RLS feasibility against the worker's system sweeps | No RLS exists; the reaper iterates across tenants by design | Design spike before scheduling |
| Any claim about a separate host/VM | No `/dev/kvm`, no `vmx`/`svm` | New hardware. Blocked, as Gate F already records |

---

## Appendix — commands used to establish the Gate A baseline

```bash
id
stat -c '%n mode=%a owner=%u:%g' /home/ubuntu /home/ubuntu/.local \
  /home/ubuntu/.local/share /home/ubuntu/.local/share/opencode
ls -ln /home/ubuntu/.local/share/opencode/
sudo -n whoami; sudo -n -l
grep -n "startEgressBroker" packages/agent-runtime/src/runtimes/opencode-cli.ts
grep -n "chmod(socketPath\|BROKER_SOCKET_NAME" packages/egress-broker/src/broker.ts
grep -n "readCredential" packages/egress-broker/src/broker.ts
grep -rn "SO_PEERCRED\|peercred" --include=*.ts .        # no hits
grep -rin "CREATE POLICY\|ROW LEVEL SECURITY" packages/database/prisma/migrations   # no hits
ls -l /dev/kvm; grep -cE 'vmx|svm' /proc/cpuinfo        # absent; 0
```
