# Phase 4 — Security Results (Gate G, independent adversarial audit)

**Date:** 2026-11-14 · **Branch:** `phase-4/execution-trust` (uncommitted) · **Auditor:** independent; wrote none of this code.
**Method:** read the source, then attempt the attack. Every result below is a command that ran in this session unless marked `code-read`.
**Scope:** credential broker, sandbox/state mounts, workspace containment and reclaim, worker cgroup/termination/reaper, server-derived risk and approval binding, artifact provenance, redaction.

---

## 1. Verdict

# CONDITIONAL PASS

The architecture is sound and most controls survive a real attack. Two of the strongest claims do not survive as implemented:

- **Gate A (credential isolation) is bypassed by a second sandbox.** The agent's own sandbox genuinely holds no credential — that measured true. But two other `bwrap` invocations (`collectWorkspaceEvidence`, `readHeadSandboxed`) are spawned without an explicit environment, so the worker's entire environment is readable at `/proc/1/environ` inside them. Combined with a repo-controlled git filter, that is a complete disclosure path ending in a **member-downloadable artifact**. Demonstrated end to end (§3, F1).
- **Gate B (resource enforcement) is correct but not in force by default.** The capability probe refuses to claim enforcement unless a real process can be migrated, and it returns `unavailable` from a normal shell on this host. Enforcement works when the worker is started through the documented wrapper (verified). Nothing forces that wrapper to be used.

Everything else measured strong: the broker boundary, host-execution containment, path containment/reclaim, cgroup honesty, artifact integrity. **I would not ship F1.**

| Gate | Claim | Verdict |
|---|---|---|
| A — credential isolation | sandbox holds no credential | **FAIL as implemented** (F1); the primary sandbox alone is clean |
| B — resource enforcement | aggregate limits enforced | **PASS under the wrapper, unverified by default** (no default is a silent `rlimit-only`) |
| C — authorization | server-derived, bound, single-use | **PASS at the API**, weaker at the worker (F4) |
| D — evaluation | harness exists | not attacked (out of scope for exploitation) |
| E — lifecycle | reaper safe, idempotent | **PASS** |
| F — provenance | artifact integrity | **PASS** |
| G — audit | this document | — |

---

## 2. What was actually executed

| Probe | What it did | Result |
|---|---|---|
| `probe1/2` | built the **production** sandbox argv from `buildRuntimeSandbox` and read every credential path from inside | all absent; `/proc/1/environ` = `PATH`,`LANG` only |
| `probe4` | planted hooks + `core.fsmonitor` + `diff.external` + `.gitattributes`, ran `collectWorkspaceEvidence` | no host execution; **negative control fired** |
| `probe7/8` | full chain: agent writes `.git/config`, worker runs the evidence git | **worker env disclosed into `diff.patch`** |
| `probe9/10` | live broker against a stub upstream: forged tokens, path/method abuse, `CONNECT`, absolute-form, header smuggling | boundary held; 2 low gaps |
| `probe3/16/17/18` | cgroup probe against a plain dir, a symlink, a root-owned root, a delegated leaf; limits; placement; kill | false-positive avoidance and kill both hold |
| `probe11/11b` | `classify()` with client `LOW` on destructive text; DTO with server-owned fields | derived `CRITICAL`; fields stripped |
| `probe12` | `reclaimWorkspace` with `..`, absolute ids, symlinked parent, cross-tenant `rootPath` | all refused; sibling intact; idempotent |
| `probe13` | artifact locator with traversal, symlink-to-sibling-tenant, symlink-outside, absolute; checksum substitution | all refused; substitution → `failed` |
| `probe14/15` | redaction against JWT, `sk_live_`, AWS secret, `glpat-`, DB URL | **3 of 5 families uncovered** |

Not executed, and therefore not claimed: the live HTTP authorization suite (needs `JWT_SECRET`), a real model run (no spend), and a real end-to-end worker attempt. Those are marked `code-read` below.

---

## 3. Findings

### F1 — HIGH (ship blocker) · Worker environment reaches the evidence sandbox, and agent-controlled git config turns it into a credential disclosure into a member-readable artifact

