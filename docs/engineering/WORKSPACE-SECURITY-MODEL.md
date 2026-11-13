# Workspace security model

**What this document is:** the threat model of the execution sandbox **as built**, not as
designed. Every claim is either measured in this session, quoted from
`PHASE-3-SECURITY-RESULTS.md`, or marked as an open finding.
**Date:** 2026-11-13
**Verdict carried from the audit:** `CONDITIONAL PASS`. No Critical remains. One condition
remains (F2, §5), and it is the reason this model is not suitable for a sensitive
repository.

---

## 1. What is being protected

| Asset | Why it matters | Where it lives |
|---|---|---|
| **Provider credentials** | They authenticate every org's runs. One leak is a platform-wide spend and access problem. | `<data>/opencode/opencode.db`, legacy `auth.json` |
| **Operator history** | 696 sessions of prior work in the same database (the audit's count) | same file |
| **Other tenants' workspaces** | A run must not read a sibling lease | `<WORKSPACE_ROOT>/<org>/<task>/<ws>` |
| **The host** | The worker runs as a user with passwordless `sudo` and `lxd` membership | uid 1000 |
| **The artifact store** | Bytes served to tenants must be the bytes that were produced | `<workspace>/artifacts`, `ARTIFACT_ROOT` |
| **The audit trail** | The record of what happened is the product's evidence | PostgreSQL |
| **The source repository** | A run must not mutate the repository it was cloned from | `WORKSPACE_SOURCE_REPO` |

The threat actor is **the agent itself**, including a model that has been prompt-injected
by repository content. It is not a remote attacker with network access: the sandbox has
none. It is code running with the worker's privileges, inside a namespace, with a shell.

---

## 2. The boundary, as built

`buildSandboxCommand()` (`packages/workspace-manager/src/sandbox.ts`) emits this argv. The
following is the literal output of calling it for a probe workspace, with the base profile
plus the adapter's mounts:

```
bwrap
  --ro-bind /usr /usr
  --ro-bind /bin /bin
  --ro-bind /sbin /sbin
  --ro-bind /lib /lib
  --ro-bind /lib64 /lib64
  --ro-bind /etc /etc
  --proc /proc
  --dev /dev
  --tmpfs /tmp
  --tmpfs /run
  --dir /tmp/home
  --bind <rootPath>/repo /workspace
  --unshare-pid --unshare-ipc --unshare-uts --unshare-net
  --new-session --die-with-parent
  --clearenv
  --setenv PATH …  --setenv HOME /tmp/home  --setenv TMPDIR /tmp  …
  --chdir /workspace
  <argv>
```

`/lib32` and `/libx32` are in the candidate list but absent on this host, so they are
omitted. The adapter adds its own mounts on top.

### 2.1 Mount table

| Host path | Container path | Mode | Why it is there | What it exposes |
|---|---|---|---|---|
| `/usr`, `/bin`, `/sbin`, `/lib`, `/lib64` | same | `ro` | The toolchain: `node`, `git`, `sh`, `prlimit` | Every binary on the host's system paths. Reading them is not a secret disclosure; it is a large attack surface (see §4.1) |
| `/etc` | `/etc` | `ro` | CA roots for TLS, `/etc/passwd` for uid resolution, `resolv.conf` | Machine configuration: hostnames, users, package state. `/etc/shadow` is denied to uid 1000 |
| `/proc` | `/proc` | virtual | `node` and `git` need it | The **sandbox's own** process table; `--unshare-pid` hides the host's |
| `/dev` | `/dev` | virtual (minimal tmpfs) | `node`, `git` | A minimal device set; no host block devices |
| `/tmp` | `/tmp` | tmpfs | Scratch that dies with the run | Nothing persistent |
| `/run` | `/run` | tmpfs | So nothing can pin a socket on the host | The egress socket is mounted into it explicitly |
| `<rootPath>/repo` | `/workspace` | **`rw`** | The only place a run may leave a trace | The cloned repository, writable |
| `<runDir>/entry` | `/opt/agent` | `ro` | The entry shim that starts the proxy and applies `prlimit` | A 100-line Node script, per run, mode `0500` |
| `<nodeRoot>` | same | `ro` | The Node installation that also contains `opencode` | The runtime the agent uses; the agent cannot modify it |
| `<runDir>/config` | `/cfg` | `ro` | Per-run `opencode.json` containing only `{model}` | The model id. Not the operator's 17-MCP config |
| `<runDir>/egress` | `/run/agent-egress` | `ro` | The unix socket to the host egress proxy | A socket. Write access is not needed to connect, and read-only means the agent cannot replace it |
| `<data>/opencode` | `/xdg-data/opencode` | **ephemeral** (overlay, tmpfs upper) | The SQLite DB that holds provider auth | Readable; writes are discarded. **This is the F2 residual** |
| `/dev/null` | `/xdg-data/opencode/mcp-auth.json` | `ro` | Masks MCP OAuth tokens a run cannot use | Nothing |
| `<state>/opencode` | `/xdg-state/opencode` | ephemeral | Locks and service metadata | Writable but discarded |
| `<cache>/opencode` | `/xdg-cache/opencode` | ephemeral | Model catalogue cache | Writable but discarded |
| `<config>/opencode/auth.json` | `/xdg-config/opencode/auth.json` | `ro` | Legacy credential file, only if it exists | The legacy credential, if this version used it |
| — | `/xdg-data`, `/xdg-state`, `/xdg-cache`, `/xdg-config` | `--dir` | The XDG base directories must exist even when nothing is mounted | Empty directories |
| — | `/xdg-data/opencode/{shell,storage,tool-output,snapshot,repos,log}` | `--tmpfs` (masks) | Previous sessions' output | Empty and writable; the host's history is invisible |

**Nothing else from `$HOME` is mounted.** `$HOME` itself is `/tmp/home`, an empty
directory. Measured from inside the sandbox: `~/.ssh/id_rsa`, `~/.config/opencode/cli.json`,
`~/.local/share/agentmemory/secret` and `~/.local/share/pki/nssdb/key4.db` all return
`No such file or directory` (addendum A.2).

### 2.2 Environment

`--clearenv` plus an explicit allowlist. `buildEnv()` rejects any key matching
`/KEY|TOKEN|SECRET|PASSWORD/i` and any key that is not a valid shell name, so a caller
cannot smuggle a credential through the environment. The adapter's env is:

```
PATH, HOME=/tmp/home, TMPDIR=/tmp, LANG=C.UTF-8, TERM=dumb,
OPENCODE_CONFIG_DIR=/cfg, XDG_DATA_HOME=/xdg-data, XDG_STATE_HOME=/xdg-state,
XDG_CACHE_HOME=/xdg-cache, XDG_CONFIG_HOME=/xdg-config,
AGENT_PROXY_SOCKET=/run/agent-egress/egress.sock, AGENT_PROXY_PORT=8888,
AGENT_RLIMIT_NOFILE=1024, AGENT_RLIMIT_NPROC=4096, AGENT_RLIMIT_AS=6442450944,
OPENCODE_DISABLE_AUTOUPDATE=1, CI=1
```

No `DATABASE_URL`, no `JWT_SECRET`, no `GITHUB_TOKEN`. The worker's environment is not
inherited.

---

## 3. What the sandbox enforces — measured

From the audit's live probes (`PHASE-3-SECURITY-RESULTS.md` §2 and addendum A.3) and the
test suite, run against the production `buildSandboxCommand`. These figures were **not
re-measured for this document**; the commands that produce them are in §10, and the only
number re-measured here is the database size in §5.

| Property | Measurement |
|---|---|
| **No capabilities** | `CapEff: 0`, `NoNewPrivs: 1` inside |
| **No IP egress** | TCP to `1.1.1.1:443` blocked; no DNS; no host sockets; `curl` fails |
| **Read-only root** | `echo pwned > /etc/intelligenz-probe` fails with a read-only filesystem |
| **One writable host path** | `/workspace` write succeeds; it is the only `--bind` (rw) |
| **PID isolation** | `--unshare-pid`; the sandbox cannot see host pids |
| **IPC/UTS isolation** | `--unshare-ipc --unshare-uts` |
| **Session isolation** | `--new-session` (no controlling TTY) |
| **Life bound to parent** | `--die-with-parent`; a killed worker takes the sandbox with it |
| **Descendants die** | `SIGTERM`→`SIGKILL` to `-pgid`; a `setsid` grandchild did not survive (4 tests) |
| **File descriptors** | `Max open files 1024` |
| **Processes** | `Max processes 4096` |
| **Address space** | `Max address space 6442450944` (6 GiB) |
| **No `/oldroot`** | Not exposed; `/run` contains only `agent-egress` |
| **No host D-Bus / user bus** | Absent inside |

The probe is a **test**, not a runtime gate: `probeSandbox()` is exported and used in
`test/sandbox.test.ts`, but the worker never calls it at startup (F16). `capabilities()`
is a literal. A host where `bwrap` exists but cannot create the namespace fails at spawn
(fail-closed), so this is not an escape — but the claim "measured, not declared" is true of
CI, not of a running worker.

---

## 4. What the sandbox does not enforce

This list is the reason the verdict is conditional.

### 4.1 Shared kernel, same uid, no seccomp

- `bwrap` is namespaces and mounts, **not a VM**. A kernel vulnerability reachable from
  inside is host compromise.
- **No user namespace.** `uid=1000` inside is `uid=1000` outside. `NoNewPrivs=1` blocks
  setuid binaries inside; it does nothing once code runs outside.
- **No seccomp filter** (`Seccomp: 0`). The syscall surface is the host's, filtered only
  by the namespace and the dropped capabilities.
- **The worker user is privileged.** On this host, `ubuntu` is in `sudo` and `lxd`, and
  `sudo -n true` returns `0`. **Any escape is root-equivalent.** The sandbox cannot fix
  this; the deployment can, by running the worker as a dedicated unprivileged user outside
  those groups. It does not today.

### 4.2 No cgroup, no CPU or disk quota

The sandbox shares the worker's cgroup. Inside:

```
cgroup: 0::/user.slice/user-1000.slice/user@1000.service/…
memory.max: no such file (no /sys mounted)
ulimit -u: 27191   ulimit -v: unlimited
nproc: 2           MemTotal: 7961992 kB
```

There is **no** `memory.max`, `pids.max`, `cpu.max`, `io.max`, and no workspace quota.
`--unshare-pid` hides host pids; it does not cap them.

What exists instead:

- `RLIMIT_NOFILE=1024`, `RLIMIT_NPROC=4096`, `RLIMIT_AS=6 GiB`, applied by `prlimit` in
  the entry wrapper. `bwrap` on this host (0.11.1) does not parse `--rlimit-*`, so the
  builder emits the flags only when the binary advertises them and `prlimit` is the real
  enforcement path.
- **`RLIMIT_NPROC` is per real uid**, not per process tree. It counts every process the
  worker already has. It is a fork-bomb backstop, not a per-run quota.
- **`RLIMIT_AS` bounds virtual address space, not RSS.** It stops an allocation runaway,
  not resident growth.
- **No `RLIMIT_FSIZE`.** It was implemented, measured, and removed: the provider database
  is ~1 GiB and the ephemeral overlay copies it up on first write, so any per-file limit
  below that kills the agent at startup (addendum A.3). `tmpfs` size limits or cgroup
  `memory.max` are the right mechanism and are not present.
- **The overlay costs ~1.1 GB of tmpfs per concurrent run** (copy-up of the database).
  With `WORKER_MAX_CONCURRENT_ACTIVITIES=10`, ten real runs can consume ~11 GB of tmpfs
  on a 7.6 GB host. That is a live availability risk, bounded only by the concurrency
  setting.

### 4.3 `/etc` is readable

`passwd`, `hosts`, `resolv.conf`, machine-id, CA roots and package configuration are
visible. This is needed for `node`/`git` and is an accepted disclosure. `/etc/shadow` is
denied to uid 1000.

### 4.4 The host-side process is not sandboxed

The worker, the API, Temporal and the database are outside. A worker-level compromise
(F1 was one) can read `.env`, the database and every workspace. The database is the trust
root for artifact integrity, approvals and audit.

### 4.5 Local Temporal has no auth

Anything that can reach `127.0.0.1:7233` is inside the orchestration trust boundary. A
local process could start a workflow or invoke an activity. Reaching it requires local
access the sandbox does not have, so it is defence-in-depth rather than a live bypass —
but it is why `executeAgentActivity` re-checking approval matters (F18: it does not).

---

## 5. The credential residual (F2)

**Say it plainly: the agent can read a live provider credential, and the platform cannot
stop it from sending that credential to the provider.**

What is mounted is `<data>/opencode/opencode.db` — 1.07 GB — because authentication lives
in it and the agent must authenticate to think. That file contains:

- the provider credential rows the CLI uses (`credential.value` as plain `TEXT` — there is
  no per-run scoping and no visible encryption envelope);
- 696 sessions of the operator's prior work (the audit's count);
- opencode's own state.

