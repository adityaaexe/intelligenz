# Phase 3 Security Results — Sandbox and Real Agent Runtime

**Task:** SEC-301, Unit E
**Branch:** `phase-3/real-agent-runtime`
**Audited tree:** working tree at `43d5c17` + 74 uncommitted/untracked files (40 modified, 2,270 insertions; 56 untracked). Phase 3 has **no commits** on the branch — the audited revision is a dirty working tree, not a reviewable commit.
**Date:** 2026-11-13
**Method:** adversarial code review, real `bwrap` probes through the production `buildSandboxCommand`, direct unit probes of the path/locator/redaction modules, and the existing API e2e suite. No paid model call was made.

> Verification vocabulary: **measured** = produced by a command in this session; **code-verified** = read in source and exercised where stated; **inferred** = follows from code but not executed end to end. Nothing recalled is presented as measured.

---

## 1. Verdict

**FAIL.** The namespace sandbox is real and correctly built. The platform around it is not: the adapter leaves the sandbox to run `git` on the agent's repository, and the agent's repository is executable input to the host.

**The single most dangerous thing:** after every run — including cancelled, timed-out and failed runs — `OpencodeCliRuntime.gitDiff()` executes `git -C <agent-writable repo> status --porcelain` **on the host, outside `bwrap`, as the worker user**, with the worker's full environment (`packages/agent-runtime/src/runtimes/opencode-cli.ts:782-799`). A `.git/hooks/post-index-change` file or `core.fsmonitor` entry written from inside the sandbox executes on the host. This was reproduced end to end: the payload ran as `ubuntu`, wrote the host environment to disk, and `sudo -n` succeeds on this host, so the same hook can become root. The sandbox is escaped without a kernel bug, without network, and without a model choosing to attack anything — a repository instruction is enough.

Two Critical findings. Both must be fixed before this adapter touches a repository that is not fully trusted.

| # | Finding | Severity | Status |
|---|---|---|---|
| F1 | Post-run host `git` on an agent-writable repo → sandbox escape, host RCE, root | **Critical** | Open |
| F2 | All provider credentials and 696 operator sessions readable in-sandbox; raw unredacted transcript served to any org member | **Critical** | Open |
| F3 | No CPU, memory, pid or disk limits; one run can starve the host | High | Open |
| F4 | `network: false` is overstated: agent can use the allowlisted proxy, any port | High→Medium | Open |
| F5 | Approval gate is self-attested; a `MEMBER` can execute unapproved work by labelling it `LOW` | High | Open (policy) |
| F6 | `req.taskId` reaches the filesystem unvalidated → arbitrary write as the worker | Medium | Latent |
| F7 | Artifact writer copies any absolute path an adapter returns | Medium | Open |
| F8 | Artifact locator is root-scoped, not tenant-scoped | Medium | Open |
| F9 | Redaction misses bare JWTs, DB URLs, lowercase `password:`, Stripe/npm/AWS keys | Medium | Open |
| F10 | Token-in-URL clone leaves the credential in `.git/config` readable by the agent | Medium | Deployment footgun |
| F11 | No spend cap by default (`AGENT_MAX_USD` commented out) | Medium | Open |
| F12 | A goal beginning with `-` is parsed as an `opencode` flag; `--help` records a false success | Medium | Open |
| F13 | Cancelled workspaces are never cleaned (full checkout retained) | Low | Open |
| F14 | Workspace reuse ignores the requested source and base commit | Low | Latent |
| F15 | `simulated` consistency is enforced in one direction only | Low | Open |
| F16 | `probeSandbox` is a test, not a runtime gate; `capabilities()` is hardcoded | Low | Open |
| F17 | `repo` is not re-asserted before it is bound into the sandbox | Low | Latent |
| F18 | `executeAgentActivity` does not re-check approval; the claim that it does is false | Low | Open |

Known and already recorded items are **not** re-counted: self-approval, standing approval, audit append-only-by-convention, artifact `uri` disclosure, dependency advisories (`docs/engineering/SECURITY-RESULTS.md` §6, `KNOWN-LIMITATIONS.md` items 9-10, 19). They are referenced where they change the impact of a new finding.

---

## 2. What was measured

| Probe | Result |
|---|---|
| Path/segment fuzz (24 payloads: `..`, absolute, encoded, NUL, fullwidth dots, 65-char) | All rejected; `safeSegment` is a correct allowlist |
| Symlink escapes through `assertContained` (`/etc/passwd`, fixture repo, `~/.local/share/opencode`, dir symlink + missing child) | All blocked; dangling target inside the root correctly allowed |
| Real `bwrap` run with the adapter's mount layout | `uid=1000`, `CapEff=0`, `NoNewPrivs=1`, `Seccomp=0`, no `/oldroot`, `/run` contains only `agent-egress`, `/etc/probe` → read-only, TCP to `1.1.1.1:443` blocked, no host D-Bus/user bus |
| Post-run `git status` against a sandbox-written repo | **Hook executed on the host as `ubuntu`, `GITHUB_TOKEN` present** |
| Credential store read from inside the sandbox | 6 credentials, 696 sessions, 1,067,208,704-byte DB, `mcp-auth.json`, `agentmemory/secret`, NSS `key4.db` all readable |
| Egress proxy host-confusion matrix (prefix, userinfo, suffix, trailing dot) | All denied; host allowlist holds |
| Egress proxy `CONNECT` to a second port on an allowed host | **Allowed** — 200, upstream connected |
| Concurrent `provision()` of the same ids by two managers | Both failed; one deleted the other's clone |
| Workspace reuse with a different source/commit | Old clone adopted, agent marker survived, requested commit ignored |
| `cleanup` after `cancelled` | Full checkout retained, `removed:false`, `cleanedAt:null` |
| Artifact locator: symlink to `/etc/passwd`, symlinked parent, `../..`, absolute outside root | All blocked; `logicalUri` never leaks the path |
| Artifact integrity: same-length replacement | `integrity: failed` → API path returns `409` |
| API e2e `executions.e2e-spec.ts` | **11/11 passed** (tenant 404, traversal 404, tamper 409, gone 410) |
| Redaction matrix (17 samples) | 6 leaks — see F9 |

---

## 3. Findings

### F1 — CRITICAL: post-run host `git` executes agent-controlled repository config

**Where:** `packages/agent-runtime/src/runtimes/opencode-cli.ts:782-799` (`gitDiff`), called from `:381` (`writeArtifacts`) after the sandbox exits.

```ts
execFileAsync('git', ['-C', repoPath, 'diff'], { timeout: 15_000, ... })
execFileAsync('git', ['-C', repoPath, 'status', '--porcelain'], { timeout: 15_000, ... })
```

No `env` override is passed, so the child inherits the worker's full environment. `repoPath` is `<workspace>/repo`, which the sandbox mounts read-write at `/workspace` (`packages/workspace-manager/src/sandbox.ts:157`). Everything inside `.git/` is therefore agent-writable, and `git` reads it as configuration.

**Reproduction (measured, end to end, no model spend):**

```sh
# 1. inside the sandbox — an ordinary edit, plus a hook in its own repo
echo "agent edit" >> README.md
printf '#!/bin/sh\nid > ./HOST-ID\nenv | grep -E "^(DATABASE_URL|JWT_SECRET|GITHUB_TOKEN)=" \
  | sed "s/=.*/=<SET>/" > ./HOST-ENV\necho pwned > ./HOST-MARKER\n' > ./pwn.sh
chmod +x ./pwn.sh
mkdir -p .git/hooks && cp ./pwn.sh .git/hooks/post-index-change
chmod +x .git/hooks/post-index-change
printf '[core]\n\trepositoryformatversion = 0\n\tfsmonitor = ./pwn.sh\n' > .git/config

# 2. on the host, immediately after the sandbox exits (opencode-cli.ts:789)
git -C <workspace>/repo status --porcelain
```