**Where**

- `packages/agent-runtime/src/runtimes/opencode-cli.ts:399` — `execFileAsync(command.file, [...command.args], { timeout, maxBuffer })`
- `packages/workspace-manager/src/manager.ts:213` — same shape in `readHeadSandboxed`

**The defect.** Both build a correct `bwrap` argv (read-only root, `--unshare-net`, `--clearenv`) but spawn without `env:`. `bwrap` therefore inherits the **worker's** entire environment. `--clearenv` only clears the environment of the payload, not of `bwrap` itself, and `bwrap` is PID 1 in the sandbox's PID namespace — so `/proc/1/environ` inside the sandbox is the worker's environment.

The main run path gets this right and is the contrast that proves the intent:

```ts
// opencode-cli.ts:1111-1113
// bwrap inherits this, then `--clearenv` inside drops all of it. Passing a
// minimal env means even a bwrap bug would not forward the host's secrets.
env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C.UTF-8' },
```

**The second primitive.** `collectWorkspaceEvidence` runs `git status` in a workspace the agent has full write access to. The `.git` directory is inside that workspace (`manager.ts:331` clones into `repo`, and `/workspace` is an rw bind). A repository `.git/config` filter is executed by `git status`:

```gitconfig
[filter "evil"]
    clean = sh -c '...; cat'
    required = true
```
```gitattributes
*.ts filter=evil
```

`core.fsmonitor` and `diff.external` are correctly overridden by `SANDBOX_GIT_CONFIG`; `filter.*.clean` is not, and `status` needs it to decide whether the worktree differs from the index. Measured: **fires** (§probe6). `git diff --no-textconv` does not fire it.

**Reproduction (measured).** Agent sandbox writes the filter; worker then produces the diff artifact.

```sh
# 1. agent, inside its own sandbox
cd /workspace
git config filter.evil.clean 'sh -c "printf \"\\n// env: \"; tr \"\\0\" \"|\" < /proc/1/environ; printf \"\\n\"; cat"'
git config filter.evil.required true
printf '*.ts filter=evil\n' > .gitattributes
printf 'export const x = 2;\n' > app.ts
```
```ts
// 2. worker, unmodified production function
await collectWorkspaceEvidence({ workspaceRoot: base });
```

**Result**

```
evidence produced: 3986 bytes
sentinel appears in the diff artifact that becomes diff.patch: YES — CREDENTIAL IN ARTIFACT
+// env: DATABASE_URL=...|JWT_SECRET=...|REDIS_URL=...|AUDIT_PROVIDER_KEY=sk_live_***MASKED***|...
```

A synthetic `sk_live_…` sentinel placed in the parent process environment appeared verbatim in the diff. 47 variables were disclosed in total.

**Why it reaches the attacker.** `writeArtifacts` persists that string as the `diff` artifact (`opencode-cli.ts:1176-1188`). `ArtifactsService.content` gates **only** `transcript` behind ADMIN (`artifacts.service.ts:90-93`); the diff is served to any authenticated member of the org — the refusal message says so explicitly: *"The raw transcripts require ADMIN… The redacted diff and report artifacts remain available."*

**Impact.** Disclosure of the worker process environment to any member of the org that owns the task. In the default `opencode-db` credential mode this is not the provider key, but it is `DATABASE_URL`/`JWT_SECRET`-class material, which is a platform-wide compromise once it leaves the host. In the **documented and recommended** `AGENT_BROKER_CREDENTIAL_KIND=env` mode (`credential.ts:43-52`), the provider key itself is in that environment, and this is Critical-grade.

**Preconditions, stated honestly.** The task must cause the agent to write `.git/config` and `.gitattributes`. On an untrusted repository that is a `file_write`, so D-006 derives `HIGH` and requires an ADMIN approval. The approval is on the task *text*, and "add a formatter filter to `.gitattributes`" reads as ordinary build tooling — so the human step is a speed bump, not a control. Not reachable with zero human interaction.

**Remediation**

