# Phase 4 — Credential Isolation

**Branch:** `phase-4/execution-trust` · **Date:** 2026-11-14
**Claim under test:** the sandbox cannot read the provider credential, and the only way a model
call leaves the host is a channel the operator configured.

**Verdict: VERIFIED.** The sandbox holds no provider credential, no credential database and no
provider configuration. Authentication is terminated by a host process (`packages/egress-broker`)
over a per-attempt unix socket. A real agent completed a real task through that channel in 10.9 s
with 5 tool calls.

---

## 1. The problem this replaces

Phase 3 mounted `<data>/opencode` into the sandbox so opencode could read its own key. Measured,
that database is **1.08 GB** and contains the provider credential **and 696 sessions of operator
history**. Masking could not fix it: opencode had to open the credential to call the model, so an
agent with a shell could open it too. Narrowing the mount was never going to work; the requirement
had to move.

Phase 4 moves authentication out of the sandbox:

```
                    ┌──────────────────────────── sandbox (--unshare-net) ───────────────────────────┐
                    │                                                                                │
  agent process ──► │  opencode                                                                      │
                    │    baseURL  http://127.0.0.1:8899      (relay, loopback in this netns only)     │
                    │    apiKey   iz-canary-<random>         (authenticates nothing upstream)        │
                    │                                                                                │
                    │  relay (node entry shim) ──► unix socket /run/agent-broker/broker.sock  (ro)    │
                    │                                                                                │
                    │  no provider credential · no opencode.db · no auth.json · no /home · no /sys   │
                    └───────────────────────────────────┬────────────────────────────────────────────┘
                                                        │  unix socket, 0600, per-attempt 0700 dir
                    ┌───────────────────────────────────▼────────────────────────────────────────────┐
                    │  host: egress broker                                                           │
                    │    1. capability token ──► foreign/absent = 403, before any path is examined    │
                    │    2. method + exact path allowlist ──► 403 otherwise                           │
                    │    3. strip inbound auth/cookies/hop-by-hop/host                                │
                    │    4. read the real credential (host store, at request time)                    │
                    │    5. inject `Authorization: Bearer <real>` ──► allowlisted upstream             │
                    │    6. append a decision line: method, path, status, bytes, duration             │
                    └───────────────────────────────────┬────────────────────────────────────────────┘
                                                        ▼
                                                  provider
```

Two boundaries, not one:

| Boundary | Property |
|---|---|
| **Network** | `--unshare-net`. The sandbox has its own loopback with no route out. Direct TCP and DNS fail, measured. |
| **Credential** | The broker holds the key. The sandbox holds a canary that the broker uses to identify the attempt, and which is worthless anywhere else. |

---

## 2. Where the secret lives

| Location | Contains the credential? | Lifetime |
|---|---|---|
| Host `opencode.db` (`credential` table) | **yes**, if `AGENT_BROKER_CREDENTIAL` is set | persistent; the operator's store |
| Host environment variable | **yes**, if `AGENT_BROKER_CREDENTIAL_ENV` is set | process lifetime |
| Broker process memory | **yes**, for the duration of one outbound request | milliseconds |
| Sandbox environment | **no** — one canary (`IZ_BROKER_CAPABILITY`) | attempt |
| Sandbox filesystem | **no** | — |
| Broker log | **no** — the log record type cannot hold a header, body or token | append-only |
| Error messages | **no** — typed errors name the source and reason, never the value | — |
| Artifacts | **no** — transcript is redacted; diff is produced inside the sandbox | — |

Two credential sources exist because a deployment that injects secrets from a manager has no
reason to keep a 1 GB SQLite file:

```ts
type CredentialSource =
  | { kind: 'opencode-db'; databasePath: string; integrationId: string }
  | { kind: 'env'; name: string };
```

The credential is read **per request**, not at boot. An expired OAuth token is refused
(`CredentialExpiredError`) rather than sent and answered with a `401`; a missing credential is
`403`, not `503`, because a retryable status makes the SDK retry a condition that cannot change —
measured: opencode retried a `503` nine times in 60 s and would have consumed the attempt budget.

**Canary, not credential.** `IZ_BROKER_CAPABILITY` is a random per-attempt string. The name
deliberately does **not** match `/KEY|TOKEN|SECRET|PASSWORD/i`, because `buildSandboxCommand`
rejects credential-shaped names — and the canary is not a secret. It proves the request came
through this attempt's relay. It authenticates nothing upstream.

---

## 3. Mount table — what the sandbox can see

