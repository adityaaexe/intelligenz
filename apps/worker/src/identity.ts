import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';

/**
 * The identity a lease is written under: `host:pid:bootId`.
 *
 * Why all three parts:
 *
 * - **host** — two workers on the same host look identical without it, and the reaper
 *   runs on both.
 * - **pid** — a restarted worker gets a new pid, so a stale lease left by the previous
 *   process is visibly not the current one.
 * - **bootId** — a pid is only unique within one boot. Without it, a container that
 *   restarts and reuses pid 7 in a new boot looks like the same owner.
 *
 * It is deliberately not a foreign key. A worker is a process; the row must remain
 * meaningful (and attributable) after that process no longer exists, which is exactly
 * when the reaper reads it.
 */

let cached: string | undefined;

function readBootId(): string {
  try {
    return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
  } catch {
    // Not Linux, or /proc not mounted. A random id would break the "same owner across
    // heartbeats" property, so the pid plus host is the honest fallback.
    return 'no-boot-id';
  }
}

export function workerIdentity(): string {
  cached ??= `${hostname()}:${String(process.pid)}:${readBootId()}`;

  return cached;
}

/** Test seam: a fixture needs a deterministic owner, or two "workers" in one process. */
export function setWorkerIdentity(value: string): void {
  cached = value;
}

export function resetWorkerIdentity(): void {
  cached = undefined;
}