Result:

```
M README.md
?? HOST-ENV
?? HOST-ID
?? HOST-MARKER
HOST-MARKER : EXECUTED (pwned)
HOST-ID     : uid=1000(ubuntu) gid=1000(ubuntu) groups=1000(ubuntu),4(adm),24(cdrom),27(sudo),30(dip),102(lxd)
HOST-ENV    : GITHUB_TOKEN=<SET>
```

`sudo -n true` returns `0` on this host, so the same hook is root. The worker loads `.env` at startup (`apps/worker/src/config.ts:139-155`, called from `apps/worker/src/main.ts:38`), and `.env` is mode `0600` owned by `ubuntu`; the child inherits whatever the worker holds, including the `DATABASE_URL` from `.env`, and the hook can read `.env` directly for `JWT_SECRET`. The worker's per-run scratch, every other tenant's workspace under `WORKSPACE_ROOT`, and the `DATABASE_URL`-reachable database are all in scope.

**Why it is unconditional.** `writeArtifacts` is called at `:381` before the adapter examines `outcome.reason` (`:405`, `:413`) or the exit code (`:441`). A cancelled, timed-out, failed or non-zero-exit run still runs `git status`/`git diff`. Cancelling the agent does not prevent the payload. `--die-with-parent` is irrelevant: the execution is on the host, not in the sandbox.

**Also injected by the same sink:** `core.fsmonitor`, `diff.external`, `core.hooksPath` + any hook, `diff.<driver>.command` with `.gitattributes`, and `filter.<driver>.clean`/`smudge` on a checkout. `git status` alone was sufficient; `git diff` adds `diff.external` and textconv.

**Fix (in order of preference):**

1. **Do not run host `git` against the agent's repo.** Produce the diff inside a fresh, read-only sandbox (`bwrap --ro-bind repo /workspace ... git diff --no-ext-diff --no-textconv`), or compute it from a snapshot/copy taken before the agent regains control. Treat the repository as untrusted input to every host tool, not only to the agent.
2. If a host-side call is unavoidable, harden every invocation:
   ```ts
   execFile('git', [
     '-c','core.fsmonitor=false', '-c','core.hooksPath=/dev/null',
     '-c','diff.external=', '-c','core.pager=cat', '-c','core.attributesFile=/dev/null',
     '-C', repoPath, '--no-optional-locks',
     'diff', '--no-ext-diff', '--no-textconv',
   ], { env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_ATTR_NOSYSTEM: '1' } })
   ```
   and the same flags on `status`. This is a mitigation, not a boundary — a future git feature can add another execution hook.
3. The worker must not run as a user with passwordless `sudo` or `lxd` membership. This host does.

**Test that would have caught it:** clone a fixture, run a sandbox that writes `.git/hooks/post-index-change` and `core.fsmonitor`, then assert the host `gitDiff` path creates no file outside the workspace. Add it to `packages/agent-runtime/test/opencode-cli.test.ts` (the existing tests mock the spawn, so this class of bug is invisible to them).

---

### F2 — CRITICAL: platform-wide credentials and operator history are readable inside the sandbox; the raw transcript is served to any member

**Where:**
- mount: `opencode-cli.ts:191` (`dataHome = $HOME/.local/share`) and `:559-573` (whole `dataHome`, `stateHome`, `cacheHome` mounted `ephemeral`, i.e. readable, writes discarded)
- transcript: `opencode-cli.ts:744-760` writes `outcome.buffers.stdout` **verbatim**; no `redact()`
- copy: `apps/worker/src/activities/artifacts.ts:66-96` copies it into `<workspace>/artifacts`
- serve: `apps/api/src/artifacts/artifacts.controller.ts:39-60` — no `@Roles`, so any member including `VIEWER`

**Measured from inside the sandbox**, with the adapter's own mount layout:

```
credential rows reachable: 6
  - opencode / Default / 350 bytes
  - google / Google / 62 bytes
  - velona / Velona AI / 62 bytes
  - velona / Velona AI 2 / 74 bytes
  - velona / Velona AI 3 / 73 bytes
  - commandcode / CommandCode / 116 bytes
sessions: 696
db size bytes: 1067208704
mcp-auth integrations: postman
agentmemory secret readable: true
NSS key db readable: true
```

The adapter's comment calls this "the one secret in reach of the agent". It is not one secret: it is the entire XDG data home. The six credentials live in `credential.value` as `TEXT` that `opencode` consumes directly — there is no per-run scoping and no visible encryption envelope — and they cover every provider configured on the host, not the one provider the run is using. The same mount exposes `~/.local/share/pki/nssdb/key4.db`, `~/.local/share/agentmemory/secret`, and 696 sessions of the operator's prior work.

**Exfiltration requires no network.** `opencode run --format json` emits tool output in the stream; `parseOpencodeStream` reads `state.output` (`opencode-stream.ts:100-106`), proving tool output is in stdout. A tool call that reads a credential puts it in `buffers.stdout`; `writeArtifacts` writes those bytes to `transcript.ndjson`; `materializeArtifacts` copies them; `persistResultActivity` records the `Artifact` row; `GET /v1/orgs/:orgId/artifacts/:id/content` streams them to any `VIEWER` in the org. The redactor is applied to `summary`, `error.message` and event messages (`opencode-stream.ts:56,92,103-111`), **never to the transcript**. A prompt-injected repository can instruct the agent to read `$XDG_DATA_HOME`; a model that explores its environment will find it.

This is cross-tenant in substance even though the row is org-scoped: the credentials in `opencode.db` are the platform's provider credentials, shared by every org's runs. One org's `VIEWER` receives keys that authenticate every other org's work.

**Fix:**

1. Stop mounting `$HOME/.local/share` wholesale. Mount a per-run directory containing exactly the credential the run needs.
2. Better: remove credentials from the sandbox entirely. Terminate provider auth in the egress proxy (inject `Authorization` upstream) or issue a short-lived, per-run, provider-scoped token. An agent that cannot read a key cannot leak one.
3. Redact or sanitise `transcript.ndjson` before it enters tenant-served storage; keep the raw stream in an operator-only root, not under `ARTIFACT_ROOT`/`WORKSPACE_ROOT`. The current design stores raw model/tool output as a downloadable artifact.
4. Role-gate artifact content. A `VIEWER` should not receive raw tool output by default.
5. Run a secret scan (entropy + known prefixes) at persist time and fail the artifact, not just the summary.

---

### F3 — HIGH: no CPU, memory, pid or disk limit; one run can starve the host

**Where:** `packages/workspace-manager/src/sandbox.ts:133-177` (no cgroup, no rlimit, no `--unshare-user`); `apps/worker/src/activities/execute-agent.ts:85,236` (adapter timeout only); `apps/worker/src/config.ts:341` (`WORKER_MAX_CONCURRENT_ACTIVITIES=10`); `opencode-cli.ts:428` (spend cap optional).

Measured inside the sandbox:

```
cgroup: 0::/user.slice/user-1000.slice/user@1000.service/tmux-spawn-….scope
memory.max: no such file (no /sys mounted)
ulimit -u: 27191   ulimit -v: unlimited
nproc: 2           MemTotal: 7961992 kB
```

