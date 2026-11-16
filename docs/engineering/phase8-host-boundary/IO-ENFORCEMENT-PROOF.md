# I/O enforcement proof — Phase 8.2B

**Measured at:** `6705712` · **Host:** cgroup v2, ext4 on `/dev/nvme0n1p1`, block device `259:0`
**Verdict: R-13 BLOCKED → PASS.** Enforcement is provable, and it was proven, not inferred.

---

## 1. Why the previous verdict was wrong, twice

Phase 7 recorded `io.max` as not writable and marked I/O **BLOCKED**. Two separate errors:

| # | Error | Correction |
|---|---|---|
| 1 | Measured `/sys/fs/cgroup/io.max` — the **root** cgroup | The delegation root is `/sys/fs/cgroup/intelligenz`, and its `cgroup.subtree_control` is `cpu io memory pids`. The controller was delegated the whole time. |
| 2 | Used `lsblk`'s partition number `259:1` | `io.max` accepts the **whole block device**, not a partition: `259:1` → `ENODEV`, `259:0` → accepted |

The second error was mine and I made it worse by piping `stderr` to `/dev/null`, which hid
`write error: No such device` and produced a confident "WRITE REFUSED" from a silenced
failure. Recording it because it is the same class of mistake as the Phase 6 claim audit:
**a suppressed error is not evidence of absence.**

## 2. Delegation state

```
/sys/fs/cgroup/cgroup.subtree_control          cpu io memory pids
/sys/fs/cgroup/intelligenz/cgroup.subtree_control  cpu io memory pids
/sys/fs/cgroup/intelligenz/worker/io.max       -rw-r--r-- ubuntu:ubuntu   (writable)
```

A freshly created leaf also gets `ubuntu:ubuntu` control files — delegation is inherited, not
per-leaf.

## 3. Device granularity — the non-obvious part

| Device tried | Result |
|---|---|
| `259:1` (nvme0n1p1, the mounted partition) | **`ENODEV`** |
| `259:0` (nvme0n1, the whole disk) | **accepted**, read back `259:0 rbps=max wbps=8388608 …` |
| `7:16` (loop) | accepted |

Root `io.stat` lists only loop devices because that is where root-cgroup I/O has been
attributed — it is not a list of throttleable devices.

## 4. The measurement

Control and constrained runs both used `dd` with `oflag=direct`, so the writes bypass page
cache and reach the device.

| Run | Payload | Elapsed | Throughput |
|---|---|---|---|
| **Control** — unconstrained, as uid 1000 | 32 MiB | 0.138 s | **245 MB/s** |
| **Constrained** — `wbps=4194304` on `259:0`, through `worker-with-cgroup.sh` | 16 MiB | 3.945 s | **4.3 MB/s** |

**57× reduction**, and 4.3 MB/s is the configured 4 MiB/s (4.19 MB/s) within direct-I/O
granularity. The limit is the throughput, not noise.

## 5. The process was really in the cgroup

```
sudo bash infra/scripts/worker-with-cgroup.sh sh -c 'grep "::" /proc/self/cgroup'
→ 0::/intelligenz/worker
```

and the leaf accounted for the bytes:

```
259:0 rbytes=2600960 wbytes=719667200 rios=188 wios=2890
```

A throughput number without cgroup membership is not proof of enforcement — a slow disk
looks identical. Both were measured.

## 6. Restore

```
before:  io.max = []                      (no limit)
applied: 259:0 rbps=max wbps=4194304 riops=max wiops=max
after:   io.max = []                      (restored)
```

`dd` scratch files removed. The `worker` leaf retains its production limits (`memory.max`,
`pids.max` = `max`, as the launcher sets them).

## 7. What this does and does not establish

**Established:** the host can throttle a real process's write bandwidth to a configured
device limit, the delegated worker can be placed under it by the documented launcher, and
`io.max` readback reflects the applied value.

**Not established:**
1. **Reads.** `rbps` was left at `max`. The same mechanism applies, but it was not measured.
2. **`iops`.** `riops`/`wiops` were not exercised.
3. **Sustained behaviour.** One 16 MiB write, not a long-lived workload competing with
   another cgroup.
4. **Per-attempt enforcement.** This proves the *worker leaf*. Per-attempt child cgroups are
   where agent workloads run, and applying `io.max` there is not tested here.

Those four are the honest boundary. R-13 passes for "I/O throttling is enforceable on this
host and was demonstrated on a real process", not for "every I/O dimension is covered".

## 8. Hygiene defect found

Three test cgroup leaves were left behind by earlier runs and never removed:

```
/sys/fs/cgroup/intelligenz/cpu-budget-857041-28855/
/sys/fs/cgroup/intelligenz/oom-684210-31881/
/sys/fs/cgroup/intelligenz/oom3-687854/
```

The resource tests create leaves named by pid and do not clean up on the failure path. They
are inert but they accumulate, and a future `io.max`/`memory.max` experiment can collide with
a stale name. Recorded, not removed here — they are prior state and removing them is not part
of this proof.

## 9. Reproduction

```bash
# 1. confirm delegation
cat /sys/fs/cgroup/intelligenz/cgroup.subtree_control      # cpu io memory pids

# 2. control
dd if=/dev/zero of=/var/tmp/c.bin bs=1M count=32 oflag=direct

# 3. apply — whole disk, not the partition
echo "259:0 wbps=4194304" > /sys/fs/cgroup/intelligenz/worker/io.max

# 4. constrained, inside the leaf
sudo bash infra/scripts/worker-with-cgroup.sh \
  dd if=/dev/zero of=/var/tmp/k.bin bs=1M count=16 oflag=direct

# 5. confirm placement and attribution
sudo bash infra/scripts/worker-with-cgroup.sh sh -c 'grep "::" /proc/self/cgroup'
grep 259:0 /sys/fs/cgroup/intelligenz/worker/io.stat

# 6. restore
echo "259:0 wbps=max" > /sys/fs/cgroup/intelligenz/worker/io.max
```
