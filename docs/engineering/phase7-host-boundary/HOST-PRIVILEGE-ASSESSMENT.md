# Host privilege assessment — Phase 7 Stage 2

**Commit measured at:** `afef7bd` · **Branch:** `phase-6/trust-boundary-closure`
**Method:** inspection only. **No host configuration was changed.** No credential contents were read or printed.

---

## 1. Effective privilege, measured

```
id        uid=1000(ubuntu) gid=1000(ubuntu)
          groups=1000(ubuntu),4(adm),24(cdrom),27(sudo),30(dip),102(lxd)
sudo -l   (ALL : ALL) ALL
          (ALL) NOPASSWD: ALL
sudo -n true   → succeeds (root, no password)
```

**A process running as the worker's uid can become root without a password.** This is the finding
that invalidates every same-host uid separation proposed so far.

| Mechanism | Reachable | Evidence |
|---|---|---|
| Passwordless sudo | **Yes** | `sudo -n true` exits 0 |
| Password sudo | Yes | `(ALL : ALL) ALL` |
| `adm` group | Yes | can read logs — including anything the worker logs |
| `lxd` group | **Membership yes, socket not found** | `find /var/snap /var/lib /run -maxdepth 3 -name unix.socket` → nothing. **Must be re-verified before it appears in a remediation plan**; an unreachable socket is not an escalation path and an earlier Phase 7 brief listed it without checking. |
| `dip`, `cdrom` | Yes | low direct value; `dip` grants network-config access |
| File capabilities on node | None | `getcap` empty |

## 2. Credential exposure

```
namei -l …/opencode/opencode.db
  /home/ubuntu        drwxr-x--- ubuntu ubuntu     (0750)
  .local              drwxrwxr-x ubuntu ubuntu     (0775)  ← group-writable
  share               drwxrwxr-x ubuntu ubuntu     (0775)  ← group-writable
  opencode            drwxrwxr-x ubuntu ubuntu     (0775)  ← group-writable
  opencode.db         -rw------- ubuntu ubuntu     (0600)
  opencode.db-wal     -rw------- 1000 1000   16,492,392
  opencode.db-shm     -rw------- 1000 1000       32,768
  opencode.db         -rw------- 1000 1000    1,172,377,600
  mcp-auth.json       -rw------- 1000 1000          344
```

Two conclusions that a permissions audit alone gets wrong:

1. **`0600` is not the control.** Every parent from `.local` down is `0775` owned by uid 1000, so
   `unlink` and `rename` succeed regardless of the file mode. Tightening the file proves nothing.
2. **There is more than one secret.** `mcp-auth.json` sits in the same directory, and the WAL holds
   recent writes. A custody design that moves one file moves part of the problem.

**Blast radius today:** one worker compromise = **root**, plus every provider key in a 1.17 GB
store, plus the operator's session history, plus a second credential — in a single read.

## 3. What depends on the privilege (incomplete — must precede removal)

Not yet established, and deliberately not guessed:

- whether `apt`, `systemctl`, `docker`/`lxd` or deployment scripts are invoked non-interactively
  through `NOPASSWD`;
- whether any systemd unit or cron job runs as uid 1000 and expects escalation;
- whether the operator's remote access assumes passwordless sudo.

**Removing `NOPASSWD` is the minimal change** and is safer than removing sudo entirely:
`(ALL : ALL) ALL` remains, so password-based administration and operator recovery survive, while
non-interactive escalation from a compromised worker is removed. That distinction is the whole
recommendation and must not be simplified into "delete the user from sudo".

## 4. Remediation package — for approval, not application

Ordered. Each step is independently reversible. **None has been applied.**