The sandbox shares the worker's cgroup. There is no `memory.max`, `pids.max`, `cpu.max`, `io.max`, or workspace quota. `--unshare-pid` hides host pids; it does not cap them. A run can allocate the host's 8 GB, fork to the user-wide pid limit, or fill the disk through `/workspace` (the repo is a host-backed rw bind). Ten concurrent activities multiply that. The adapter timeout (default 50 s, max 230 s) bounds wall time only while the Node event loop is alive; it is an in-process timer, not a supervisor. There is no external kill deadline beyond Temporal's 4 m `startToClose`/10 m `scheduleToClose` and three attempts (`apps/worker/src/workflows/run-task.ts:73-81`) — up to ~30 minutes of retries.

`AGENT_MAX_USD` is commented out in `.env.example` (line 78), and `maxUsd` is `undefined` unless set (`opencode-cli.ts:195`). A real run has **no dollar cap by default**; the streamed-cost kill only exists when `maxUsd` is configured.

**Fix:** create a cgroup v2 scope per run (`systemd-run --scope -p MemoryMax=… -p MemorySwapMax=0 -p CPUQuota=… -p TasksMax=… -p IOReadBandwidthMax=…` around `bwrap`, or delegate a subtree); set `RLIMIT_FSIZE`, `RLIMIT_NOFILE`, `RLIMIT_NPROC`; quota the workspace; add a supervisor process outside the adapter with a hard `SIGKILL` deadline; make `AGENT_MAX_USD` mandatory when `AGENT_RUNTIME=opencode-cli`.

---

### F4 — HIGH → MEDIUM: `network: false` is true for IP, false for the agent's reach

**Where:** `packages/agent-runtime/src/sandbox/entry-source.ts:40-53` (loopback listener forwards any bytes to the host proxy); `packages/agent-runtime/src/sandbox/egress-proxy.ts:135-156` (`CONNECT` validates the host, not the port); `opencode-cli.ts:206-215` (`capabilities().network = false`).

Measured: TCP to `1.1.1.1:443` blocked, host sockets absent, DNS unusable — the IP block is real. But the shim listens on `127.0.0.1:8888` and pipes **any** client to the host proxy; it is not restricted to the `opencode` process. The agent's own shell can speak HTTP proxy protocol to it. The proxy allows `CONNECT <allowed-host>:<any-port>`; `CONNECT localhost:18082` returned `200 Connection Established` and reached a second local service, proving the port is unvalidated. It also blindly forwards request headers (including a spoofed `Host`) and does not inspect TLS.

Consequences: (a) the agent has a working exfiltration channel to `api.commandcode.ai` and `opencode.ai`, including request bodies; (b) if an operator adds an internal model gateway or any private host to `allowHosts`, the agent gets SSRF into the internal network on arbitrary ports; (c) `network: false` in `RuntimeCapabilities` is semantically wrong for an agent with a shell — "no arbitrary IP egress" is accurate, "no network" is not.

The allowlist itself held against every host-confusion attempt (prefix, userinfo, suffix, trailing dot, wrong case → all `403`). That part is correct.

**Fix:** pin `CONNECT` and absolute-form to port 443; resolve the hostname and reject loopback/private/link-local/ULA addresses (defence against a poisoned allowlist and DNS rebinding); reject non-443 ports in the allowlist definition at boot; treat the proxy as a data-egress channel in the threat model and log bodies' sizes/hosts. Consider an allowlist of `host:443` pairs rather than bare hostnames.

---

### F5 — HIGH (policy): the approval gate is self-attested

**Where:** `apps/api/src/tasks/tasks.service.ts:100-190` (`riskClass` comes from the request body), `:535-537` (`POST /run` checks approval only when `requiresApproval(task.riskClass)`), `packages/contracts/src/dto.ts:53-55` (`riskClass` is a required client field); `validate-task.ts:69-95` repeats the same label check.

A `MEMBER` creates a task with `riskClass: 'LOW'` and any goal, then `POST /run`. No approval row is required. The platform never classifies the work; it asks the requester whether they would like to be gated. A `MEMBER` can therefore execute a real shell-capable agent against the configured repository with no approval, by choosing a label. `POST /run` is `@Roles('MEMBER')`.

This is a policy bypass, not a mechanism break: the `APPROVED`-row check itself is correctly scoped and correctly enforced on both `POST /run` and `PATCH → queued` (which is system-managed and unreachable anyway). It is rated High, not Critical, for that reason — but note that with F1, any unapproved `LOW` run is also a path to host root.

Known and not re-counted: an `ADMIN` can approve their own request, and an `APPROVED` row authorises every future run of the task (`SECURITY-RESULTS.md` §6.1, `KNOWN-LIMITATIONS.md` 9-10, `D-001`).

**Fix:** derive or confirm risk server-side (an `ADMIN` must set/confirm `riskClass` for a real run, or all real runs require approval until a classifier exists); consume approval per run (`ApprovalRequest.consumedByRunId`); refuse self-approval except in a single-admin org; re-check approval at the start of `executeAgentActivity` and record the approval id on the attempt.

---

### F6 — MEDIUM (latent): `req.taskId` is used as a path component without validation

**Where:** `opencode-cli.ts:318-324`:

```ts
const runId = `${req.taskId}-${startedAt.toString(36)}`;
const runDir = join(this.artifactsRoot, OPENCODE_CLI_ID, runId);
await mkdir(configDir, { recursive: true, mode: 0o700 });
await writeFile(join(configDir, 'opencode.json'), ...);
```

`ExecutionRequest.taskId` is `z.string().min(1)` (`packages/agent-runtime/src/types.ts`), not a UUID. Measured: `taskId = '../../../../tmp/sec-runid-escape/evil'` wrote `opencode.json` outside `artifactsRoot`; `taskId = '/tmp/abs-evil'` was absorbed by `join` but still produced a directory tree under the root. The worker currently passes a database UUID (`task.id`), so this is not reachable through today's API. It is one caller away from arbitrary file write as the worker, and the adapter is a public package API.

**Fix:** wrap `req.taskId` in `safeSegment` (or require `z.string().uuid()`), and `assertContained(this.artifactsRoot, runDir)` before `mkdir`. The workspace manager already has the right helper; the adapter does not use it here.

---

### F7 — MEDIUM: the artifact writer trusts any absolute path an adapter returns

**Where:** `apps/worker/src/activities/artifacts.ts:66-96`. `source = artifact.uri`; the only checks are `isAbsolute`, `stat().isFile()`, and a 64 MiB cap. There is no containment check.

Measured: a result with `uri: '/etc/hostname'` was copied to `<workspace>/artifacts/transcript.ndjson`; `uri: '/home/ubuntu/.local/share/agentmemory/secret'` was copied to `report.md`. The reader (`artifact-locator.ts`) is contained; the writer is not. Today the only adapters are in-process and trusted for more than this, so the immediate impact is limited. The stated threat model calls adapters untrusted (`types.ts`, "An adapter is untrusted"), and a future adapter that derives a report path from model output would turn this into a tenant-visible host-file read. It also launders files into `ARTIFACT_ROOT`, where the API will serve them with a matching checksum.

**Fix:** constrain `source` to the adapter's own run directory (or the workspace lease) with `assertContained`, and reject anything else as `missing`.

---

### F8 — MEDIUM: artifact reads are root-scoped, not tenant-scoped

**Where:** `apps/api/src/artifacts/artifact-locator.ts:60-131`, `apps/api/src/artifacts/artifacts.service.ts:104-123`.

`createArtifactLocator([artifactRoot, workspaceRoot])` resolves any path under either root. The tenant check is the `(id, orgId)` query on the `Artifact` row; the bytes themselves are not bound to the org in the path. A row in org A whose `uri` points at `<workspaceRoot>/orgB/...` would be served to org A. The locator's own comment cites "a bad row, a restored backup, or a future code path" as the threat — those are exactly the cases a tenant-prefix check would catch. Today no shipped adapter produces such a row.