```ts
// collectWorkspaceEvidence — identical fix at manager.ts:213
const { stdout } = await execFileAsync(command.file, [...command.args], {
  timeout,
  maxBuffer,
  // Same rule as the run path: bwrap must not inherit the worker's environment,
  // because bwrap is PID 1 in the sandbox and /proc/1/environ is readable.
  env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
});
```

Do this in `buildSandboxCommand`'s callers **and** add `-c filter.<driver>.clean=`-style defence by running the evidence git with `GIT_CONFIG_NOSYSTEM=1`, a per-invocation `GIT_CONFIG_GLOBAL` (already present), and `--no-optional-locks`; better, drop `filter` execution entirely by using `git status --porcelain=v2 --no-ahead-behind` with `-c core.attributesFile=/dev/null` **and** reading the index/worktree comparison via `git diff --raw` (which does not apply clean filters). A single call site is not enough — make `env` a required field of the sandbox builder so the next caller cannot omit it.

---

### F2 — MEDIUM · The worker's "unbypassable" approval re-check enforces only `status = APPROVED`

**Where:** `apps/worker/src/activities/validate-task.ts:69-96`

```ts
const approved = await db().approvalRequest.findFirst({
  where: { orgId: input.orgId, taskId: task.id, status: 'APPROVED' },
  select: { id: true },
});
```

The comment above it claims this is *"the gate that cannot be bypassed"*. It ignores `consumedAt`, `revokedAt`, `expiresAt` and `taskContentHash`, all of which the API gate enforces (`approval-gate.service.ts:152-250`). So a workflow started directly against Temporal — bypassing `POST /run` — is authorised by a grant that is already spent, expired or revoked, or by content the approver never saw.

**Measured?** No. This is `code-read` plus the existing DB shape; I did not start a Temporal workflow. **Precondition:** the ability to start a workflow on `127.0.0.1:7233`, which has no authentication. Not reachable from inside the sandbox (`--unshare-net` gives it its own loopback) and not reachable by a tenant through the API.

**Remediation:** make the worker reuse `ApprovalGateService.requireLiveApproval` semantics, or at minimum add the four predicates above and compare `taskContentHash` against a recomputation from the task row. If that is too much coupling, refuse to run when `consumedAt` is non-null and require the API to pass the reserved `approvalId` in the workflow input, then assert `id` matches.

---

### F3 — LOW · Redaction does not cover three of the five required secret families

**Where:** `packages/agent-runtime/src/redact.ts:29-60`; blind spot in `packages/agent-runtime/test/opencode-cli.test.ts:283`

| Secret family | Required | Measured |
|---|---|---|
| JWT | yes | **redacted** |
| DB URL with credentials | yes | **redacted** |
| `sk_live_` / `sk_test_` | yes | **NOT redacted** — `\bsk-` (hyphen) does not match `sk_` |
| AWS secret access key | yes | **NOT redacted** unless preceded by `aws_secret_access_key =` |
| `glpat-` | yes | **NOT redacted** unless preceded by a `KEY|TOKEN|SECRET|PASSWORD` word |

```
bare sk_live_     *** NOT REDACTED ***  -> the key is sk_live_​sample00000000000000000000000 ok
bare glpat-       *** NOT REDACTED ***  -> clone with glpat-00EXAMPLE000000000000000 please
bare aws secret   *** NOT REDACTED ***  -> wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY
```

The test suite cannot catch this because its sample is `sk-live-abcdef123456` — a hyphen, which the `sk-` pattern does cover — and its assertion repeats the same spelling. The control and its test share the same typo.

**Remediation:** add `/\bsk_(?:live|test)_[A-Za-z0-9]{10,}/g`, `/\bglpat-[A-Za-z0-9_-]{20,}/g`, and `/\b[A-Za-z0-9/+=]{40}\b/g` (AWS secret is 40 base64 chars; this last one will also catch other 40-char base64 blobs, which is the correct direction of error). Add `sk_live_`, `glpat-` and a bare AWS secret to the fixture list.

---

### F4 — LOW · Broker forwards client-controlled `x-forwarded-*` and provider-scoped headers upstream

