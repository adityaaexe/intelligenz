# Phase 5 — Execution Recovery Baseline

**Branch:** `phase-5/isolation-readiness`
**HEAD at recovery start:** `5bc69cf` (Phase 4 docs commit) + uncommitted Phase 5 work
**Working tree:** dirty by design — Phase 5 workstream output, not yet committed

## 1. Subagent recovery result

The reported "running" agent was **cancelled**, not stalled: the runtime returned `state: cancelled` for `AG-502` (verify volume / output cap / CPU budget). It produced no test files and no report.

**What it did leave on disk (verified by inspection):**

| Artifact | State |
|---|---|
| `infra/scripts/setup-workspace-volumes.sh` | 11,336 bytes, provisioned 8 × 1 GiB ext4 loop volumes |
| `/var/lib/intelligenz/volumes/vol-{1..8}.img` | present, 1.0 G each, mounted `/dev/loopN` → `/var/lib/intelligenz/mnt/vol-N` |
| `registry.tsv` | written, device + mountpoint + bytes per volume |
| `packages/workspace-manager/src/volumes.ts` | 29,631 bytes, **zero tests** |
| `packages/workspace-manager/src/output-cap.ts` | present, **zero tests** |
| CPU budget | implemented in `apps/worker` (`startCpuBudgetWatch`, `checkCpuBudget`, `profile.cpuBudgetUs`), **zero tests** |
| `pnpm -w typecheck` | **exit 0** with all of the above in place |

**Conclusion:** implementation without verification. That is the exact gap this recovery cycle closes.

## 2. Disk quota — evidence retained, not re-run

Independently measured earlier in this session, and **not repeated** because a full-volume write is destructive-by-design:

```
dd if=/dev/zero of=/var/lib/intelligenz/mnt/vol-1/quota-probe.bin bs=1M count=1100
  → "No space left on device"
df: /dev/loop6  974M  958M  144K  100%  /var/lib/intelligenz/mnt/vol-1
df: /dev/root   496G  205G  292G   42%  /            ← unaffected
```

**Established:** a per-attempt filesystem ceiling, enforced by the kernel, isolated from the host filesystem.

**Not established, and not to be implied:** host-wide storage partitioning, aggregate capacity scheduling across concurrent attempts, or a reservation against host free space (loop images are sparse).

## 3. File ownership at recovery

Single writing workstream, to eliminate overlap:

| Owner | Files | Status |
|---|---|---|
| AG-503 (sole writer) | `packages/workspace-manager/test/{volumes,output-cap}.test.ts`, `apps/worker/test/cpu-budget.test.ts`; fixes limited to `src/volumes.ts`, `src/output-cap.ts`, the CPU-budget module | running |
| Integrity workstream | **not started** | deferred until resource verification commits |
| Everything else | frozen for this cycle | — |

No two agents write the same file. No nested subagents. Integrity runs after, not concurrently, because its file list is not yet mapped.

## 4. Gate snapshot at this point

| Gate | State |
|---|---|
| B isolation | Level-3 BLOCKED (no `/dev/kvm`); bwrap = `restricted-shared-kernel` |
| C CPU/memory | rate verified (Phase 4); **lifetime test pending** |
| D disk | **enforced, proven** |
| D I/O | **unknown** — `io` not delegated; measurement pending |
| E output | implemented; **test pending** |
| F approval→attempt | PASS, with documented TOCTOU |
| A, G, I, K, M, N | not started |