Same-org and cross-org endpoint isolation is otherwise correct: `OrgScopeGuard` requires `X-Org-Id` to equal the path org and checks membership on `(headerOrgId, userId)`; the e2e suite's foreign-attempt 404 passed.

**Fix:** pass the row's `orgId` into `resolve()` and require the canonical path's first segment under the root to equal it (`<root>/<orgId>/...`). Both current layouts satisfy this (`<artifactRoot>/<orgId>/<taskId>/...`, `<workspaceRoot>/<orgId>/<taskId>/<workspaceId>/artifacts/...`). Also bind `Artifact` to `attemptId` so attribution is not a time-window heuristic.

---

### F9 — MEDIUM: redaction misses the secrets most likely to appear

**Where:** `packages/agent-runtime/src/redact.ts:18-33`.

Measured 17 samples; 6 leaked:

| Input | Result |
|---|---|
| `Authorization: Bearer abc…` | redacted |
| Bare JWT (`eyJ…`.`eyJ…`.`…`) | **LEAK** — no pattern for three base64url segments |
| `sk-proj-…` | redacted |
| `ghp_…`, `github_pat_…`, `AKIA…`, `xoxb-…` | redacted |
| 32/64 hex | redacted |
| `postgres://admin:hunter2@db.internal:5432/app` | **LEAK** — no URL-userinfo pattern |
| `DATABASE_URL=postgres://u:p@h/db` | **LEAK** — the KV pattern requires `KEY|TOKEN|SECRET|PASSWORD` in the name |
| `password: hunter2` | **LEAK** — the KV pattern is case-sensitive; lowercase keys are not matched |
| `sk_live_…` (Stripe) | **LEAK** — only `sk-` is matched |
| `npm_…` | **LEAK** |
| `wJalrXUtnFEMI/…` (AWS secret) | **LEAK** — no entropy check |
| base64 of an `sk-` key | **LEAK** |

The `DATABASE_URL` and lowercase `password:` misses are the important ones: they are exactly what an agent debugging a failing test prints. The bare-JWT miss matters because this platform's own access token is a JWT. Redaction is a second line, and the first line (F2) does not exist for the transcript — so a missed token goes to durable, member-readable storage. The function's own docstring admits the denylist is incomplete; that is honest, but it does not make the transcript safe.

**Fix:** add a JWT pattern (`eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`), URL-userinfo (`://[^/\s:@]+:[^/\s@]+@`), make the KV pattern case-insensitive and include `URL|DSN|CONN`, add `sk_live_`, `npm_`, `glpat-`, and a Shannon-entropy fallback for 20+ character values. Most importantly, apply redaction to the transcript artifact (or serve a redacted view) and never rely on the denylist as the only control.

---

### F10 — MEDIUM (deployment): a token in the clone URL ends up readable by the agent

**Where:** `packages/workspace-manager/src/manager.ts:138-157,264-266` — `git clone --no-hardlinks <sourceRepo> repo`, then the repo is bound rw into the sandbox.

If `WORKSPACE_SOURCE_REPO` is `https://x-access-token:<token>@github.com/org/repo`, git writes that URL into `repo/.git/config` as `remote.origin.url`, and the sandbox can read it. This is the standard CI pattern and a likely operator choice. The `.env.example` uses a local path, so it is not the default, but nothing in the config or documentation forbids it.

**Fix:** use a read-only deploy key passed through `GIT_SSH_COMMAND`/`core.sshCommand` with a key file outside the workspace, or a credential helper; after clone, `git remote set-url origin <sanitised-url>`; document "never put a credential in `WORKSPACE_SOURCE_REPO`" and add a boot-time check for `://[^/]*:[^/]*@`.

---

### F11 — MEDIUM: no spend cap by default

**Where:** `opencode-cli.ts:118,195,428,709-718`; `apps/worker/src/config.ts:324`; `.env.example:78` (`# AGENT_MAX_USD=0.5`).

`maxUsd` is `undefined` unless `AGENT_MAX_USD` is set, and the example ships it commented out. The "hard spend cap" is opt-in. With no cgroup/wall-clock supervisor (F3), a single run can spend without a dollar bound; three Temporal attempts and ten concurrent activities multiply it. The streamed-cost regex also counts every `"cost":` occurrence, so a stream that repeats cumulative cost can kill early or late — an availability/cost bug, not an escape.

**Fix:** default `AGENT_MAX_USD` to a small positive value when `AGENT_RUNTIME=opencode-cli`; refuse to boot the real adapter without it; parse cost from `step_finish` only.

---

### F12 — MEDIUM: a goal beginning with `-` is parsed as an `opencode` flag; `--help` records a false success

**Where:** `opencode-cli.ts:521-537` — `input.goal` is appended as the final argv element with no `--` terminator.

Measured with the exact adapter argv: `opencode --standalone run --auto --model … --format json --title task-123 --help` exits `0` and prints help. The adapter then parses non-JSON stdout into zero events, zero usage, zero tool calls, and returns `status: 'succeeded'` (`:462-466`). `persistResultActivity` writes a succeeded `AgentRun` with no work behind it. A `MEMBER` can create a task whose goal is `--help` (or `--version`, `--continue`, `--archived`) and produce a green run. Single-token flags only; `--file <path>`/`--model <x>` need two tokens and the goal is one.

`--server=<url>` is a single token and would redirect the client, but the sandbox has no IP route; only the egress proxy is reachable, so it is not an escape.

**Fix:** insert `'--'` before the goal, or validate that the goal does not start with `-`. Treat an empty parsed stream as a failed run (`OPENCODE_EMPTY_STREAM`), not a success — a run that produced no model output is not evidence of work.

---

### F13 — LOW: cancelled workspaces are never cleaned

**Where:** `manager.ts:343-345` — `cleanup()` returns early for `completed` **or** `cancelled` without deleting anything; `apps/worker/src/activities/workspace.ts:184` calls it with `keepArtifacts: true`; `:194` leaves `cleanedAt` null for cancelled.

Measured: after `executing → cancelled → cleanup`, `repo/` and the workspace root are still on disk. Every cancelled run leaves a full clone. This is unbounded disk growth on a shared host (and interacts with F3). `releaseWorkspace`'s `outcome === 'cancelled'` path deliberately skips `cleanedAt`, so nothing sweeps it later.

**Fix:** on `cancelled`, remove `repo/` and keep `artifacts/` like every other outcome, or add a sweeper keyed on `cleanedAt IS NULL AND state = 'cancelled'`.

---

### F14 — LOW (latent): workspace reuse ignores the requested source and base commit

**Where:** `manager.ts:211-234`. If `<rootPath>/repo/.git` exists, `provision()` returns a `ready` handle built from **the existing directory**, ignoring `request.kind`, `request.repoPath`, and `request.baseCommit`; `:212-215` also returns a known handle even if its state is terminal.

Measured: provision workspace `w` from fixture A, write `AGENT-WAS-HERE`; a second manager provisions `w` requesting repo B at commit `d75f988`; result: state `ready`, base commit from A, marker survives, requested commit not honoured. Also measured: an empty `.git` directory is accepted as `ready` with `baseCommit: null`.

Not reachable today because `workspaceId` is derived from `(workflowRunId, attemptNumber)` and attempt numbers only increase (`ids.ts:66-68`, `attempts.ts:90-120`). It becomes reachable the moment an operator retries an attempt id, a repair script adopts a row, or a second workflow run reuses an id. A `ready` handle whose directory is a different repository is a silent integrity failure.

**Fix:** in the adopt-by-directory path, compare `git rev-parse HEAD` to `request.baseCommit` and the configured source; refuse and fail the workspace on a mismatch. Require a non-empty `.git` and a resolved `HEAD`.