**Where:** `packages/egress-broker/src/broker.ts:522-531` (allowlist is a *strip* list)

Measured: a sandbox request carrying `x-forwarded-host: evil.test`, `x-forwarded-proto: https` and `openai-organization: victim-org` delivered all three to the upstream, alongside the injected real key. Auth, cookies and hop-by-hop headers *are* correctly stripped and the client `authorization` is correctly replaced.

The broker's own destination cannot be redirected (verified: `CONNECT` gets no response; absolute-form and `//evil.test/...` are normalised onto the configured upstream; the upstream saw `host: 127.0.0.1:<port>` every time). The residual is that a provider or intermediary that trusts `X-Forwarded-*` — or a provider key that is valid for several organisations — is reachable with attacker-chosen values from inside the sandbox.

**Remediation:** reverse the list. Forward an allowlist (`content-type`, `content-length`, `accept`, `user-agent`), not "everything except". Drop `x-forwarded-*`, `forwarded`, `openai-organization`, `x-stainless-*` unless explicitly configured.

---

### F5 — LOW · `/proc/self/cgroup` inside the sandbox discloses the host cgroup path

Measured: `0::/user.slice/user-1000.slice/user@1000.service/<session>.scope`. In production this reveals the attempt cgroup name (the workspace id) and the host's slice layout. No escalation by itself. Add `--unshare-cgroup` (bwrap ≥ 0.8) to remove the disclosure.

### F6 — INFO · Broker lifecycle and budget accounting

- `broker.ts:648` listens without unlinking a stale socket: a worker that dies without `close()` leaves `broker.sock`, and a retry into the same `socketDir` fails `EADDRINUSE` (reproduced). Per-attempt directories make this rare; `unlink` before `listen` removes it.
- `broker.ts:559-566` destroys the upstream response at the response ceiling without decrementing `inflight` (the decrement lives in `on('end')`, which `destroy()` does not fire). Four oversized responses permanently exhaust the concurrency budget and the attempt is refused with `429`. Self-DoS only, no cross-attempt effect.
- `collectWorkspaceEvidence` swallows every error into `return null` (`opencode-cli.ts:427-429`), so a git failure silently produces a run with no diff artifact. Fail-visible would be better than fail-silent for an evidence control.

---

## 4. Claim-by-claim: what is claimed, what I measured