The mask list removes `mcp-auth.json` and six directories of prior output. It **cannot**
remove the database, and it cannot narrow it to the one credential this run needs without
a database-level export that this phase did not build.

Two exfiltration paths, and their status:

| Path | Status |
|---|---|
| **Platform-mediated**: agent reads the credential → tool output → `transcript.ndjson` → artifact endpoint → a `VIEWER` | **Closed.** The transcript is redacted at collection (`TranscriptBuffer.push()`), capped at 5 MiB, and raw downloads require `ADMIN`. `VIEWER`/`MEMBER` keep metadata, `diff` and `report` only. |
| **Provider-mediated**: agent reads the credential → includes it in a prompt or tool input → the egress proxy forwards it to an allowlisted host:443 | **Not closed.** The proxy is an opaque TCP tunnel. It cannot distinguish a legitimate provider request from a request that carries a stolen key, because it does not inspect TLS and does not inspect bodies. |

The second path is the condition. It cannot be closed by a mount change: as long as the
sandbox holds a credential, the process holding it can send it to the one host it is
allowed to reach. The structural fix is to remove the credential from the sandbox and
terminate provider authentication in the egress proxy (inject `Authorization` upstream,
or issue a short-lived per-run token). That is a design change, not a hardening pass, and
it is not in this phase.

