# Credential custody assessment

**Status: OPEN. No credential isolation exists today.**
**Phase 6 did not attempt to implement custody — it is a dedicated Phase 7
workstream, per the directive. This document records what is actually there.**

## What was measured

| Fact | Value | How |
|---|---|---|
| Credential store | `/home/ubuntu/.local/share/opencode/opencode.db` | configured via `AGENT_BROKER_CREDENTIAL_DB` (`apps/worker/src/config.ts:384`) |
| Store mode / owner | `-rw-------` **uid 1000** | `ls -ln` |
| Store WAL/SHM | `opencode.db-wal`, `opencode.db-shm`, same mode and owner | `ls -ln` |
| Store size | ~1.1 GB | `ls -ln` |
| Worker identity | **uid 1000** (`ubuntu`) | `id` |
| Egress broker | **in-process library**, not a service | `startEgressBroker(...)` at `packages/agent-runtime/src/runtimes/opencode-cli.ts:711`; `@intelligenz/egress-broker` imported at `apps/worker/src/config.ts:5` |
| Broker IPC | unix socket `broker.sock` per run | `packages/egress-broker/src/broker.ts:64,648` |

## The boundary as it actually stands

```
sandbox (bwrap, uid 1000)
  └── only rw bind: <rootPath>/repo → /workspace        ← credential not mounted
       ro binds: /etc, selected host paths
       no network (--unshare-net)

worker process (uid 1000)
  ├── egress broker (same process, same uid)
  │     └── reads opencode.db  ← mode 0600, owned by uid 1000
  └── sandbox launcher
```

**What is genuinely true:** the sandbox cannot read the credential. It is not
mounted, `/workspace` is the only writable bind, and it has no network to use a
credential against. The Phase 4 claim that "the sandbox holds no secret" is
accurate and is the reason a malicious repository hook has nowhere to send what it
finds.

**What is not true, and must not be claimed:** that the credential is isolated
from the worker. The broker is a library call inside the worker process, and the
store is owned by the worker's own uid with mode `0600`. Any code execution as
uid 1000 — a compromised dependency, a bug in an adapter, an SSRF in a runtime
that reaches host filesystem APIs — reads provider credentials directly. There is
no process boundary, no privilege drop, and no IPC surface to cross.

Credential custody is therefore **OPEN**, and the Phase 5 register's O2 is
accurate as written.

## What the next workstream must establish

Minimum safe architecture, deliberately not implemented here:

1. **A separate service identity** (distinct uid) owning the credential store,
   with the store mode tightened to that uid only (`0600`, `0700` parent).
2. **The broker as a real process** under that identity, not a library call, so
   the boundary is a process boundary rather than a code convention.
3. **A socket as the only IPC**, already the shape today
   (`broker.sock`), with peer credentials checked (`SO_PEERCRED`) so the broker
   can verify the caller's uid.
4. **The worker unable to read the store** — verified by attempting the read from
   the worker's uid and failing, not by inspecting permissions.
5. **A supervisor that drops privileges** for the sandbox launcher, so the
   process that interprets agent-authored content is not the process that can read
   the store.

Each of those needs its own failing test before it can be called enforced, in the
same way Phase 6 treated the claim and the snapshot.

## What Phase 6 changed here

Nothing. No host identity was created or modified, no service configuration was
touched, and the credential store was not moved or re-permissioned. This document
is an assessment only.

## Residual risk, stated plainly

A worker-level compromise is equivalent to a provider-credential compromise. That
is the single largest host-level trust boundary remaining in the system, and it is
larger than anything Phase 6 closed: the claim prevents a *second* execution and
the snapshot prevents *falsified evidence*, but neither limits what a compromised
worker can read.

## Evidence paths

- `apps/worker/src/config.ts:336,384` — credential source configuration
- `packages/egress-broker/src/credential.ts:19-21,194,212` — SQLite store, not `auth.json`
- `packages/agent-runtime/src/runtimes/opencode-cli.ts:711` — in-process broker start
- `packages/egress-broker/src/broker.ts:64,648` — `broker.sock`
- `packages/workspace-manager/src/sandbox.ts:302-333` — the bind set
- `ls -ln /home/ubuntu/.local/share/opencode/opencode.db*` and `id`
