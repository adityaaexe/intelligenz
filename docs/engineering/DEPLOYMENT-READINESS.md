# Deployment readiness

> Measured 2026-11-13. This document answers one question: could this build be deployed
> to a shared environment today? The answer is **no**. The sections below state each
> reason with a status, not an intention.

---

## 1. Verdict

**Not production-ready.** Not staging-ready either, in the sense of a durable shared
environment. It is a local vertical slice that runs on one host, under one user, with
one database, one Temporal dev server, and no backup.

The application code is coherent and the gates pass. The gap is everything around the
code: packaging, delivery, identity of the running system, durability, and operations.

| Area | Status | One-line reason |
|---|---|---|
| Container images | `NOT IMPLEMENTED` | Docker is absent; no image has been built; `infra/docker/` does not exist |
| Cloud infrastructure | `NOT IMPLEMENTED` | No Terraform, no account, no region, no budget authorisation; deliberately not provisioned |
| Git remote push | `BLOCKED` | No remote configured, no credential, no push from this checkout |
| CI execution | `IMPLEMENTED`, never `VERIFIED` | `gh` absent, no remote, no workflow run observed |
| Multi-replica API | `PARTIAL` | Rate limiter and readiness cache are process-local |
| Temporal durability | `PARTIAL` | Dev server on a SQLite file; survives a worker restart, not host loss |
| Artifact durability | `PARTIAL` | Local filesystem, no retention, no backup, no garbage collection |
| Secrets | `PARTIAL` | Static key in a local `.env`; no secret manager, no rotation |
| TLS and edge | `NOT IMPLEMENTED` | No TLS, no WAF, no reverse proxy, no DNS |
| Observability | `NOT IMPLEMENTED` | JSON logs to stdout; no aggregation, metrics, traces or alerts |
| Database durability | `NOT IMPLEMENTED` | No backup, no PITR; `archive_mode=off` |
| Process supervision | `NOT IMPLEMENTED` | Three foreground processes; no restart policy |

---

## 2. Packaging and delivery

### 2.1 Containers — `NOT IMPLEMENTED`

```text
$ which docker
docker: not found

$ ls infra/docker
ls: cannot access 'infra/docker': No such file or directory
```

No `Dockerfile`, no `compose.yaml`, no image, no registry. The three apps are started
by `pnpm` from a working tree. A container artifact cannot be verified on a host
without a container runtime, so none was written and then described as deployable.

What is missing: a reproducible image build per app, a pinned base image, a non-root
user, a health check, and an image scan. None exists.

### 2.2 Cloud infrastructure — `NOT IMPLEMENTED`

```text
$ which terraform
terraform: absent

$ find . -name '*.tf' -not -path './node_modules/*'
(no output)
```

No Terraform, Pulumi, CDK, Helm chart, Kubernetes manifest, or cloud CLI
configuration. No account, region, VPC, DNS zone, certificate, budget or cost
authorisation is recorded anywhere in the repository. Whether an account exists
elsewhere cannot be proven from this host; nothing here references one.

This was deliberate. Contract §0 forbids cloud provisioning and paid resources in
Phase 2. The absence is a scope decision, not an oversight. It also means there is no
environment to deploy to, even if an image existed.

### 2.3 Git remote and push — `BLOCKED`

The delegation brief states that a private GitHub repository `adityaaexe/intelligenz`
exists. That claim cannot be confirmed from this host:

```text
$ git remote -v
(no output)

$ GIT_TERMINAL_PROMPT=0 git ls-remote https://github.com/adityaaexe/intelligenz
fatal: could not read Username for 'https://github.com': terminal prompts disabled

$ curl -s -o /dev/null -w "%{http_code}\n" https://api.github.com/repos/adityaaexe/intelligenz
404
```

An unauthenticated `404` is also the response for a private repository, so it proves
neither existence nor absence. What is certain:

- The local repository has **no remote** configured.
- There is **no credential helper** (`git config --get credential.helper` returns
  nothing) and no credential available to `git`.
- **No push has occurred from this checkout.** There is one commit, `d75f988 chore:
  bootstrap monorepo scaffold`, and no remote-tracking branch.
- **All Phase 2 work is uncommitted**: `git status --porcelain` reports 93 entries,
  65 of them untracked. The scaffold commit does not contain the API, the worker, the
  web app, the schema, the tests or these documents.

The first blocker is not only the credential. The only committed revision is the
scaffold; pushing it would publish none of the implementation.

### 2.4 CI — `IMPLEMENTED`, never `VERIFIED`

`.github/workflows/ci.yml` exists. No run has been observed:

- `gh` is absent.
- No remote is configured.
- No workflow run has been observed from this host.