**Consequence for use:** this adapter must not run against a repository, a tenant, or a
machine whose data must not be readable by the agent that is already running on it. The
agent's own work is the leak channel.

---

## 6. Path containment

Three functions, in one file, with no database or HTTP types:

### 6.1 `safeSegment(value)`

```ts
const SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
```

An allowlist, not a denylist. `.`, `..`, `a/b`, `a\b`, `C:`, `\0`, a space, a 65-character
name and every unicode confusable are rejected because none of them match. It runs before
a path is built, so a route value like `../escape` throws before `mkdir`.

Tested with 14 assertions in `workspace-manager.test.ts` (`safeSegment — route-supplied
ids are hostile input`), including the null byte reaching no syscall.

### 6.2 `assertContained(base, candidate)`

Both sides go through `realpath` (following symlinks), and the candidate must equal the
base or start with `base + sep`. A symlink inside the workspace pointing at `/etc/passwd`
resolves to `/etc/passwd` and is rejected. When the path does not exist yet,
`realpathTolerant` resolves the nearest existing ancestor and appends the rest — appending
does not re-enter the filesystem, so a component that does not exist cannot be a symlink
yet.

### 6.3 `assertOwnPath(handle)` in `cleanup`

The expected path is recomputed from the ids (`orgId`, `taskId`, `workspaceId`) and compared
to `handle.rootPath`. A forged handle whose `rootPath` points at a sibling fails the
comparison with `ContainmentError`, so `cleanup` cannot delete a directory it was not
leased.