---

### F15 — LOW: `simulated` cannot be inverted by the shipped adapters, but the guard is one-directional

**Where:** `execute-agent.ts:266-275` rejects `local-simulated` + `simulated:false`; `persist-result.ts:56-63` repeats it. There is no check for a non-simulated runtime reporting `simulated:true`.

`opencode-cli.build()` hardcodes `simulated: false` (`:492`), and `LocalSimulatedRuntime` hardcodes `true`, so the shipped pair is consistent. A future real adapter that reports `true` would be persisted as a simulated run, understating real work and spend. `providerMeta.model`, `runtimeVersion`, `costUsd`, and `tokensIn/Out` are also adapter-supplied and persisted without cross-checking.

**Fix:** make the flag derive from the registered adapter id at persist time (`runtimeId !== LOCAL_SIMULATED_ID`), not from the result payload; treat a mismatch as a hard failure in both directions.

---

### F16 — LOW: the probe is a test, not a runtime gate

**Where:** `probeSandbox` is exported (`packages/workspace-manager/src/index.ts:56`) and used only in `test/sandbox.test.ts`; `capabilities()` returns a literal (`opencode-cli.ts:206-215`).

The claim "measured, not declared" is true of CI, not of a running worker. A host where `bwrap` exists but cannot create the namespace will fail the spawn (fail-closed, good), so this is not an escape. But a host where a different `bwrap` binary earlier in `PATH` exists would be used (`resolveBwrap` checks `existsSync` only), and `network:'blocked'` is never re-measured. Low, but the report should not imply a runtime measurement that does not happen.

**Fix:** run `probeSandbox` once at worker startup when `AGENT_RUNTIME=opencode-cli`, and refuse to start the activity if `networkBlocked`/`rootReadOnly` are false. Record the probe evidence in the worker log.

---

### F17 — LOW (latent): `repo` is not re-asserted before the bind

**Where:** `opencode-cli.ts:304-316` asserts `workspaceRoot` is contained, then uses `join(resolvedWorkspace, 'repo')` with no second `assertContained`; `sandbox.ts:157` binds it rw.

If `<workspace>/repo` were a symlink to `/`, `bwrap --bind` would mount the host root read-write. The agent cannot create that symlink (its `..` is the sandbox root, and the parent `<workspace>` is not mounted), and `provision` would fail/`rm` a pre-existing symlink. It is latent, but the fix is one call and the consequence is maximal.

**Fix:** `await assertContained(resolvedWorkspace, repoPath)` before building the command, and have `buildSandboxCommand` assert that every `rw` mount's host path is inside the workspace root.

---

### F18 — LOW: approval is not re-checked where execution starts

**Where:** `apps/worker/src/activities/validate-task.ts:69-95` (the only approval check); `apps/worker/src/activities/execute-agent.ts` has none. The Phase 3 baseline §7 claims "Gate re-checked inside the worker activity" for a direct workflow start. It is re-checked in a *separate* activity that the workflow calls first, which is sufficient for a workflow start but not for the activity itself.

Temporal is bound to `127.0.0.1:7233` with no auth. A local process that can reach it and register a workflow on the task queue could call `executeAgentActivity` for a `ready` HIGH task with no approval row. That requires local access the sandbox does not have, so it is defence-in-depth rather than a live bypass. The imprecise claim is worth correcting in the baseline.

**Fix:** re-read the task's risk class and the latest `APPROVED` row at the top of `executeAgentActivity` (cheap, one query) and record the approval id on the attempt; enable Temporal mTLS/namespace auth in any deployment.

---

## 4. Claim-by-claim table

| # | Claim | Measured truth | Verdict |
|---|---|---|---|
| 1 | A real agent runs with `shell: true` | `capabilities()` returns `shell:true`; argv includes `--auto`. No paid run was made (cost constraint); the command path is code-verified. | **Holds, not run** |
| 2 | `network: false` | No IP egress: TCP blocked, no DNS, no host sockets, only `agent-egress` under `/run`. But the agent can speak HTTP proxy protocol to `127.0.0.1:8888` and reach the two allowlisted provider hosts on **any port**. | **Overstated** |
| 3 | Filesystem write limited to a disposable workspace clone | Inside `bwrap`: only `/workspace` is host-backed rw; `/tmp`, `/run`, `/dev` and the three XDG overlays are writable but ephemeral. End to end: **false** — the host `git` sink writes outside, and `materializeArtifacts` copies arbitrary paths. | **False end to end** |
| 4 | Enforced by `bwrap`: read-only root, single rw bind, `--unshare-net` | Verified: `CapEff=0`, `NoNewPrivs=1`, no `/oldroot`, `/etc` ro, `--unshare-net`, one host rw bind. No user namespace, no seccomp (`Seccomp:0`). | **Holds, with residuals** |
| 5 | The allowlisted egress proxy is the only route to the provider | True for the provider. It is also a route the agent can use, with no TLS inspection, no port restriction, and no rate limit. | **Holds with caveats** |
| 6 | Approval is re-checked inside the worker activity | Only `validateTaskActivity` checks; `executeAgentActivity` does not. The baseline's wording is wrong. | **False as stated** |
| 7 | `probeSandbox` measures the capabilities, not the comments | The probe exists and passes in tests; it is never run by the worker. `capabilities()` is a literal. | **Partial** |
| 8 | The artifact reader is contained under `ARTIFACT_ROOT`/`WORKSPACE_ROOT` | Verified: symlink, symlinked parent, `../..`, absolute-outside all `undefined`; 11/11 e2e pass. Containment is root-level, not tenant-level (F8). | **Holds** |
| 9 | Artifacts are re-hashed on read; tamper is `409` | Verified: same-length replacement → `failed`; API returns `409 ARTIFACT_INTEGRITY_FAILED`. DB checksum tamper → `verified`, but the DB is the trust root by design. | **Holds** |
| 10 | `simulated` cannot be inverted | One direction is guarded; the shipped adapters hardcode the correct value. A future real adapter reporting `true` would be persisted as simulated (F15). | **Holds today, not structural** |
| 11 | Cancellation kills the process group | Verified: `SIGTERM` to `-pgid`, `--die-with-parent`, pid-namespace teardown; a `setsid` grandchild did not survive. | **Holds** |
| 12 | No unsandboxed fallback | `resolveBwrap` throws; the adapter refuses without `workspaceRoot`; `network:'host'` is never passed. | **Holds** |
| 13 | Workspaces are disposable; cleanup keeps artifacts | Completed/failed: repo removed, `artifacts/` kept (verified). Cancelled: **nothing removed** (F13). | **Partial** |
| 14 | The credential DB is "the one secret in reach" | It is the entire `~/.local/share`, `~/.local/state` and `~/.cache`: 6 credentials, 696 sessions, NSS keys, agentmemory secret. | **Understated** |
| 15 | The sandbox refuses to run outside `bwrap` | True; `resolveBwrap` checks existence, not identity. | **Holds** |

---

## 5. Residual risk the design accepts

In plain language, these are consequences of choosing `bwrap` on this host, not bugs to file twice:

