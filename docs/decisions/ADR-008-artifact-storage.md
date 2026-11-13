# ADR-008 — Artifact storage

Status: Accepted
Date: 2026-11-13

## Context

A run produces output: a diff, a log, a report, a JSON result. The product's traceability claim depends on those outputs being **retrievable later, attributable to the run that made them, and provably unchanged**. `INFORMATION-ARCHITECTURE.md` gives artifacts an object identity (`art_`) and a canonical route; `DESIGN.md` principle 3 makes evidence a first-class object with source and timestamp.

Constraints: no Docker, no object-store credentials, no cloud account, no budget authorisation. Postgres is available; so is a local filesystem.

## Decision

**A storage port with one filesystem adapter now, and an S3-compatible adapter later.**

```ts
interface ArtifactStore {
  put(input: { orgId, runId, bytes, contentType, filename }): Promise<ArtifactReference>;
  get(ref: ArtifactReference, orgId: string): Promise<ReadableStream>;
  exists(checksum: string, orgId: string): Promise<boolean>;
  // no delete() in Phase 2 — see retention
}
```

### Content addressing

- The object key is derived from the **SHA-256 of the bytes**, not from the filename, run id, or a random UUID.
- Key layout: `{ARTIFACT_ROOT}/{orgId}/{sha256[0:2]}/{sha256}` — a two-character fan-out to avoid a single directory with tens of thousands of entries.
- The database row stores: `id` (`art_` ULID), `orgId`, `agentRunId`, `checksum`, `sizeBytes`, `contentType`, `filename`, `storageKey`, `createdAt`.
- Consequences of content addressing: a retried activity that re-produces identical bytes writes the same key (idempotent by construction, no duplication); two runs producing the same bytes store one object; and the checksum is independently verifiable, so "the artifact changed" is detectable rather than arguable.
- **Accepted residual risk:** because the key includes `orgId` but the hash does not, two tenants cannot enumerate each other's objects, but a tenant that already possesses the exact bytes could confirm a match only by guessing a hash — which requires already having the content. Cross-tenant deduplication is deliberately **not** enabled: it would require a shared key namespace, and confirming that another tenant holds identical content is itself a leak. Deduplication is therefore per-tenant.

### Access control

- There is **no static file server** over `ARTIFACT_ROOT`. Artifacts are served only through `GET /v1/orgs/:orgId/artifacts/:artifactId`, which resolves the row, checks `orgId` against the authenticated membership, and streams the file.
- The filesystem path is never accepted from a request. It is derived from the database row. Path traversal is therefore not expressible.
- `Content-Disposition: attachment` for everything that is not an image, and `X-Content-Type-Options: nosniff` always. An artifact is untrusted input even when we produced it: it may contain model-generated HTML.
- No pre-signed URLs in Phase 2. When S3 arrives, pre-signing is the right mechanism for large files and must be tenant-scoped and short-lived; it also shifts the authorisation decision to signing time, which is a real weakening and must be documented then.

### Retention

- Phase 2 is **append-only**: no delete endpoint, no cleanup job, no overwrite.
- The `Artifact` table reserves `retentionClass` (`standard | evidence | ephemeral`) and `expiresAt` (nullable), both unused. They exist so that a retention policy is a policy change, not a schema migration.
- Rationale: `REVIEW-CHECKLIST.md` §5 open question 4 asks how long evidence must remain resolvable after a decision, and the review screen promises permanent links. Deleting bytes under a permanent link is a broken promise, so nothing is deleted until that question is answered.

## Consequences

### Positive

- Zero external dependencies; works on this host today.
- Retries cannot duplicate artifacts, because the key is the content.
- Integrity is verifiable without trusting the store.
- Swapping to S3 is one adapter implementing the same four methods; no caller changes.
- Tenant isolation is enforced at the API, not by filesystem permissions that are easy to misconfigure.

### Negative / costs

- **Single-host, non-durable storage.** No replication, no backup, no versioning. Host loss loses artifacts while the database rows survive — an inconsistency the system cannot currently detect. `exists()` exists precisely so a reconciliation job can be written later.
- **The filesystem is not a trust boundary.** Any process on the host can read `ARTIFACT_ROOT`. In a shared host (this one runs another product's services) that is a real exposure and must be stated as a limitation.
- Disk exhaustion is an unmonitored failure mode. No quota, no eviction, no alert.
- Per-tenant dedup means duplicated bytes across tenants. Acceptable at this size, wasteful at scale.
- No streaming during execution: the adapter takes complete bytes, so a 500 MB log must fit in memory. **Unknown — must be resolved before any run can produce large output.**
- Content addressing makes an artifact's identity independent of its run, which is correct for dedup but means "the artifact for run X" is a join, not a key. Minor, but it changes query shape.

## Alternatives considered

**Store bytes in PostgreSQL (`bytea`).** Rejected. It bloats the database and its backups, couples artifact size to the connection and WAL, and makes retention a `DELETE` that fights the audit trail. It is, however, the only option that gives transactional consistency between the artifact and its metadata — a real advantage that the filesystem adapter gives up.

**Git as the artifact store.** Rejected. Artifacts are not all text, git is not a blob store, and it couples artifact availability to repository availability. It also cannot express per-tenant access control.

**S3/MinIO now.** Blocked, not rejected: no credentials, no account, no budget authorisation, and MinIO would need Docker or a separate binary. When unblocked, the adapter interface is already the right shape.

**No artifact store — return content inline in the API response.** Rejected. It makes the response unbounded, removes the ability to link to evidence, and puts artifact bytes in logs and browser memory.

## Open item

`ARTIFACT_ROOT` is not specified by the contract. Proposed: env var `ARTIFACT_ROOT`, default `.artifacts/` at the repository root, gitignored, created by the bootstrap script. **Unknown — must be confirmed before the artifact unit (D4) starts**, because the worker, the API, and the seed must agree on one path.

## Revisit trigger

Revisit when S3/MinIO becomes available (swap the adapter, add pre-signing, keep the port), when a single artifact exceeds available memory (streaming becomes mandatory), when the host disk passes 70% (retention can no longer be deferred), or when a customer asks for artifact retention guarantees — at which point the append-only stance needs a policy, not a preference.