Built by `buildRuntimeSandbox()` (`packages/agent-runtime/src/sandbox/broker-contract.ts`). The
test suite builds its probe from **this function**, not from a re-typed list; a test that
duplicates the mount list can pass while the adapter mounts something else, which is how the
Phase 3 exposure survived its own regression test.

| Container path | Source | Mode | Content |
|---|---|---|---|
| `/opt/agent` | per-run entry dir | `ro` | the node entry shim |
| *(node root)* | node installation | `ro` | node + `opencode` binary; read-only so the agent cannot modify its runtime |
| `/cfg` | per-run config dir | `ro` | generated `opencode.json` — provider id `izbroker`, canary key |
| `/run/agent-broker` | per-run broker dir | `ro` | `broker.sock` only; read-only so the agent cannot replace the socket with its own |
| `/workspace` | disposable clone | `rw` | the only writable host content |
| `/etc` | host | `ro` | |
| `/proc` | virtual | — | PID namespace |
| `/dev` | minimal tmpfs | — | |
| `/tmp`, `/run` | tmpfs | — | |
| `/xdg-data`, `/xdg-state`, `/xdg-cache`, `/xdg-config` | **none** | `--dir` | **created empty inside the sandbox**, writable, die with it |
| `/xdg-*/opencode` | **none** | `--dir` | the run's own session SQLite, locks, cache |

**Absent, and this is the point:** `/home`, `/root`, `~/.local/share/opencode`, `opencode.db`,
`auth.json`, `/sys` (so `cgroup.procs` is unreachable), any host XDG directory.

`buildEphemeralStatePlan()` takes **no arguments**. There is no `dataHome`, no `configHome`, and no
path it could mount even if a future caller passed one. A caller cannot reintroduce the Phase 3
mount without changing that file and its tests.

**Status: VERIFIED** — `state-mounts.test.ts` (4 tests) reads from inside a real sandbox built
from the production plan; `credential-isolation.test.ts` (11) does the same for credential paths,
environment shape, `/proc/*/environ` and egress.

---

## 4. Socket and token

| Property | Value | Test |
|---|---|---|
| Directory mode | `0700`, per attempt | `broker.test.ts` — "creates a 0600 socket in a 0700 directory" |
| Socket mode | `0600` | same |
| Token | `iz-canary-` + 24 random bytes (base64url), per attempt, passed as `Authorization: Bearer` or `x-iz-broker-token` | `broker.test.ts` |
| Comparison | constant-time (`timingSafeEqual`), hashed lengths equalised | `broker.ts` |
| Token checked | **before** the health route and before any path parsing, so an unauthenticated caller learns nothing about which paths exist | `broker.ts` §1 |
| Foreign token | `403 BROKER_TOKEN` | `broker.test.ts`; `sandbox-attempt.test.ts` from inside the sandbox |
| Absent token | `403 BROKER_TOKEN` | same |

The socket is bound **read-only** into the sandbox. Connecting needs no write access; a read-only
bind means the agent cannot unlink it and put its own listener in its place.

---

## 5. Destination and header boundary

**Destination is broker-chosen.** The caller sends `/v1/chat/completions`; the broker maps that
onto its configured `upstreamBaseUrl`. There is no header, path or query that redirects it, which
is a stronger property than matching the caller's request against an allowlist.

| Request | Result |
|---|---|
| Approved path (`/v1/chat/completions`, `/v1/completions`, `/v1/embeddings`, `/v1/models`, `/v1/responses`) | forwarded |
| `/v1/files`, `/`, `/v2/…`, `..` inside a path | `403`, logged |
| `CONNECT` | no response (the broker is not a proxy) |
| Absolute-form `http://evil.test/v1/chat/completions` | normalised onto the configured upstream |
| `//evil.test/v1/chat/completions` | same |
| `Host: evil.test` | stripped; upstream saw `host: 127.0.0.1:<port>` every time |

**Headers.** Inbound `authorization`, `x-api-key`, `cookie`, `cookie2`, `proxy-authorization`,
`proxy-authenticate`, `host`, `accept-encoding` and hop-by-hop headers are stripped. The only
`Authorization` that reaches the provider is the broker's own.

`accept-encoding` is stripped for a measured reason: the broker streams bytes without
decompressing them. Forwarding `gzip` made the upstream gzip the SSE stream, the broker passed the
bytes through and dropped the header, and the client saw binary garbage.

**What this is not.** The broker does not inspect or redact request or response bodies. It is a
credential boundary and a destination boundary, not a content filter. `--unshare-net` remains the
control that stops the agent opening any other socket.

---

## 6. Adversarial results

Executed from inside the production sandbox layout, unless marked otherwise.