| # | Control claimed | Measured truth | Evidence |
|---|---|---|---|
| 1 | Sandbox cannot read `~/.local/share/opencode`, `opencode.db`, `auth.json` | **True** on the run path. All four paths absent; `/home` does not exist in the mount namespace; `/xdg-data/opencode` is an empty ephemeral dir | probe1/2 |
| 2 | `/proc/1/environ` and worker argv are not reachable | **True on the run path** (`PATH`,`LANG` only; PID 1 is `bwrap`, 4 pids, `NSpid: 1`). **False on the evidence path** (F1) | probe2, probe7 |
| 3 | Broker rejects missing/forged/other-attempt tokens | **True** — 403 `BROKER_TOKEN` for all three | probe9 |
| 4 | Caller cannot name an unapproved upstream | **True** — exact path allowlist; `/v1/files`, `..`, `/v2/…`, `/` all 403; absolute-form and `//evil.test/…` normalise to the configured upstream (verified at the stub) | probe9/10 |
| 5 | Broker logs contain no secret | **True** — 17 lines, no key, no canary; the log shape cannot hold either | probe9 |
| 6 | No host-side git against agent-writable content | **True**, with a **valid negative control** (payload fired under plain host git, did not fire under `collectWorkspaceEvidence`) | probe4 |
| 7 | Client `riskClass` is evidence, never input | **True** — `LOW` on deploy content → `CRITICAL`, `clientAttemptedDowngrade=true`, audit signal present; omitting it → `CRITICAL` | probe11 |
| 8 | Client cannot set `riskSource`/`derivedRiskClass`/`riskPolicyVersion`/`riskFactors` | **True** — accepted by `.strict()` then stripped; only `riskClass` survives, unused; unknown keys rejected | probe11b |
| 9 | Approval is tenant-scoped, single-use, bound, expiring | **Code-read: holds.** Gate queries `{orgId, taskId}`; CAS has `id+orgId+status+consumedAt null+revokedAt null`; `taskContentHash` mismatch → 409 | `approval-gate.service.ts:127-250` |
| 10 | `PATCH → queued` cannot spend or bypass a grant | **Code-read: holds** — `consume:false`, then `409 TRANSITION_IS_SYSTEM_MANAGED` | D-006 §6 |
| 11 | Worker re-checks approval so an API bypass is a courtesy | **False** — checks `status='APPROVED'` only (F2) | `validate-task.ts:69` |
| 12 | cgroup probe never claims `enforced` for a non-cgroup2 path | **True, and this is the strongest control measured.** Plain dir → `CGROUP_NOT_CGROUP2` with the actual magic; symlink to a plain dir → same; root-owned `/sys/fs/cgroup` → `CGROUP_ROOT_NOT_WRITABLE`; non-delegated tree → `CGROUP_MIGRATION_DENIED` with a full explanation | probe3 |
| 13 | `memory.swap.max` is 0, so `memory.max` is a hard ceiling | **True where enforced** — read back `"0"` on a real cgroup on a host with 4 GB swap in use | probe16/18 |
| 14 | A process cannot leave its attempt cgroup | **True, by mount namespace** — `/sys` does not exist in the sandbox, so `cgroup.procs` is unreachable. Descendants inherit (`pids` showed parent + grandchild) | probe18/19 |
| 15 | `cgroup.kill` reaches descendants | **True** — grandchild dead after `cgroup.kill`; `runInProcessGroup` settled | probe18 |
| 16 | Reaper cannot delete an active workspace, a sibling, or a path with `..`/symlink | **True** — `..`, absolute ids, cross-tenant `recordedRootPath`, symlinked ancestor all refused; sibling org intact; second pass idempotent; live workflow → `skipped_live`, Temporal unknown → `skipped_unknown` | probe12, `reaper.ts:248-282` |
| 17 | Artifacts are tenant-scoped, integrity-checked, not traversable | **True** — traversal, absolute, symlink-to-sibling-tenant and symlink-outside all refused; substituted bytes → `failed` → 409 `ARTIFACT_INTEGRITY_FAILED`; outside-root → 404 (no existence oracle) | probe13 |
| 18 | Transcripts are redacted at collection | **Partial** — 8 of 11 families covered; `sk_live_`, bare `glpat-`, bare AWS secret are not (F3) | probe14/15 |
| 19 | Broker is a destination boundary, not a content filter | **True and honestly documented** | probe9 |
| 20 | No secrets in the repository | **True** — `.env` untracked; the only key-shaped strings are synthetic fixtures | `git ls-files`, grep |

---

## 5. Residual risks, in plain language

1. **The sandbox shares the host kernel and the worker's uid.** There is no `--unshare-user`, no seccomp filter and no LSM profile. `CapEff` is `0` and `mknod` fails, but `unshare -U` succeeds inside the sandbox. Namespace isolation is a strong fence, not a boundary: a kernel bug in the syscall surface the agent can reach is an escape. This is a known, accepted limitation and it is stated once here, not re-litigated per finding. A production deployment needs a seccomp allowlist and either a distinct uid per tenant or a VM/microVM boundary.

2. **The credential boundary now depends on every call site remembering `env:`.** F1 is that dependency failing. The fix is not the two `env:` lines; it is making the environment a required argument of the sandbox builder so it cannot be omitted.

3. **Gate B is opt-in.** `detectCgroupCapability()` returns `unavailable` from an ordinary shell on this host (measured), and the worker then records attempts as `rlimit-only` and refuses `HEAVY`. That is honest — but a production deployment that forgets `worker-with-cgroup.sh` runs with rlimits only, and rlimits do not bound an aggregate. Nothing at boot fails closed; it degrades quietly and correctly.