- **Shared kernel.** `bwrap` is namespaces and mounts, not a VM. A kernel vulnerability reachable from inside the sandbox is host compromise. There is no seccomp filter (`Seccomp: 0`) and no user namespace (`uid=1000` inside equals `uid=1000` outside), so the syscall surface is the host's and the uid is the worker's. `NoNewPrivs=1` blocks setuid binaries *inside*; it does nothing once code runs outside.
- **Same uid, privileged groups.** The worker runs as `ubuntu`, which is in `sudo` and `lxd`. Any escape is root-equivalent on this host. The sandbox cannot fix that; the deployment can.
- **`/etc` is read-only, not hidden.** The agent can read `passwd`, `hosts`, `resolv.conf`, CA roots and machine configuration. `/etc/shadow` is denied to uid 1000. This is needed for `node`/`git` and is an accepted disclosure.
- **The agent must authenticate to think.** Today that means a provider credential is readable inside the sandbox. The design accepts one credential; the implementation exposes all of them. Moving auth to the proxy is the only way to remove this class.
- **The database is the trust root.** Artifact integrity, approval state and audit rows are only as good as DB write access. A worker-level compromise (F1) can rewrite all three. The audit table is append-only by convention, not by grant (`SECURITY-RESULTS.md` §6.3).
- **Agent output is untrusted and durable.** The transcript is evidence and an exfiltration channel at the same time. Serving raw model/tool output to every member is a product decision that the security model has to price in.
- **Local Temporal has no auth.** Anything that can reach `127.0.0.1:7233` is inside the orchestration trust boundary. The API is the intended boundary; the loopback bind is the only control.
- **`.env` on disk.** `0600` protects it from other users, not from the worker user. Any worker-level RCE reads `JWT_SECRET`, `DATABASE_URL`, and provider keys.

---

## 6. What a production deployment would still require

Ordered by what would stop the two Criticals first.

1. **Remove host-side `git` from the agent's repository (F1).** Either run the diff inside a fresh read-only sandbox or harden every invocation (`core.fsmonitor=false`, `core.hooksPath=/dev/null`, `diff.external=`, `--no-ext-diff`, `--no-textconv`, `GIT_CONFIG_GLOBAL=/dev/null`). Add a hostile-repo regression test. Do not run the worker as a sudo/lxd user.
2. **Scope credentials per run, or remove them from the sandbox (F2).** Mount a per-run credential file, or inject provider auth in the egress proxy. Do not mount `$HOME/.local/share`. Redact or relocate the raw transcript; role-gate artifact downloads; scan artifacts for secrets at persist time.
3. **Add real resource limits (F3).** cgroup v2 per run (`MemoryMax`, `CPUQuota`, `TasksMax`, `IO*`), `RLIMIT_FSIZE`/`NPROC`/`NOFILE`, a workspace quota, an out-of-process kill deadline, and a mandatory `AGENT_MAX_USD`.
4. **Pin and validate egress (F4).** Port 443 only; resolve and reject private/loopback/link-local targets; boot-time validation of `allowHosts`; log denied and allowed destinations; treat the proxy as a data channel.
5. **Make risk classification server-side and consume approvals (F5).** An `ADMIN` sets/confirms risk for real runs; per-run approval (`consumedByRunId`); self-approval rule; re-check in `executeAgentActivity`.
6. **Validate every path that crosses a process boundary (F6, F7, F8).** `safeSegment` on `taskId`; `assertContained` on artifact sources; tenant-prefix check in the locator; bind artifacts to attempts.
7. **Fix the redaction and the transcript sink (F9).** JWT/URL/KV/Stripe/npm/entropy patterns, and never serve the raw stream as the primary artifact.
8. **Harden the deployment.** A dedicated unprivileged worker user and cgroup; secrets in a manager, not `.env`; no `JWT_SECRET` in the worker; Temporal mTLS; a read-only deploy key for the clone, never a token in the URL (F10); a startup `probeSandbox` gate (F16).
9. **Close the audit-integrity gaps.** A `--` before the goal and a failed empty stream (F12); a bidirectional `simulated` invariant (F15); a cancelled-workspace sweeper (F13); a source/base-commit check on reuse (F14).
10. **Commit the code.** The audited tree is uncommitted; a security review that cannot name a revision cannot be reproduced or bisected.

---

## 7. What I could not verify

- **No real paid agent execution.** The adapter's `capabilities()`, argv, mounts and result mapping are code-verified; the sandbox probes use the same `buildSandboxCommand` the adapter calls. The F1 and F2 chains were reproduced with `bwrap` and the real credential store, not with a model.
- **The worker process environment.** `.env` was not read (explicit rule). `DATABASE_URL` presence in the `git` child is inferred from `loadNearestEnvFile` (`config.ts:139-155`) and the absence of an `env` override at `opencode-cli.ts:785/789`; `GITHUB_TOKEN` was measured in the child on this host.
- **A foreign-org artifact row end to end.** F8 is proven at the locator level (it resolves any path under the root) but crafting a cross-tenant row in the seeded database was out of scope. The e2e suite covers foreign-task/attempt 404, traversal 404, tamper 409 and gone 410 (11/11 passed).
- **Kernel exploitability, seccomp absence, and `sudo` escalation from the hook.** `sudo -n true` succeeds; I did not execute a root payload. The claim is "the hook can become root", not "root was obtained".
- **The web execution screens.** This unit covered the API and worker surfaces named in the brief; the Phase 3 UI was not reviewed.
- **Temporal direct invocation.** Not attempted; the server is loopback-only and unauthenticated.

---

## 8. Would I ship it?

**No — not against any repository I did not write myself.**

I would ship the namespace sandbox: it does what it says. I would not ship the adapter around it. F1 is a sandbox escape that needs no kernel bug, no network, and no malicious model — a repository instruction or a single `git config` is enough, and it runs after the agent is already dead, on the host, as a user with passwordless `sudo`. F2 means the agent can read every provider credential on the machine and the platform will durably serve the result to any `VIEWER` in the org, unredacted.

Everything else on the list is fixable in a normal hardening pass. Those two are not hardening; they invalidate the phase's central claim until they are closed.

---

# Addendum — SEC-302, sandbox remediation (2026-11-13)

**Scope:** the two Criticals (F1, F2) and the two Highs (F3, F4) the audit raised, plus
the F5 policy record. This section is written against the same revision, after the code
changed; everything below is measured in this session.

**Verdict change:** the audit's **FAIL** was driven by two Criticals. F1 is closed and
verified. F2 is **downgraded from Critical to High** — the exfiltration path to a
`VIEWER` is closed, the "whole home directory" exposure is closed, but the provider
credential and opencode's own session rows are still readable inside the sandbox because
authentication lives in that database. Details in §A.5. The unit moves from **FAIL** to
**CONDITIONAL PASS** (see §A.7).

---

## A.1 F1 — host RCE via post-run `git` — **CLOSED**

### What was wrong

`OpencodeCliRuntime.gitDiff()` ran `git -C <workspace>/repo status --porcelain` and
`git -C <workspace>/repo diff` **on the host, as the worker**, after every run including
cancelled, timed-out and failed ones. The workspace is agent-writable, so
`.git/config` (`core.fsmonitor`) and `.git/hooks/*` were agent-controlled programs the
worker executed. Reproduced by the auditor as host code execution `as ubuntu` — a user
with passwordless `sudo` on this host.

### What changed

- `collectWorkspaceEvidence()` (`packages/agent-runtime/src/runtimes/opencode-cli.ts`)
  replaces the host calls. It runs `git` through the **same `buildSandboxCommand`
  profile** as the run: read-only root, a single read-write bind at `/workspace`,
  `--unshare-net`, `--clearenv`, no extra mounts.
- Defence in depth: every in-sandbox invocation passes
  `-c core.fsmonitor=false -c core.hooksPath=/dev/null -c diff.external=` and
  `--no-ext-diff --no-textconv`, plus `GIT_CONFIG_NOSYSTEM=1`,
  `GIT_CONFIG_GLOBAL=/dev/null`. A hook cannot run, and if one did it could not write
  outside the sandbox.
- The `diff.patch` artifact is produced by that sandboxed invocation; there is no other
  code path that writes it.
