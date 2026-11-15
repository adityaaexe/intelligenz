# Credential custody assessment

**Status: OPEN. No credential isolation exists today.**
**Above this gate:** uid 1000 has passwordless `sudo` and is in `lxd`, so a same-host uid split
is not a boundary until that is removed (Step 0). See "Three facts that outrank 'same uid'".
**Phase 6 did not attempt to implement custody — it is a dedicated Phase 7
workstream, per the directive. This document records what is actually there.**

## What was measured

| Fact | Value | How |
|---|---|---|
| Credential store | `/home/ubuntu/.local/share/opencode/opencode.db` | configured via `AGENT_BROKER_CREDENTIAL_DB` (`apps/worker/src/config.ts:384`) |
| Store mode / owner | `-rw-------` **uid 1000** | `ls -ln` |
| Store WAL/SHM | `opencode.db-wal`, `opencode.db-shm`, same mode and owner | `ls -ln` |
| Store size | ~1.1 GB (1,151,967,232 bytes at measurement) | `ls -ln` |
| Second secret, same directory | `mcp-auth.json`, `0600`, 344 bytes, uid 1000 | `ls -ln` |
| Parent directory modes | `.local`, `share`, `opencode` all `drwxrwxr-x` (**0775**), owner uid 1000 | `namei -l` |
| Worker privilege | passwordless **root**; uid 1000 is in `sudo` and `lxd` | `sudo -n whoami` → `root` (exit 0); `id -nG` → `ubuntu adm cdrom sudo dip lxd` |
| Worker identity | **uid 1000** (`ubuntu`) | `id` |
| Egress broker | **in-process library**, not a service | `startEgressBroker(...)` at `packages/agent-runtime/src/runtimes/opencode-cli.ts:711`; `@intelligenz/egress-broker` imported at `apps/worker/src/config.ts:5` |
| Broker IPC | unix socket `broker.sock` per run, `brokerDir` bound **read-only** into the sandbox at `/run/agent-broker` — the sandbox is the broker's real client | `packages/egress-broker/src/broker.ts:64,648`; `packages/agent-runtime/src/sandbox/broker-contract.ts:86-89` |

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

**Measured, at the level of the command:** the argv the launcher builds has exactly one
writable bind (`sandbox.test.ts:96`), and egress from inside the sandbox is blocked
(`sandbox.test.ts:51`). Production passes no `readOnlyMounts` (`sandbox.ts:301-318`; no caller
in `agent-runtime` or `worker`). Those are measurements of the launcher's argv, not of a
running mount namespace — the two are not the same claim, which is why the next paragraph is
what it is.

**NOT TESTED — "the sandbox cannot read the credential."** That sentence used to appear here as
fact. It is an inference from the bind set, not a measurement, and this document's own standard
(§"What the next workstream must establish", item 4) says the read attempt is what makes it
enforced. What does exist is weaker than an attempted read:

- `packages/agent-runtime/test/credential-isolation.test.ts` launches the production layout and
  a probe inside it. The probe **`statSync`s** the host store path and asserts it is absent
  (`:251`), with a positive control showing the probe can detect a leak (`:290`). That is a fact
  about path resolution in the mount namespace — a necessary condition, not a read attempt.
- It does not `open` the store, and it cannot distinguish "absent" from "present but refused",
  because the store is never bound in.
- `sandbox.test.ts:96` asserts the argv's writable bind set; `sandbox.test.ts:51` measures
  blocked egress.

So the strongest honest statement is: **the store path is not in the bind set and is not visible
from inside the launched sandbox; nobody has attempted the read that would make "cannot" a
measurement.**

The experiment that would settle it, run from inside a real sandbox built with the production
profile (`sandbox.ts:301-318`; no caller passes `readOnlyMounts`):

| # | Attempt, as the sandbox uid | Expected if the claim holds |
|---|---|---|
| 1 | `open('/home/ubuntu/.local/share/opencode/opencode.db', O_RDONLY)` | `ENOENT` — the path does not exist in the sandbox's mount namespace |
| 2 | same for `opencode.db-wal` and `opencode.db-shm` | `ENOENT` |
| 3 | `readdir('/home/ubuntu/.local/share/opencode')` | `ENOENT`, not an empty directory |
| 4 | `open('/proc/<worker-pid>/root/home/ubuntu/.local/share/opencode/opencode.db')` | `ENOENT`/`EACCES` — procfs of the host is not reachable, or `hidepid` blocks it |
| 5 | `findmnt` / parse `/proc/self/mountinfo` for any bind whose source is the store or its parent | no such mount |
| 6 | `sudo -n whoami` (the escalation arm — fact 1) | fails; if it prints `root`, the mount set is the only remaining control and this column is void |
| 7 | positive control: `open('/workspace/<seeded-file>')` | **succeeds** — the fixture can read at all, so 1-6 are not passing because the probe is broken |