4. **Risk classification is a lexical filter.** `MEDIUM` requires no approval at all (`requiresApproval` is `HIGH|CRITICAL`), and `MEDIUM` is the floor for any task whose repository is not allowlisted — which is every task by default. So the approval gate fires only when the task text contains the matched vocabulary. A task phrased to avoid it needs no human at all. D-006 §9.5 accepts false negatives deliberately; the consequence is that the gate protects against careless work, not against a motivated author.

5. **The gate's multi-row fall-through assumes one approval row per task.** The gate iterates newest-first and falls through to any older live matching grant, so revoking the newest would not stop a run authorised by an older one. This is not reachable today — `approvalRequest.create` exists only in task creation and there is no re-request endpoint — but the day a re-request endpoint is added, revocation silently stops working. Add `@@unique([orgId, taskId])` or make the gate refuse on multiple live grants.

6. **Pre-Phase-4 rows are still trusted at their client-asserted class** (D-006 §9.2). Enumerate `WHERE riskSource='client'` and re-create them; that is a data-policy act, not this unit's.

7. **No approval-expiry sweeper.** An expired grant sits `APPROVED` until something asks. Data hygiene, not a bypass (the gate refuses it).

8. **A production deployment still requires:** a distinct uid or VM boundary per tenant; seccomp; a Temporal listener that is authenticated and not on `127.0.0.1`; the DB role separated from the worker's credential store; a secret manager in place of `opencode.db`; and F1/F3 closed before any of it matters.

---

## 6. The single most dangerous thing remaining

**An agent that can write `.git/config` can read the worker's environment through the evidence sandbox, and the result is written into a diff artifact that any member of the org can download.**

---

# 7. Remediation record (appended after the audit)

**Appended by:** the implementation author, 2026-11-14. **The findings in §1–§6 are unchanged.**
They are the auditor's record of the tree as it was found. This section records what was changed,
what was measured afterwards, and what remains open. Nothing above was edited to agree with the
fix.

## 7.1 Verdict history

| Point in time | Gate A | Overall | Basis |
|---|---|---|---|
| Audit, pre-fix | **FAIL as implemented** (F1) | CONDITIONAL PASS | Worker environment reached the evidence sandbox and landed in a member-readable `diff.patch` |
| Post-remediation (this section) | **PASS with residuals** | **CONDITIONAL PASS** | F1 closed with a required-field change and a negative control; F2 and F3 closed; F4–F6 open and accepted as LOW/INFO |

The overall verdict does **not** become PASS. A conditional pass is the correct grade while F4–F6
are open, cgroups are opt-in, and the deployment has no seccomp, no per-tenant uid and no real
baseline. Closing a ship blocker changes the gate, not the product's readiness.

## 7.2 F1 — worker environment reached the evidence sandbox (HIGH, ship blocker) → CLOSED

**Root cause.** Not "a missing `env:` line". The root cause is that the sandbox command carried
its environment as an *optional* field, so two of three call sites omitted it and inherited the
worker's. `bwrap` is PID 1 in the sandbox's PID namespace, so `--clearenv` does not help: the
payload is cleared, the parent process is not.

**Fix, in three parts.**

1. `SandboxCommand.env` is **required** (`packages/workspace-manager/src/sandbox.ts`). A caller
   cannot construct a command without declaring the environment.
2. `buildSandboxCommand` derives the spawn environment through `sandboxSpawnEnv` — an allowlist of
   `PATH`, `LANG`, `HOME`, `TMPDIR`, with a rejected-key list — and returns it as `command.env`.
3. `execSandboxed` is the only sanctioned spawn: `execFile(command.file, command.args, { env:
   command.env })`, never `shell: true`. Both former offenders now use it:
   `collectWorkspaceEvidence` (`opencode-cli.ts:417`) and `readHeadSandboxed`
   (`manager.ts:228`).

**Proof.**