- The same pattern was removed from two other places the audit's brief implied but did
  not name:
  - `packages/workspace-manager/src/manager.ts`: the idempotent `provision()` branch and
    `recover()` used to run `git rev-parse` on a directory an agent may have written.
    They now call `readHeadSandboxed()`. Host `git` remains only for a clone/worktree
    this call just created.
  - `infra/scripts/p3-real-run.ts`: the proof script ran `git diff`/`git status` against
    the agent's workspace. It now uses `collectWorkspaceEvidence()`.

### Proof

`packages/agent-runtime/test/workspace-git.test.ts` — 4 tests, all passing. The payload
plants `.git/hooks/post-checkout`, `.git/hooks/post-index-change` and
`git config core.fsmonitor ./pwn.sh`, where each writes a marker to a host path outside
the workspace *and* to `/workspace/hook-ran`:

| Test | Assertion | Result |
|---|---|---|
| negative control (separate workspace) | host `git status` executes the payload → host marker exists | **passes** — the payload is live, so the test can fail |
| adapter post-run path | `collectWorkspaceEvidence()` returns `M src/sum.js` and `?? note.txt`; **no host marker**; no in-sandbox hook execution | **passes** |
| sandbox without `-c` overrides | hook fires and writes `/workspace/hook-ran`, **no host marker** | **passes** — containment is the sandbox, not the flags |
| non-checkout workspace | returns `null` | **passes** |

Remaining host `git` uses, with the reason each is safe:

| File:line | Call | Why it is safe |
|---|---|---|
| `packages/workspace-manager/src/manager.ts:331` | `git(rootPath, ['clone', …])` | creates a fresh directory from `WORKSPACE_SOURCE_REPO`, an operator-configured path; no agent has run yet |
| `…/manager.ts:334` | `git(repoPath, ['checkout', …])` | the clone created on line 331 |
| `…/manager.ts:337` | `git(source.repoPath, ['worktree','add',…])` | the operator's source repository, not the workspace |
| `…/manager.ts:357` (`readHead`) | `git rev-parse` ×2 | immediately after the clone/worktree above; the agent has not seen the directory |
| `packages/agent-runtime/src/runtimes/opencode-cli.ts` (`opencodeVersion`, `hasCredential`) | `opencode --version`, `opencode auth list` | no workspace path is passed; the binary is resolved from the worker's `PATH` |
| `infra/scripts/p3-real-run.ts:52` | `git(..., FIXTURE)` | the operator's fixture repository, never a workspace |
| `packages/agent-runtime/test/workspace-git.test.ts:71,125` | host `git` | the test's own negative control, on a throwaway clone |

No `git -C <workspace>` and no `execFile('git')` against a workspace path remains in
`apps/` or `packages/`.

---

## A.2 F2 — in-sandbox credential exposure — **PARTIALLY CLOSED (Critical → High)**

### What changed

1. **The mount is an allowlist.** `packages/agent-runtime/src/sandbox/state-mounts.ts`
   replaces the wholesale `$HOME/.local/share`, `$HOME/.local/state` and `$HOME/.cache`
   mounts with four paths, each only if it exists:
   `<data>/opencode` → `/xdg-data/opencode` (ephemeral), `<state>/opencode` →
   `/xdg-state/opencode` (ephemeral), `<cache>/opencode` → `/xdg-cache/opencode`
   (ephemeral), and `<config>/opencode/auth.json` (read-only, legacy location only).
   `$HOME` is never mounted; the global config directory is never mounted
   (`OPENCODE_CONFIG_DIR` points at the per-run `/cfg`).