### 6.4 Where the rules are applied

| Boundary | Rule | Test |
|---|---|---|
| Workspace ids from a route | `safeSegment` | 14 assertions |
| Workspace creation | `assertContained(root, rootPath)` before `mkdir` | `refuses a traversal id before creating anything outside the root` |
| Workspace deletion | `assertOwnPath` recomputed from ids | `cleanup cannot delete a sibling workspace, even with a forged handle` |
| Adapter `workspaceRoot` | `assertContained(WORKSPACE_ROOT, req.workspaceRoot)` | `refuses a workspaceRoot outside WORKSPACE_ROOT` |
| Adapter checkout | `join(workspaceRoot, 'repo')`, existence checked | — |
| Artifact read | `locator.resolve()` realpaths and requires containment under `ARTIFACT_ROOT` or `WORKSPACE_ROOT` | e2e: `never serves a path outside the configured roots` |
| Artifact `uri` on the wire | relative to the root, never absolute | e2e: `reports integrity as verified and a logical uri` |

### 6.5 Known gaps in containment

| Gap | Consequence | Status |
|---|---|---|
| **F6** — `req.taskId` is interpolated into the adapter's run directory without `safeSegment` | Arbitrary write as the worker if a caller passes `../../..`. Not reachable through today's API (the worker passes a UUID), one caller away | Open |
| **F7** — `materializeArtifacts` copies any absolute path an adapter returns | A future adapter that derives a report path from model output turns this into a host-file read laundered into the artifact store. Today's adapters are in-process and trusted | Open |
| **F8** — the artifact locator is root-scoped, not tenant-scoped | A bad row in org A pointing at `<root>/orgB/...` would be served to org A. Today no shipped adapter produces such a row | Open |
| **F17** — `<workspace>/repo` is not re-asserted before the `rw` bind | If it were a symlink to `/`, `bwrap --bind` would mount the host root read-write. The agent cannot create it; `provision` would fail on a pre-existing one | Latent |
| **F14** — `provision()` adopts an existing `<root>/repo/.git` without checking the source or base commit | A retried or repaired attempt could run against a different repository while the row says `ready` | Latent |

