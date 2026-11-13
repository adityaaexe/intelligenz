/**
 * A two-second cache for the readiness document.
 *
 * `/health/ready` is unauthenticated and opens a Temporal connection plus a
 * Postgres query per call (`api-contract.md` §7). An unauthenticated endpoint that
 * does fresh I/O on every request is a free amplifier: any client that can reach
 * the port can drive connection setup against both dependencies at request rate.
 * A 2-second window bounds that to one probe per two seconds per process while
 * keeping the probe useful — a readiness signal older than a couple of seconds is
 * arguably lying anyway.
 *
 * ## Monotonic, not wall clock
 *
 * Age is measured with `process.hrtime.bigint()`, which does not move backwards
 * when NTP steps the clock. `Date.now()` would let a backwards step serve a
 * "ready" document for longer than the TTL (or, on a forward step, expire it
 * instantly). The clock is injectable so a test can advance it without sleeping.
 */

export const READINESS_CACHE_TTL_MS = 2_000;

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

export interface CachedReadiness<T> {
  readonly value: T;
  /** Age of the cached document. `0` for the response to the request that probed. */
  readonly ageMs: number;
}

export class ReadinessCache<T> {
  private entry: { readonly value: T; readonly capturedAtNs: bigint } | undefined;

  constructor(
    private readonly ttlMs: number = READINESS_CACHE_TTL_MS,
    private readonly nowNs: () => bigint = () => process.hrtime.bigint(),
  ) {}

  /** Returns the document and its age, or `undefined` when there is no fresh one. */
  get(): CachedReadiness<T> | undefined {
    const entry = this.entry;

    if (entry === undefined) return undefined;

    const ageNs = this.nowNs() - entry.capturedAtNs;

    // `>=` so a document exactly at the TTL is stale: "cached for 2 seconds"
    // should not mean 2.9 seconds because of a floor somewhere.
    if (ageNs >= BigInt(this.ttlMs) * NANOSECONDS_PER_MILLISECOND) return undefined;

    return { value: entry.value, ageMs: Number(ageNs / NANOSECONDS_PER_MILLISECOND) };
  }

  set(value: T): void {
    this.entry = { value, capturedAtNs: this.nowNs() };
  }
}