The workflow runs four gates, not five: `typecheck`, `lint`, `test`, `build`. It does
**not** run `pnpm --filter @intelligenz/api test:e2e`, despite the plan’s F4 acceptance
check saying it mirrors the five gate commands. The workflow provisions PostgreSQL and
Redis services, but no Temporal service, and it never invokes the API E2E suite.

The workflow also sets `JWT_SECRET: ci-placeholder-not-a-real-secret`. The hardened
validator rejects that value for insufficient entropy. CI does not boot the API today,
so it has not failed; the moment the workflow runs the API E2E suite, it will fail at
configuration load.

Status: a file that describes a pipeline, not a pipeline that ran.

### 2.5 Process supervision — `NOT IMPLEMENTED`

`pnpm dev` starts API, web and worker in the foreground with `pnpm -r --parallel`. If one
process dies, the other two keep running and nothing restarts it. There is no systemd
unit for INTELLIGENZ, no PM2 ecosystem file, no container restart policy.

PM2 is installed on the host and is running five processes. They belong to another
product (`api-server-1`, `api-server-2`, `socket-server-1`, `socket-server-2`,
`notifications-worker`), not to this repository.

---

## 3. Runtime durability

### 3.1 Single-instance API — `PARTIAL`

Two controls live in process memory:

- **Login rate limiter.** A `Map` of `(ip, email) → window`. Two API replicas have two
  independent maps, so the effective limit is `replicas × 5` per 15 minutes. A restart
  clears every window.
- **Readiness cache.** A 2-second cache of the dependency document. Two replicas each
  probe independently. This is correct but does not share work.

Neither is a defect for one process. Both become wrong under a load balancer. The code
says so in comments; this document repeats it because it is the first thing a second
replica breaks.

Redis is running on `localhost:6379` and `REDIS_URL` is declared, but **no Phase 2 code
path uses Redis**. The rate limiter is not backed by it.

### 3.2 Temporal — `PARTIAL`

Temporal is the dev server, not a cluster:

```text
$ temporal --version
temporal version 1.10.0 (Server 1.32.2, UI 2.56.1)

$ du -h .temporal/dev.db
1.7M    .temporal/dev.db
```

- Workflow state lives in `.temporal/dev.db`, a SQLite file on this host.
- A worker restart does not lose workflow state, because the state is on the Temporal
  server, not in the worker. This is inferred from the architecture; a restart was not
  performed in this session.
- Host loss loses every open workflow and the entire history. There is no backup, no
  replication, no archival, no retention configuration.
- No TLS, no authentication, no namespace isolation. It listens on `127.0.0.1:7233`,
  which limits exposure to this host but is not a security control.

The API surfaces an unreachable Temporal as `503` on `/health/ready` and as a typed
`ORCHESTRATOR_UNAVAILABLE` error on run start. That part is real and tested.

### 3.3 Artifacts — `PARTIAL`

Artifacts are files under `.artifacts/`, addressed by
`<orgId>/<taskId>/result.md`. They are gitignored.

- No retention policy. Nothing deletes old artifacts.
- No backup. Nothing copies them off the host.
- No garbage collection. Six `result.md` files exist on disk; three are referenced by
  `Artifact` rows. The other three are unreferenced. Nothing reconciles disk and
  database.
- No read-back verification. The checksum is computed at write time and stored. The API
  returns it as metadata and never re-reads the file to confirm it still matches.
- No object storage, no signed URLs, no encryption at rest beyond the host filesystem.

### 3.4 Database — `PARTIAL`

PostgreSQL 18.6 is a host instance. The schema and migrations are real. Durability is
not configured:

```text
$ sudo -u postgres psql -tAc "show archive_mode; show wal_level;"
off
replica

$ ls /var/backups/postgresql
ls: cannot access '/var/backups/postgresql': No such file or directory
```

- `archive_mode=off`: no WAL archiving, so no point-in-time recovery.
- `wal_level=replica`: enough for streaming replication, but no replica is configured.
- No `pg_dump` schedule, no base backup, no restore drill.
- The database is 9.3 MB. That is a measure of the slice, not a capacity plan.

A dropped table or a bad migration is unrecoverable beyond re-running the seed, which
would discard the proof-run records.

### 3.5 Secrets — `PARTIAL`

- `.env` exists at the repository root, mode `600`, owned by `ubuntu`, and is
  gitignored (`.gitignore:31`).
- `.env.example` is committed and contains only placeholders. `JWT_SECRET=REPLACE_ME`
  intentionally fails to boot.
- There is no secret manager, no KMS, no vault, no rotation schedule, no per-environment
  separation.
- The signing key is static. Rotating it signs every user out and requires a restart.
- CI’s placeholder is invalid under the validator (§2.4).

What is missing for staging: a managed secret store, a rotation procedure, separate
credentials per environment, and a rule that no `.env` file reaches a shared host.

### 3.6 Redis — present but unused