A test that asserts 1-6 without 7 proves nothing. Add it to
`packages/workspace-manager/test/sandbox.test.ts`, next to the existing egress probe, which is
the same shape. **Trigger to close:** that test passing on the production bind profile; the
sentence flips to *enforced* only then.

**What is genuinely true, and still matters:** the Phase 4 claim that "the sandbox holds no
secret" is accurate in the sense that nothing it can reach is a credential, so a malicious
repository hook has nowhere to send what it finds. It is not accurate as "cannot read" until
the read is attempted.

**What is not true, and must not be claimed:** that the credential is isolated
from the worker. The broker is a library call inside the worker process, and the
store is owned by the worker's own uid with mode `0600`. Any code execution as
uid 1000 — a compromised dependency, a bug in an adapter, an SSRF in a runtime
that reaches host filesystem APIs — reads provider credentials directly. There is
no process boundary, no privilege drop, and no IPC surface to cross.

Credential custody is therefore **OPEN**, and the Phase 5 register's O2 is
accurate as written.

## Three facts that outrank "same uid"

Measured on the host for this assessment. They sit **above** Gate A: they decide whether any
Gate A design can mean anything on this host. The fix is host administration, not code, and it
is a separate authorised workstream (Step 0 below).

### 1. uid 1000 can become root

```
$ sudo -n whoami
root
$ id -nG
ubuntu adm cdrom sudo dip lxd
```

Passwordless `sudo` to root, and membership of `sudo` and `lxd`. Any process running as the
worker's uid can become root, so **any same-host uid separation is theatre until that is
removed**. A dedicated `izbroker` uid buys nothing against an attacker who can run
`sudo -u izbroker cat <store>`.

Two limits on the measurement, so it is not over-read. It was taken from an interactive shell
as uid 1000, not from a worker child — same uid, and `sudoers`/PAM do not distinguish, but that
arm is `A-3` in `PHASE7-SCOPING.md` and is **not run**. And it says nothing about whether the
*sandbox* can escalate: that depends on whether setuid binaries survive its namespace setup,
and it is untested.

### 2. The file mode is not the control

```
$ namei -l /home/ubuntu/.local/share/opencode/opencode.db
  /home/ubuntu   drwxr-x---  ubuntu ubuntu
  .local         drwxrwxr-x  ubuntu ubuntu     ← 0775
  share          drwxrwxr-x  ubuntu ubuntu     ← 0775
  opencode       drwxrwxr-x  ubuntu ubuntu     ← 0775
  opencode.db    -rw-------  ubuntu ubuntu     ← 0600
```

`0600` refuses a read by another user. It does not stop the directory's **owner** from
`unlink`-ing the store and putting another file at the same path — every parent from `.local` to
`opencode` is `0775` and owned by uid 1000. The worker *is* that owner, so "the store is
`0600`" says nothing about which file the broker reads. Tightening the file alone proves
nothing; the directories are part of the control.

### 3. There is a second secret in the same directory

`mcp-auth.json` — `0600`, 344 bytes, uid 1000, beside `opencode.db`. A custody design that moves
one store and not the other moves half the problem.

## What custody can and cannot buy

State this in the Phase 7 report in these terms, because the stronger version is false:

- **Disclosure can be removed.** Today uid 1000 reads a 1.1 GB store holding every provider
  credential the operator has, plus operator session history. After custody, the worker reads
  none of it: not this attempt's key, not another provider's key, not history.
- **Use cannot.** The sandbox mounts the broker directory by design
  (`broker-contract.ts:86-89`), so the agent reaches the broker. Custody bounds what a request
  can do — `maxRequests` (`DEFAULT_BROKER_MAX_REQUESTS = 400`), allowed paths and methods, a
  per-attempt capability — and does not stop it. A compromised worker can mint a capability for
  a run it launches, because the worker is the launcher.
- **Therefore:** after a custody design lands, a worker compromise is **not credential
  disclosure**; it remains **credential use** against the attempt's own provider, capped per
  attempt. Disclosure and use are different problems, and only the first is in scope.

## What the next workstream must establish