The escape tests prove the rules that exist. They do not prove the gaps are unreachable
forever.

---

## 7. The egress path

```
sandbox (no interfaces)
  └─ 127.0.0.1:8888 (entry shim, inside the netns)
        └─ unix socket /run/agent-egress/egress.sock (ro bind)
              └─ host egress proxy
                    ├─ CONNECT <host>:443  → allowed only if host ∈ allowlist AND port = 443
                    ├─ CONNECT <anything else> → 403, logged
                    └─ absolute-form HTTP → 403, logged
```

**Exact host.** `permitted()` compares lowercased equality against
`['opencode.ai', 'api.commandcode.ai']`. No wildcard, no suffix, no implicit subdomain.
The host-confusion matrix (prefix, userinfo, suffix, trailing dot, wrong case) was measured
and every attempt was denied.

**Port 443 only.** The `CONNECT` handler checks `port === 443` *and* the host. A second
port on an allowed host is refused; the audit's original `CONNECT localhost:18082` finding
is closed.

**Absolute-form refused.** A plain `GET http://host/…` through the proxy is rejected, so
there is no second, TLS-less egress path.

**Logged.** Every decision is recorded `{at, host, port, allowed, method}` and the list is
copied into `AgentRun.providerMeta.egress`, so a run's reachability is auditable after the
fact. The measured run shows 7 entries, all `allow`.

**Opaque.** The proxy does not terminate TLS, does not inspect bodies, does not
rate-limit, and cannot distinguish a provider request from any other request to the same
host:443. It is a **reachability control, not a content control**. Anything that needs
content control — a secret leaving in a prompt — is a redaction and policy problem, not a
network one. This is the residual in §5.

**What it does not protect against:**

- A stolen credential sent to the provider (allowed by design — the tunnel is to the
  provider).
