# Host privilege inventory — Phase 8B

**Read-only.** No sudoers, group, identity, service or credential change was made.

---

## 1. Measured privilege

```
uid=1000(ubuntu) gid=1000(ubuntu)
groups=1000(ubuntu),4(adm),24(cdrom),27(sudo),30(dip),102(lxd)

sudo -l
    User ubuntu may run the following commands on ip-172-31-2-178:
        (ALL : ALL) ALL
        (ALL) NOPASSWD: ALL

sudo -n true   → exit 0, euid root
```

**A process running as uid 1000 becomes root without a password.** This is unchanged from Phase 7 and remains the single fact that blocks five gates.

| Mechanism | Reachable | Evidence |
|---|---|---|
| Passwordless sudo | **Yes** | `sudo -n true` exits 0 |
| Password sudo | Yes | `(ALL : ALL) ALL` |
| `adm` | Yes | reads system logs, including anything the worker writes |
| `lxd` | **Membership only** | no socket at `/var/snap/lxd/common/lxd/unix.socket`, `/var/lib/lxd/unix.socket`, `/var/snap/lxd/common/lxd/` — re-verified this phase; still unreachable |
| `dip`, `cdrom` | Yes | network-config / removable media; low direct value |
| File caps on node | None | `getcap` empty |

## 2. Credential exposure

```
drwxrwxr-x ubuntu:ubuntu  /home/ubuntu/.local/share/opencode          (0775)
-rw------- ubuntu:ubuntu  …/opencode.db                               (0600)
-rw------- ubuntu:ubuntu  …/opencode.db-wal
-rw------- ubuntu:ubuntu  …/opencode.db-shm
-rw------- ubuntu:ubuntu  …/mcp-auth.json                             (0600)
```

Unchanged. Two consequences a permissions audit gets wrong:

1. **`0600` is not the control** — the parent is `0775` owned by the same uid, so `unlink`/`rename` succeed regardless of file mode.
2. **There are two secrets and a WAL.** Moving one file moves part of the problem.

## 3. Sudo dependencies — the inventory that was missing

This is the answer to "what breaks if `NOPASSWD` goes". The result is smaller and better-shaped than expected.

| Site | Requires root | Category | Runtime? |
|---|---|---|---|
| `infra/scripts/setup-cgroups.sh` | yes — `mkdir /sys/fs/cgroup/intelligenz`, `chown` to worker, enable `subtree_control` | **one-time bootstrap** | **No** |
| `infra/scripts/worker-with-cgroup.sh` | yes — writes one pid into the delegated leaf, then **drops uid and execs** | **per-start bootstrap** | Only at worker start |
| `infra/scripts/bootstrap-db.sh` | yes — one `sudo` invocation | **bootstrap** | No |
| `infra/scripts/setup-workspace-volumes.sh` | yes — loop device / mount setup | **bootstrap** | No |
| `apps/worker/src/capabilities.ts:102,103,472,479` | no | **remediation strings** shown to an operator | No |
| `apps/worker/src/cgroup.ts` | no | — | — |

**No application code invokes `sudo`.** The scripts' own header states the invariant:

> "The worker must never call `sudo`. A `sudo` in an execution path is a privilege boundary violation."

Confirmed by grep: the only internal `sudo` invocation in `infra/scripts/*.sh` is one line in `bootstrap-db.sh`. Everything else is *invoked by an operator with* sudo, not *calling* sudo.

### Consequence for the remediation

Removing `(ALL) NOPASSWD: ALL` and keeping `(ALL : ALL) ALL`:

- **does not break the running worker** — nothing in the execution path elevates;
- **does not break tests** — no test invokes sudo;
- **changes operator ergonomics** for four bootstrap scripts, which would prompt for a password;
- **removes non-interactive escalation from any compromised worker process**, which is the entire point.

**This is the safest possible shape of the fix**, and it is now evidenced rather than assumed.

## 4. Delegation is already in place

```
/sys/fs/cgroup/intelligenz            drwxr-xr-x ubuntu:ubuntu
/sys/fs/cgroup/intelligenz/worker     present
cgroup.subtree_control                cpu io memory pids
cgroup.controllers                    cpu io memory pids
```

Two corrections to earlier conclusions:

- **I/O is delegated.** `io` appears in `subtree_control`, so `io.max` is writable *inside* this subtree even though `/sys/fs/cgroup/io.max` (the root) is not. R-13 was measured at the wrong path and must be re-tested rather than left BLOCKED.
- **The 3 skipped cgroup kill tests are a launch problem, not a capability gap.** The test process runs inside a `tmux-spawn-…scope`; a `cgroup.procs` write is authorised against **both** source and destination, so migration is refused. `worker-with-cgroup.sh` exists for exactly this and is the supported launcher.

## 5. Host pressure

```
swap   4.0 GiB total, 4.0 GiB used   (100%)
```

No swap policy exists for agent workloads. Swap is fully consumed, which is both an operational risk and the most plausible explanation for the latency observed throughout this project.

## 6. Paths by which a compromised worker reaches what it must not

| Target | Path today |
|---|---|
| root | `sudo -n true` |
| provider credentials | read `opencode.db` directly (same uid) |
| operator history | same store |
| second secret | read `mcp-auth.json` |
| privileged sockets | none reachable via `lxd`; `dip` grants network config |
| broker code/config | same uid — writable |
| evidence / logs | same uid — writable |

Every row is closed by the same prerequisite: **the worker must not be uid 1000 with `NOPASSWD`.**

## 7. Proposed remediation sequence — for approval, not application

| # | Change | Needs | Breaks | Rollback |
|---|---|---|---|---|
| 0 | Inventory complete (this document) | — | — | — |
| 1 | Remove `(ALL) NOPASSWD: ALL`; keep `(ALL : ALL) ALL` | sudoers | only unattended bootstrap; operator types a password | restore `sudoers.d` backup |
| 2 | Remove uid 1000 from `adm` | group | operator log reading without sudo | `usermod -aG adm` |
| 3 | Confirm `lxd` has no socket; if so drop the group | group | nothing | re-add |
| 4 | Create `izbroker`, `izsandbox` (`nologin`) | useradd | — | `userdel` |
| 5 | Move store to `/var/lib/iz-broker` `0700 izbroker:`, WAL-consistent | chown/mv | provider calls until broker up | move back |
| 6 | `iz-broker.service` under `izbroker`, socket `0660 izbroker:izsandbox` | systemd | — | stop/disable |
| 7 | Worker as `izworker` (no sudo, adm, lxd) | service | worker restart | restore unit |
| 8 | Delete the in-process broker path | code | — | revert commit |

**Recovery must be proven before step 1**, not after: an operator must be able to open a new session and `sudo` with a password.

## 8. What this document does not claim

- It does not claim the host is hardened. It is not.
- It does not claim `lxd` is safe — only that no socket was found at the standard paths. If a socket appears, the group is an escalation path.
- It does not claim the broker design is sufficient. See `CREDENTIAL-CUSTODY-DESIGN.md` for why **two** identities are needed, not one: the broker's real client is the sandbox, so `SO_PEERCRED` cannot distinguish it from the worker unless they differ.