| # | Change | Needs auth | Interruption |
|---|---|---|---|
| 0 | Record the dependency inventory above (commands, units, scripts that rely on `NOPASSWD`) | No | none |
| 1 | Remove **only** `(ALL) NOPASSWD: ALL`, keep `(ALL : ALL) ALL` | **Yes** — sudoers | none if nothing depended on it; step 0 proves this |
| 2 | Remove uid 1000 from `adm` (log access) | **Yes** | log reading for the operator |
| 3 | Re-verify the `lxd` socket; if absent, drop the group; if present, treat as **blocker** | **Yes** | none |
| 4 | Create `izbroker` (owns credentials) and `izsandbox` (runs agent code), both `nologin` | **Yes** | none |
| 5 | Move credential store + `mcp-auth.json` to `/var/lib/iz-broker/` `0700 izbroker:izbroker`, with WAL consistency handled, not copied live | **Yes** | provider calls fail until the broker is up |
| 6 | Run the broker as `iz-broker.service` under `izbroker`, socket at `/run/iz-broker/broker.sock` mode `0660 izbroker:izsandbox` | **Yes** | none until the worker is cut over |
| 7 | Worker runs as a fourth identity without `sudo`, `adm`, `lxd` | **Yes** | worker restart |
| 8 | Delete the in-process broker path from the worker (a fallback flag is a live code path that reads the store and makes the enforcement test unprovable) | No | code change |

**Rollback:** steps 1–3 restore from a `sudoers.d` backup taken before the edit and re-add group
membership; steps 5–7 restore the previous store path and stop the new unit. **Operator recovery
must be proven before step 1**, not after.

## 5. Identity architecture (target)

```
CONTROL PLANE  (api)                      uid: izapi
      │ typed, authenticated task
SUPERVISOR / WORKER                       uid: izworker   no sudo, no adm, no lxd
      │ bounded attempt capability
UNTRUSTED EXECUTION (bwrap)               uid: izsandbox  no broker config, no db, no ptrace
      │ SO_PEERCRED-verified socket only
CREDENTIAL BROKER                         uid: izbroker   owns the store
      │ validated upstream request
PROVIDER
```

**Why four identities and not two:** the broker's real client today is the **sandbox**, not the
worker — `brokerDir` is bind-mounted into it. If the sandbox and the worker share a uid,
`SO_PEERCRED` cannot tell them apart, and the peer check becomes decoration.

## 6. What custody buys, precisely

| | Before | After |
|---|---|---|
| Credential **disclosure** | every key, one read | **closed** |
| Credential **use** | any provider | the attempt's own, capped at `maxRequests` |

The agent legitimately holds a socket to the broker and the worker mints the capability, so
**use cannot be removed** — only bounded. Claiming otherwise is the same overstatement as
"the walk cannot leave the tree".

## 7. Verification commands (for the post-change test)

```bash
setpriv --reuid=izworker --regid=izworker --clear-groups \
  cat /var/lib/iz-broker/credentials.db          # expect EACCES
setpriv --reuid=izbroker --regid=izbroker --clear-groups \
  head -c 1 /var/lib/iz-broker/credentials.db    # expect success (positive control)
sudo -n true                                      # expect denied for the worker uid
setpriv --reuid=izworker ... unlink /var/lib/iz-broker/credentials.db   # expect EACCES on the parent
```

A failing command with no positive control proves nothing: an unreachable path and a denied path
look identical.

## 8. Status

**Gate A: OPEN, and BLOCKED on step 1.** Not because the code is hard, but because a separate
broker identity under an account that can become root is theatre. No amount of application-layer
work changes that.

**Gate R-05/R-06/R-07:** `BLOCKED` — correct classification, not a code failure.

## 9. Also measured, unrelated to privilege

- **No `/dev/kvm`, no `vmx`/`svm`** → level-3 isolation is unattainable. The VM tier fails closed.
- **`io.max` is not writable at `/sys/fs/cgroup/io.max`.** `subtree_control` is
  `cpu io memory pids`, so I/O enforcement is available only inside a delegated subtree. The
  Phase 5/6 "io.max writable" justification was wrong; the PARTIAL verdict was right.
- **Swap: 4.0 GiB total, 3.9 GiB used (97%).** No swap policy exists for agent workloads. This is
  both a resource gap and a plausible cause of the observed latency.