| Test | What it asserts | Result |
|---|---|---|
| `sandbox-env-isolation.test.ts` — "proves the fixture can leak: the old call shape puts the canary in the diff" | The **negative control**: `execFile(file, args)` with no `env` must leak `IZ_CANARY_SECRET` into the diff | passes — the control leaks |
| "collects evidence through the production path with no canary in the patch" | The production function must not | passes |
| "shows pid 1 inside the sandbox carries the allowlist and nothing else" | `/proc/1/environ` = `PATH`, `LANG` | passes |
| "produces no transcript line carrying the worker environment" | Second canary (`IZ_WORKER_MARKER`) that `redact` does not match | passes |
| "keeps the legacy shape leaking even for the marker, so the control above is real" | The control is sensitive for the non-redactable marker too | passes |
| `sandbox.test.ts` — "gives the bwrap process an allowlisted environment, never the parent's" | Structural assertion on the builder | passes |
| `sandbox.test.ts` — "execSandboxed passes command.env only" | The helper cannot widen it | passes |

**Residual, stated plainly.** Repository-defined git filters still **execute** inside the evidence
sandbox. The fix removes the confidentiality leak (the worker's environment is no longer there to
read); it does not remove the agent's ability to run a filter. What remains is an integrity
question — the diff is the filter's output — not a disclosure of platform secrets. Removing filter
execution entirely (`-c core.attributesFile=/dev/null`, `git diff --raw`) was specified by the
auditor as the stronger form and was **not** implemented in this pass. It is recorded here rather
than claimed as done.

## 7.3 F2 — worker approval re-check enforced only `status` (MEDIUM) → CLOSED

**Fix.** `apps/worker/src/activities/validate-task.ts` now evaluates the same five predicates as
the API, in a documented order: unrevoked (a newer revocation vetoes), unexpired, `APPROVED`,
`consumedAt IS NOT NULL` (the API reservation must already exist), and `taskContentHash` equal to
the hash of the task **as it is now**, imported from the same module the API uses. Refusals are
`ApplicationFailure`s with distinct codes: `APPROVAL_REQUIRED`, `APPROVAL_NOT_RESERVED`,
`APPROVAL_REVOKED`, `APPROVAL_EXPIRED`, `APPROVAL_UNBOUND`, `APPROVAL_STALE`, `APPROVAL_CONSUMED`.

The worker deliberately does **not** consume. Consumption is the API's single-writer
responsibility; a second writer turns a single-use grant into two.

**Proof.**

| Test | What it asserts |
|---|---|
| `approval-grant.test.ts` (13 tests) | Each predicate isolated: no approval, unreserved, revoked-after-consumption, expired, no hash, different content, content changed after approval; plus the happy path and "the worker does not consume" |
| `approval-grant.test.ts` — "vetoes on a revocation newer than the grant" | No fall-through to an older live grant |
| `approval-direct-start.test.ts` (4 tests) | A **real Temporal workflow** started with the client and no API call is refused for expired, never-reserved, revoked and unbound grants, and never invokes the agent |
| `approval-bypass.test.ts` (1 test) | The missing-approval case |

**Residual.** `consumedAt` proves a reservation happened, not that **this** run made it. Binding
the reservation to the workflow requires passing the reserved `approvalId` in the workflow input
and asserting equality. Not implemented; recorded.

## 7.4 F3 — redaction missed three secret families (LOW) → CLOSED

**Fix.** `packages/agent-runtime/src/redact.ts` adds:

| Family | Pattern |
|---|---|
| Stripe-style secret | `\bsk_(?:live|test)_[A-Za-z0-9]{8,}` |
| GitLab token | `\bglpat-[A-Za-z0-9_-]{20,}` |
| AWS secret access key | `((?:aws[_.-]?)?secret[_.-]?access[_.-]?key)["']?\s*[=:]\s*["']?[A-Za-z0-9/+=]{40}` |

The AWS rule is anchored on the **name**, as before; a bare 40-character base64 value with no
label is still not matched, and that is a deliberate limit rather than an oversight: an unlabelled
40-char base64 blob is also a checksum, and redacting every one would destroy diffs without
proving safety.

**Proof.** The fixture list now contains bare `sk_live_…`, bare `glpat-…` and a labelled AWS
secret, and the table-driven test asserts each is removed. The previous test shared the typo with
the regex (`sk-live-…`), which is why it passed while the real shape leaked; the new fixtures use
the real shape.