**Step 0 — remove the escalation path, before any code.** Drop uid 1000 from `sudo` and `lxd`
(and `adm`, which can read the worker's logs), and delete the `NOPASSWD` rule. Minutes, no code,
the largest single risk reduction available on this host, and a **precondition** for items 1–5
rather than one of them: a separate broker uid under an account that can `sudo` to root is
theatre. This is host administration in a separate, authorised workstream. Phase 6 did not make
this change, and this document does not authorise it.

Then the minimum safe architecture, deliberately not implemented here:

1. **A separate service identity** (distinct uid) owning the credential store, with the store
   mode tightened to that uid only (`0600`, `0700` parent — see "The file mode is not the
   control": the directories carry as much of the boundary as the file does). Meaningful only
   after Step 0.
2. **The broker as a real process** under that identity, not a library call, so
   the boundary is a process boundary rather than a code convention.
3. **A socket as the only IPC**, already the shape today
   (`broker.sock`), with peer credentials checked (`SO_PEERCRED`) so the broker
   can verify the caller's uid. It proves nothing while every caller is uid 1000.
4. **The worker unable to read the store** — verified by attempting the read from
   the worker's uid and failing, not by inspecting permissions (`PHASE7-SCOPING.md` A-1 and
   A-2).
5. **A supervisor that drops privileges** for the sandbox launcher, so the
   process that interprets agent-authored content is not the process that can read
   the store.
6. **Both stores moved, not one.** `mcp-auth.json` sits in the same directory and is a secret;
   a design that covers `opencode.db` only leaves the sibling readable.

Each of those needs its own failing test before it can be called enforced, in the
same way Phase 6 treated the claim and the snapshot.

## What Phase 6 changed here

Nothing. No host identity was created or modified, no service configuration was
touched, no group membership was changed, and the credential store was not moved or
re-permissioned. This document is an assessment only. The three facts above were measured, not
remediated.

## Residual risk, stated plainly

A worker-level compromise is equivalent to a provider-credential compromise — and, on this host,
to **root**: uid 1000 has passwordless `sudo` and is in `lxd` (fact 1), so the blast radius is
the machine, not the credential store. That is the single largest host-level trust boundary
remaining in the system, and it is larger than anything Phase 6 closed: the claim prevents a
*second* execution and the snapshot prevents *falsified evidence*, but neither limits what a
compromised worker can read, and neither is a barrier to root while Step 0 is undone.

## Correction history

| Location | Was | Verdict | Now |
|---|---|---|---|
| `:33` | "the sandbox cannot read the credential. It is not mounted, `/workspace` is the only writable bind, and it has no network" | **unproven** (the most consequential one in the phase) | **NOT TESTED.** The bind set, the launched-sandbox path probe and blocked egress are cited; the attempted read does not exist. Seven-step experiment above, with a positive control |
| whole document | the custody gap is "same uid" | **understated** | three further measured facts: uid 1000 has passwordless root and `lxd`; the parent directories are `0775` so `0600` is not the control; `mcp-auth.json` is a second secret in the same directory |
| "What the next workstream must establish" | architecture items 1–5 | **incomplete** | **Step 0** precedes them: remove uid 1000 from `sudo`/`lxd`/`adm`. Separate authorised host workstream; not done here |

Nothing measured was removed: the store's mode and owner, the same-uid worker, the in-process
broker (`opencode-cli.ts:711`), the read-only `brokerDir` bind and the sandbox as the broker's
real client are direct measurements and are stated as such. No host configuration was changed to
produce the new facts.

## Evidence paths

- `apps/worker/src/config.ts:336,384` — credential source configuration
- `packages/egress-broker/src/credential.ts:19-21,194,212` — the broker reads the SQLite store, not `auth.json`; this does **not** mean there is one secret on disk (see `mcp-auth.json` above)
- `packages/agent-runtime/src/runtimes/opencode-cli.ts:711` — in-process broker start
- `packages/egress-broker/src/broker.ts:64,648` — `broker.sock`
- `packages/agent-runtime/src/sandbox/broker-contract.ts:86-89` — the read-only `brokerDir` bind the sandbox uses as the broker's client
- `packages/workspace-manager/src/sandbox.ts:302-333` — the bind set
- `packages/agent-runtime/test/credential-isolation.test.ts:251,290` — the launched-sandbox path probe and its positive control (not an attempted read)
- host commands: `ls -ln /home/ubuntu/.local/share/opencode/`, `namei -l …/opencode.db`, `id -nG`, `sudo -n whoami` (passwordless root), `sudo -n true` → exit 0