2. **Operator data inside that directory is masked.** `mcp-auth.json` is replaced with
   `/dev/null`; `shell/`, `storage/`, `tool-output/`, `snapshot/`, `repos/` and `log/`
   are replaced with empty tmpfs mounts (writable, so the shell tool still works, but the
   host's history is invisible).
3. **Redaction happens at collection.** Every line written to `transcript.ndjson` goes
   through `redact()` in `TranscriptBuffer.push()` — before the bytes exist in a string
   the writer can use. There is no second, unredacted path.
4. **`redact.ts` covers the required shapes**, one unit test each: `Authorization: Bearer`,
   bare three-part JWT, `sk-…`, `ghp_…`/`github_pat_…`, `AKIA…`, 32+ hex, `KEY=value`
   (case-insensitive), URLs with `user:pass@`, and base64 runs ≥40 chars whose decoded
   bytes contain any of those.
5. **The transcript is capped at 5 MiB** with an explicit
   `{"type":"truncated","limitBytes":5242880}` line; the buffer stops accepting bytes
   after the cap, so memory cannot grow past it.
6. **Raw transcript downloads require `ADMIN`.** `ArtifactsService.content()` refuses a
   `transcript` below `ADMIN` before reading a byte; `VIEWER`/`MEMBER` keep metadata,
   `diff` and `report`. Documented in `apps/api/api-contract.md`.

### Proof

`packages/agent-runtime/test/state-mounts.test.ts` — 7 tests against a synthetic `$HOME`
containing one of each thing the audit found. Measured from **inside a real sandbox**:

```
/xdg-data:
drwx------  3 ubuntu ubuntu  60 … .
drwxr-xr-x 19 ubuntu ubuntu 380 … ..
drwxr-xr-x  1 ubuntu ubuntu  40 … opencode

/xdg-data/opencode:
crw-rw-rw- 1 nobody nogroup 1, 3 … mcp-auth.json      <- masked
-rw------- 1 ubuntu ubuntu 1068654592 … opencode.db    <- the credential the run needs
drwxr-xr-x 2 ubuntu ubuntu 40 … log  repos  shell  snapshot  storage  tool-output  <- empty
```

| Probe from inside the sandbox | Result |
|---|---|
| `cat /xdg-data/opencode/opencode.db` | readable (SQLite header `53 51 4c 69 74 65 …`) — required to authenticate |
| `cat /xdg-data/opencode/mcp-auth.json` | `Permission denied` |
| `ls /xdg-data/opencode/shell` (previous shell output) | empty |
| `cat /home/ubuntu/.local/share/agentmemory/secret` | `No such file or directory` (path not mounted) |
| `cat /home/ubuntu/.local/share/pki/nssdb/key4.db` | `No such file or directory` |
| `cat /home/ubuntu/.local/state/lesshst` | `No such file or directory` |
| `cat /home/ubuntu/.ssh/id_rsa` | `No such file or directory` |
| `cat /home/ubuntu/.config/opencode/cli.json` | `No such file or directory` |
| `ls /xdg-data` | `opencode` only — no sibling application |

`infra/scripts/p3-sandbox-audit.ts` reproduces the listing against the **real** `$HOME`;
`npx tsx infra/scripts/p3-sandbox-audit.ts` prints §2 above.

Transcript: `packages/agent-runtime/test/transcript.test.ts` (5 tests) and
`packages/agent-runtime/test/redact.test.ts` (15 tests) — 20/20 passing, covering each
shape, chunk-split lines, the 5 MiB cut, and NDJSON validity after redaction.

Live API (restarted with this revision, seeded data):

```
OWNER  transcript content -> 200
MEMBER transcript content -> 403 FORBIDDEN "Raw transcripts require the ADMIN role or higher…"
VIEWER transcript content -> 403 FORBIDDEN
OWNER/MEMBER/VIEWER transcript metadata -> 200 200 200
VIEWER diff content -> 200
```

An `ADMIN` path is still served, because "no one can read a transcript" would make the
artifact useless for debugging a run.

### Residual (this is why F2 is High, not closed)

`opencode.db` is 1.07 GB and holds **both** the provider credential **and** the
operator's session history. It cannot be masked — the agent must authenticate to think —
and it cannot be narrowed to a single file without a database-level export this unit did
not build. So an agent that reads its own data directory can still see the credential it
is already using and previous sessions' content. The transcript is redacted and
role-gated, so the *platform-mediated* exfiltration path to a `VIEWER` is closed; a
direct exfiltration path (the model sending what it read to the provider) is not.
Moving authentication into the egress proxy — so the sandbox has no credential at all —
is the only way to remove this class, and is the recommended next step.

---

## A.3 F3 — resource limits — **PARTIALLY CLOSED (High → Medium)**

| Control | Implementation | Measured |
|---|---|---|
| File descriptors | `AGENT_RLIMIT_NOFILE` (1024) applied by `prlimit` in the entry wrapper; `bwrap --rlimit-nofile` emitted when the local binary supports it | `Max open files 1024 1024` |
| Processes | `AGENT_RLIMIT_NPROC` (4096) | `Max processes 4096 4096` |
| Memory | `AGENT_RLIMIT_AS` (6 GiB) | `Max address space 6442450944` |
| Wall clock | `runInProcessGroup()`: `SIGTERM` to `-pid`, `SIGKILL` to `-pid` after the grace window | grandchild test below |
| Spend | `AGENT_MAX_USD` now defaults to **0.5**; `0` is refused at boot for a real runtime; the adapter also refuses `maxUsd <= 0` | `apps/worker/test/config.test.ts` |

`infra/scripts/p3-sandbox-audit.ts` §3 prints the ceilings from inside a run:

```
ulimit: nofile=1024 virtual=6291456
Max processes             4096                 4096                 processes
Max open files            1024                 1024                 files
Max address space         6442450944           6442450944           bytes
```

Descendant reaping: `packages/agent-runtime/test/process-group.test.ts` — 4 tests. A
shell backgrounds `(sleep 2; echo late > …) &`, the run is killed at 250 ms, and 2.8 s
later the file does not exist. The positive control (deadline longer than the sleep)
does write the file, so the test can fail. The same test runs the production
`buildSandboxCommand` path.

### Why `bwrap --rlimit-*` is not in argv on this host

The installed `bubblewrap 0.11.1-1ubuntu0.3` does **not** parse `--rlimit-nofile`
("Unknown option"). `buildSandboxCommand` probes `bwrap --help` once and emits the flags
only when they are advertised; otherwise a bwrap upgrade would turn a resource control
into an outage. Enforcement therefore comes from `prlimit` in the entry wrapper, which
is why the ceilings above are visible from inside.

### Residual

- `RLIMIT_NPROC` is **per uid**, and the sandbox runs as the worker's uid: the ceiling
  counts every process the worker already has. It is a fork-bomb backstop, not a per-run
  quota. `pids.max` in a delegated cgroup is the correct control.
- `RLIMIT_AS` bounds virtual address space, not RSS.
- **No disk quota.** `RLIMIT_FSIZE` was implemented, measured, and removed: the provider
  database is ~1 GiB and the ephemeral overlay copies it up on first write, so any
  per-file limit below that kills the agent at startup. `tmpfs` size limits / cgroup
  `memory.max` are the right mechanism.
- The ephemeral overlay itself costs ~1.1 GB of tmpfs **per concurrent run** (copy-up of
  the database). That is pre-existing, bounded by `WORKER_MAX_CONCURRENT_ACTIVITIES`, and
  not solved by rlimits. A smaller credential store would solve it.

---

## A.4 F4 — `network: false` overstated — **CLOSED**

`packages/agent-runtime/src/sandbox/egress-proxy.ts` now:

- accepts `CONNECT` only for an **exact** allowlist entry (wildcards are no longer
  expanded) **and** only port **443**;
- refuses absolute-form HTTP outright, so there is no second, TLS-less egress path;
- logs every decision with `{ host, port, allowed, method }`.

Measured with a real `curl` speaking proxy protocol through the sandbox shim:

```
443   exit=0 body="200"
22    exit=7 body="000" curl: (7) CONNECT tunnel failed, response 403
8443  exit=7 body="000" curl: (7) CONNECT tunnel failed, response 403
evil  exit=7 body="000" curl: (7) CONNECT tunnel failed, response 403

proxy log:
  CONNECT api.commandcode.ai:443  -> allow
  CONNECT api.commandcode.ai:22   -> deny
  CONNECT api.commandcode.ai:8443 -> deny
  CONNECT evil.example.test:443   -> deny
```

Unchanged residual: the tunnel is opaque, so the proxy cannot distinguish a provider
request from any other request to the same host:443, and it does not rate-limit.

Documentation updated to the precise claim — **no general egress; model traffic only via
an allowlisted 443 proxy; all other sockets blocked** — in `RuntimeCapabilities`
(`packages/agent-runtime/src/types.ts`), the adapter's `capabilities()` doc comment, and
ADR-006 (Phase 3 implementation note).

---

## A.5 F5 — self-attested risk class — **RECORDED, NOT CHANGED**

Recorded as **D-006** in `docs/decisions/OPEN-DECISIONS.md` with four options and a
recommendation (a server-side per-project risk floor). No policy was changed.

`apps/api/test/tasks.e2e-spec.ts` now contains a test that documents the current
behaviour: a `MEMBER` creates a `LOW` task, **zero** `ApprovalRequest` rows exist, and
`POST /run` is accepted (202 with Temporal, 503 without) rather than refused for
approval. If the policy changes, that test fails and the decision is updated.

---

## A.6 Verification (this session)

| Gate | Result |
|---|---|
| `pnpm -w typecheck` | exit 0, 8 projects |
| `pnpm lint` | exit 0, 0 warnings |
| `pnpm -w test` | **38 files passed, 412 tests passed, 1 skipped** (~92 s) |
| `pnpm -w build` | exit 0 (api, web, worker) |
| `pnpm --filter @intelligenz/web test:e2e` | **57 passed, 3 skipped** against the API restarted from this revision |
| Real adapter contract suite (`opencode-cli.test.ts`) | 15 passed, 1 skipped — includes real model runs through the narrowed mounts, so authentication still works |
| `npx tsx infra/scripts/p3-sandbox-audit.ts` | §A.2 and §A.4 evidence, no model call |

One bug was found and fixed by this verification: `RLIMIT_FSIZE` broke the real adapter
(the 1 GiB database copy-up) even though every unit test passed. It was removed and
documented rather than left in with a ceiling that silently kills runs.

---

## A.7 Re-grade

| # | Was | Now | Basis |
|---|---|---|---|
| F1 | Critical | **Closed** | Sandboxed git + regression test with a live payload; no host `git` against a workspace remains |
| F2 | Critical | **High (open)** | Whole-home exposure closed, transcript redacted/capped/admin-gated; the provider DB (credential + session rows) is still readable in-sandbox |
| F3 | High | **Medium (open)** | nofile/nproc/as enforced, group kill reaps descendants, spend cap defaulted; no disk/CPU quota, no cgroup, per-uid nproc |
| F4 | High | **Closed** | Exact allowlist, 443 only, absolute-form refused, logged, documented |
| F5 | High (policy) | **Medium (open, decision D-006)** | Recorded with options; behaviour pinned by a test |

**Unit verdict: FAIL → CONDITIONAL PASS.** No Critical remains. The condition is F2: the
sandbox still holds one live provider credential and opencode's own session history, so
this adapter should not run against repositories or tenants whose data must not be
readable by the agent that is already running on them. F6–F18 from the original report
were outside this unit and remain open.

This addendum does not re-grade the rest of the Phase 3 tree; it grades the five findings
this unit was scoped to.