Redis 8.0.5 answers `PONG` on `localhost:6379`. `REDIS_URL` is in `.env.example`. No
API, worker or web code imports a Redis client. It is provisioned for a future rate
limiter or queue and is not part of the running system.

---

## 4. Network, edge and operations

### 4.1 TLS, DNS, WAF — `NOT IMPLEMENTED`

- No TLS configuration, no proxy configuration, and no DNS record are defined for this
  project.
- The API listens on `0.0.0.0:4100` over plain HTTP.
- The web app sends `Strict-Transport-Security`, but over HTTP it has no effect.
- No WAF, no request-size limit at the edge, no bot protection, no IP allowlist.
- CORS is restricted to `http://localhost:3100`. That is correct for local development
  and is not an edge control.
- The login limiter keys on the socket address, not `X-Forwarded-For`. That is
  deliberate: without `trust proxy`, the header is attacker-controlled. Behind a proxy,
  every request would appear to come from the proxy until Express `trust proxy` is
  configured. It is not configured.

### 4.2 Observability — `NOT IMPLEMENTED`

- Logs are JSON lines from `pino` to stdout. There is no file, no shipper, no index, no
  retention.
- No metrics endpoint, no counters, no histograms, no dashboards.
- No traces, although correlation ids are propagated through HTTP, workflow, activity
  and audit rows.
- No alerting. A failed login, a forged token, a readiness failure or a stuck workflow
  produces a log line that nobody collects.
- No uptime check. The only health consumer is a human running `curl`.

### 4.3 Backups and disaster recovery — `NOT IMPLEMENTED`

There is no backup of:

- PostgreSQL (`archive_mode=off`, no dump schedule).
- The Temporal SQLite file.
- `.artifacts/`.
- `.env` or any secret.

There is no restore procedure, no recovery time objective, no recovery point
objective, and no drill. The repository itself has one commit and no remote, so it is
also not backed up off-host.

---

## 5. What would break first

In the order a shared environment would hit them:

1. **No TLS.** Credentials and bearer tokens cross the network in clear text.
2. **No secret management.** The signing key is a file on one host. A second host needs
   a copy, which means a second uncontrolled copy.
3. **No backup.** The first bad migration or disk failure loses the database and the
   Temporal history.
4. **No process supervision.** A worker crash stops all execution until a human
   notices. Nothing restarts it.
5. **Single-instance controls.** A second API replica multiplies the login limit and
   duplicates readiness probes.
6. **No log aggregation.** An authentication attack leaves no durable evidence.
7. **No artifact durability.** The files are on the same host as the database; host
   loss takes both.

---

## 6. Shortest credible path to staging

Ordered. Each step unlocks the next; do not skip the first.

1. **Commit the working tree.** Create one reviewable revision containing the Phase 2
   code, schema, tests and documents. Without a commit there is nothing to deploy or
   review. Verify `git status` is clean.
2. **Configure the remote and a credential, then push.** Confirm the repository exists
   and is private. Push `main`. Enable branch protection. This is the first step that
   makes CI possible.
3. **Run CI once and make it green.** Replace the invalid CI `JWT_SECRET` with a
   generated CI-only value. Add a Temporal service and the API E2E gate (PostgreSQL is
   already declared). Record the run URL as evidence; until then CI stays
   `IMPLEMENTED`.
4. **Provision one staging host and a container build.** Docker or an equivalent
   runtime, one image per app, pinned base images, non-root users, health checks. Build
   and run the stack once end to end.
5. **Move the database to a managed instance with backups and PITR.** Restore a backup
   into a scratch instance as the acceptance test. Until a restore succeeds, the backup
   does not exist.
6. **Move Temporal to a durable deployment.** Temporal Cloud, or a self-hosted cluster
   with persistent storage, TLS, auth and a namespace per environment. Delete the
   SQLite file from the deployment path.
7. **Move artifacts to object storage.** Storage-relative keys, signed download URLs,
   a retention policy, and a lifecycle rule. Stop returning host paths.
8. **Add a secret manager and rotation.** One secret per environment, injected at
   runtime, never written to disk. Rotate the JWT key as the first exercise.
9. **Put TLS and a reverse proxy in front.** HSTS, `Cache-Control: no-store` on
   authenticated responses, request limits, and `trust proxy` configured so the login
   limiter sees the client address.
10. **Add observability before calling it staging.** Log aggregation, metrics, alerts on
    authentication failures and readiness transitions, and an uptime check.
11. **Close the governance gaps.** Audit immutability at the database grant level, a
    decision on approval separation of duties, and a two-tenant live exercise.
12. **Load test and run a screen-reader review.** Neither has been done. Both are
    acceptance criteria for a shared environment, not polish.

Steps 1–3 are cheap and unblock everything else. Step 4 is the first that costs money
or infrastructure. Steps 5–9 are the minimum for a staging environment that holds data
worth keeping. Steps 10–12 are the minimum before real users.