| Attack | Result | Evidence |
|---|---|---|
| Read `~/.local/share/opencode`, `opencode.db`, `auth.json` from inside | all absent; `/home` does not exist in the mount namespace | `credential-isolation.test.ts`; audit probe1/2 |
| Read another process's environment | unreadable; PID 1 is `bwrap`; 4 pids; `NSpid: 1` | "cannot read another process's environment, and cannot see host processes" |
| Find a credential-shaped env var | none matching `/KEY\|TOKEN\|SECRET\|PASSWORD/i` | "has no environment key that looks like a credential" |
| Find a second high-entropy value | exactly one — the canary | "carries only one high-entropy value" |
| Use a proxy variable as a second egress path | none set | "sets no proxy variable" |
| Connect directly to the provider, or resolve DNS | both fail | "has no direct provider egress and no DNS" |
| Present no token to the broker | `403` | `broker.test.ts`; `sandbox-attempt.test.ts` |
| Present another attempt's token | `403` | same |
| Smuggle `authorization` / `x-api-key` / `cookie` upstream | stripped; real key injected | "injects the real credential and strips every inbound auth header" |
| Ask for an unapproved path or method | `403`, logged | "refuses a destination that is not an approved path", "refuses a method the broker does not serve" |
| Redirect via `CONNECT`, absolute-form, `//host`, `Host` | destination unchanged at the stub upstream | `broker.test.ts` — "never leaves the configured origin"; audit probe9/10 |
| Recover the key from the broker log | 17 lines, no key, no canary; record shape cannot hold either | "records every decision without a token, a header or a body" |
| **Make the worker's environment reachable through the evidence sandbox** | **closed** — `env` is required, `execSandboxed` is the only spawn; canary absent on the production path, present on the old call shape | `sandbox-env-isolation.test.ts` (5, including the negative control) |
| Normal `HEAD`/`GET` on the health route without a token | `403` — the token is checked before routing | `broker.ts` §1 |

### The positive control

`credential-isolation.test.ts` includes "shows the probe is capable of detecting a leak (positive
control)": the same probe, run against an environment where a secret **is** present, reports it.
Without that, "no secret found" could mean the probe was broken, the path was unreadable for an
unrelated reason, or `bwrap` was missing and the probe returned an empty result.

---

## 7. The real run

| Measurement | Value |
|---|---|
| Outcome | real failing test fixed; suite re-run inside the sandbox passed |
| Wall clock | 10.9 s |
| Tool calls | 5 |
| Tokens | 18,623 in / 151 out |
| Cost | provider-reported **$0.000000** — Google's OpenAI-compatible surface reports `usage` but no cost field; the run was free tier |
| Credential in sandbox | none |
| Credential in artifacts | none |

The cost number is reported exactly as the provider gave it. It is not "free"; it is "the provider
did not bill and did not report a cost", and the ledger records `costSource: "provider"` with
`0`, which is a measurement of the report, not of the price.

---

## 8. Residual risks

1. **Repository-defined git filters still execute** in the evidence sandbox. The `env` fix removed
   the worker-environment disclosure. It did not remove the agent's ability to run a filter during
   evidence collection. That is an integrity question (the diff is the filter's output), not a
   confidentiality one, and it is recorded rather than claimed as closed.
2. **F4 is open.** The broker forwards unknown inbound headers, including `x-forwarded-*` and
   `openai-organization`. A provider or intermediary that trusts them is reachable with
   attacker-chosen values. The destination cannot be redirected, and the credential cannot be
   replaced — this is a header-trust residual, LOW.
3. **F5 is open.** `/proc/self/cgroup` inside the sandbox discloses the attempt cgroup path. No
   escalation by itself; `--unshare-cgroup` would remove it.
4. **The broker is not a content filter.** Data the agent chooses to send to the provider goes to
   the provider. `--unshare-net` prevents other destinations; it does not prevent the configured
   one.
5. **One credential serves every org's runs.** There is no per-tenant key. A provider-side
   revocation affects all tenants at once, and usage attribution stops at the broker log.
6. **The sandbox shares the host kernel and the worker's uid.** No `--unshare-user`, no seccomp,
   no LSM. If the kernel's syscall surface is escaped, the credential boundary is irrelevant.
7. **`AGENT_BROKER_CREDENTIAL_ENV` puts the key in the worker process environment.** In that mode,
   a future `env`-inheritance bug of the F1 class would expose the provider key itself, not just
   platform secrets. The lint guard and the required-field change exist to prevent exactly that;
   the safer deployment is a secret manager read through `AGENT_BROKER_CREDENTIAL_DB` or a future
   broker-side vault source.