- A malicious provider or a poisoned DNS answer for an allowlisted name (`net.connect`
  resolves at connect time; private/loopback targets are **not** rejected after
  resolution — F4's remaining note).
- Volume: a run can send as much as it wants to those two hosts.

---

## 8. Trust boundaries

```
┌─────────────────────────────── host (ubuntu, sudo, lxd) ───────────────────────────────┐
│                                                                                        │
│  ┌── worker (same uid) ──┐   ┌── API ──┐   ┌── Temporal (127.0.0.1:7233, no auth) ──┐  │
│  │  .env, DATABASE_URL    │   │  JWT    │   │  can start workflows                   │  │
│  └───────────┬────────────┘   └────┬────┘   └────────────────────────────────────────┘  │
│              │                     │                                                   │
│              │  bwrap               │  SQL                                                │
│  ┌───────────▼────────────┐   ┌────▼─────────────┐                                     │
│  │ sandbox (uid 1000)     │   │ PostgreSQL       │  ← the trust root                   │
│  │  /workspace rw         │   │  rows, audit     │                                     │
│  │  $HOME tmpfs           │   └──────────────────┘                                     │
│  │  opencode.db readable  │                                                            │
│  │  no netns route        │──── egress proxy ────► opencode.ai:443, api.commandcode.ai:443│
│  └────────────────────────┘                                                            │
└────────────────────────────────────────────────────────────────────────────────────────┘
```

Inside the sandbox is untrusted. The worker is trusted for more than the sandbox (it holds
the database URL and the provider credential path). The database is trusted absolutely:
checksums, approvals and audit are only as good as write access to it.

---

## 9. What must change before this runs against a sensitive repository

Ordered by what closes the most risk first. Items 1–3 are blocking; the rest are required
for a production posture.

1. **Remove the provider credential from the sandbox.** Terminate authentication in the
   egress proxy (inject `Authorization` upstream) or issue a short-lived, per-run,
   provider-scoped token. Until this is done, §5 stands: the agent can read a credential
   and send it to the provider.
2. **Add real resource limits.** cgroup v2 per run (`MemoryMax`, `MemorySwapMax=0`,
   `CPUQuota`, `TasksMax`, `IOReadBandwidthMax`), a workspace quota, and a supervisor
   outside the adapter with a hard `SIGKILL` deadline. Make the ~1.1 GB overlay cost
   explicit in the concurrency budget.
3. **Run the worker as a dedicated unprivileged user.** No `sudo`, no `lxd`, no docker
   group, no login shell, its own cgroup. On this host, `ubuntu` is root-equivalent the
   moment anything escapes.
4. **Narrow the filesystem further.** A repository allowlist (only the leased path is
   bound), a read-only `/etc` subset rather than all of it, and `--unshare-user` if the
   host permits it.
5. **Close the path gaps.** `safeSegment(req.taskId)` in the adapter (F6); `assertContained`
   on every artifact source (F7); a tenant-prefix check in the artifact locator (F8); a
   re-assertion of `<workspace>/repo` before the bind (F17); a source/base-commit check on
   reuse (F14).
6. **Add seccomp.** A profile that permits what `node`, `git` and `opencode` need and
   denies the rest. `Seccomp: 0` today.
7. **Make the runtime probe a gate.** Run `probeSandbox()` at worker startup when
   `AGENT_RUNTIME=opencode-cli` and refuse to start the activity if `networkBlocked` or
   `rootReadOnly` is false (F16).
8. **Authenticate Temporal.** mTLS or namespace auth; the loopback bind is the only
   control today.
9. **Make the audit trail enforceable.** Grants that deny `UPDATE`/`DELETE` on
   `AuditEvent`, and audit events for artifact writes and checksum verifications, not only
   task transitions.
10. **Re-check approval where execution starts.** `executeAgentActivity` does not (F18);
    a direct activity invocation is not gated by anything except local access.

Until items 1–3 are done, the correct statement is: **this sandbox is adequate for a
repository you wrote and would not mind an AI reading.** It is not adequate for a
repository whose contents are someone else's secret.

---

## 10. How to re-measure

```bash
# The mount layout, literally
npx tsx -e "import {buildSandboxCommand} from './packages/workspace-manager/src/sandbox.ts'; \
  console.log(buildSandboxCommand({rootPath:'/tmp/ws'},['true']).args.join(' '))"

# Capabilities, mounts, rlimits, egress — against the real $HOME, no model call
npx tsx infra/scripts/p3-sandbox-audit.ts

# The escape tests
npx vitest run packages/workspace-manager/test packages/agent-runtime/test/workspace-git.test.ts \
  packages/agent-runtime/test/state-mounts.test.ts packages/agent-runtime/test/egress-proxy.test.ts \
  --reporter=verbose
```

A security claim that is not reproduced by one of those commands is a claim about the
past, not about the tree.