**Residual.** Redaction is pattern-based. It is a mitigation for accidental disclosure in
transcripts, not a guarantee that no secret can appear. The broker log is not redacted; it is
designed so it *cannot* hold one (no headers, no bodies, no tokens).

## 7.5 Class-level fix — spawn discipline as a lint rule (SEC-403)

The F1 class is "a new spawn site forgets `env:`". Fixing two call sites does not close a class.
`eslint.config.mjs` now forbids importing `node:child_process` in every sandbox-boundary package:

```text
packages/agent-runtime/src/**   packages/workspace-manager/src/**
apps/worker/src/**              infra/scripts/**
```

Each exemption must be named in `SPAWN_OWNERS` **with the reason its environment handling is
safe**, so a new spawn site is a visible, reviewed decision rather than an omission. Dynamic
`import()` and `require()` forms are covered by `no-restricted-syntax`, because an import-only
rule is trivially bypassed.

**Proof — `bash infra/scripts/check-spawn-discipline.sh`, exit 0:**

```
ok    bare import in packages/agent-runtime/src — blocked (eslint exit 1)
ok    bare import in apps/worker/src — blocked (eslint exit 1)
ok    bare import in infra/scripts — blocked (eslint exit 1)
ok    dynamic import bypass — blocked (eslint exit 1)
ok    require() bypass — blocked (eslint exit 1)
ok    sanctioned owner stays allowed — allowed (eslint exit 0)
```

A guard that only blocks is half a guard: the sixth case proves it does not simply fail
everything.

## 7.6 Findings deliberately left open

| Finding | Severity | Why it is open | Consequence |
|---|---|---|---|
| **F4** — broker forwards client `x-forwarded-*` and provider-scoped headers | LOW | Outbound headers are still built from a **strip list**, so an unknown header passes | A provider or intermediary that trusts `X-Forwarded-*`, or a key valid across organisations, is reachable with attacker-chosen values. Destination cannot be redirected (verified) |
| **F5** — `/proc/self/cgroup` discloses the host cgroup path | LOW | No `--unshare-cgroup` in the sandbox argv | Reveals the attempt cgroup name and slice layout. No escalation by itself |
| **F6** — socket unlink, `inflight` decrement on destroy, silent git failure | INFO | Operational hardening | Stale-socket `EADDRINUSE` on retry; self-DoS after four oversized responses; a failed evidence git produces a run with no diff instead of a visible failure |

These are reported, not waived. `PHASE-4-TEST-RESULTS.md` §4.3 counts F4 as `NOT IMPLEMENTED` in
the 28-scenario matrix.

## 7.7 Residual risk after remediation

1. **The sandbox still shares the host kernel and the worker's uid.** No `--unshare-user`, no
   seccomp, no LSM. Namespace isolation is a strong fence, not a boundary. This is the top
   residual and it is unchanged by this phase.
2. **Gate B remains opt-in.** A worker started normally records `rlimit-only` and refuses `HEAVY`.
   Honest, but a deployment that forgets the wrapper runs without aggregate limits.
3. **Risk classification is lexical.** `MEDIUM` requires no approval; a task phrased to avoid the
   vocabulary needs no human. D-006 §9.5 accepts this deliberately.
4. **One approval row per task is assumed.** The gate falls through newest-first; a future
   re-request endpoint would make revocation stop working. Add a uniqueness constraint or refuse
   on multiple live grants.
5. **Pre-Phase-4 rows are trusted at their client-asserted class.** Enumerate
   `WHERE riskSource='client'` and re-create them; that is a data-policy act.
6. **No approval-expiry sweeper.** An expired grant sits `APPROVED` until something asks. Data
   hygiene, not a bypass.
7. **A production deployment still requires:** per-tenant uid or VM boundary, seccomp, an
   authenticated Temporal listener, a DB role separated from the worker's credential store, a
   secret manager instead of `opencode.db`, and F4–F6 closed.
