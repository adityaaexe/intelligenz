# Preview security review — temporary public ingress

**Verdict: the preview may stay up, with the two gates described below.**
Every claim here was observed on this host at the time of writing, not inferred from the
design.

---

## 1. What is exposed

| Item | Value |
|---|---|
| Public URL | `https://sci-imagination-velocity-nhs.trycloudflare.com` |
| Origin | `http://127.0.0.1:3100` (Next.js `next start`) |
| Tunnel | Cloudflare Quick Tunnel, `cloudflared 2026.11.0` |
| Restriction | `--allowed-mail adi3814x@gmail.com` (verified present in argv) |
| Gate | **HTTP Basic at the origin** (96-bit credential, loopback-bound). Cloudflare Access was removed after its OTP flow failed before reaching us — see §3. |
| Bindings | web `127.0.0.1:3100`, API `127.0.0.1:4100` — loopback only |

**Not exposed:** `4100` API, `5432` Postgres, `6379` Redis, `7233`/`8233` Temporal, SSH, any
worker or host endpoint. Only 3100 is tunneled.

## 2. Gate 1 — Cloudflare email allowlist (observed)

```
$ curl -sS -o body -D headers https://…trycloudflare.com/preview
HTTP/2 302
location: https://login.trycloudflare.com/authorize?hostname=…
set-cookie: __Secure-cloudflared-qt-auth-state-…; HttpOnly; Secure; SameSite=None
```

- An unauthenticated request is redirected to `login.trycloudflare.com`; it never reaches the
  application.
- The response body is **0 bytes** and contains **no** dashboard data (`grep` for
  `TEMPORARY PREVIEW` and `15 / 32` → 0 matches).
- The auth-state cookie is `HttpOnly`, `Secure`, `SameSite=None`, 10-minute max-age.
- The allowlist is a single address; no wildcard domain was granted.

**Not verified by me:** the successful email OTP path. Completing it requires the operator's
mailbox, so "the authorised user reaches the page" is proven only up to the gate. The
operator's first visit is the acceptance test for that leg.

## 3. Current gate: HTTP Basic at the origin (2026-11-17)

Three access models were tried in one day, and the third is the one that works. The history is
kept because each failure explains why the next was chosen.

| Model | Outcome |
|---|---|
| Cloudflare `--allowed-mail` **plus** Basic | The operator could not get past the second prompt on a phone |
| Cloudflare `--allowed-mail` alone | The OTP flow failed: `sso.cloudflare.dev/…cf-standard-user-authentication-flow` → `/access-denied`. The tunnel's own log confirmed `Authentication: One-Time PIN (using Cloudflare Access)` and `Allowed recipients: 1 address`, so the allowlist was correct and the failure was inside Cloudflare's identity service — before any request reached this host |
| **HTTP Basic at the origin, tunnel without an allowlist** | **Current.** Verified end to end from the public URL |

Why this is acceptable for a read-only preview, stated plainly:

- the page cannot write, cannot start or stop anything, holds no session, and renders no tenant
  data;
- both origins are loopback-bound, so the tunnel is the only ingress;
- the credential is 96 bits, generated locally, stored `0600` outside the repository, and is the
  only thing standing between a visitor and a read-only page.

Why it is weaker than an identity provider, stated just as plainly: one shared secret, no
per-person identity, no per-device revocation, no second factor, no expiry, no audit trail of who
viewed. It is accepted **because** the IdP is broken, there is one operator, and the content is
read-only. If this page ever gains a mutating control or tenant data, a real identity gate is
mandatory again.

## 3a. What was actually observed on the public path

| Request | Result |
|---|---|
| `GET /preview` with no credentials | **401**, 25-byte body, `WWW-Authenticate: Basic realm="INTELLIGENZ preview"`, **0** data markers |
| `GET /preview` with a wrong password | **401** |
| `GET /preview` with the correct credential | **200**, 187 883 bytes, `TEMPORARY PREVIEW` / `15 / 32` / `P83-007` / `NOT CHECKED` present |
| `GET /` with no credentials | **401** (the rewrite sits behind the gate) |
| `GET /` on localhost, no credentials | **200**, the normal app, no preview marker |

## 3b. Why a rewrite, not a redirect

A redirect must name an absolute origin, and behind a tunnel the forwarded `Host` is exactly what
is uncertain — the earlier attempt emitted `http://localhost:3100/preview`, which on a phone
means the phone. An internal rewrite has no `Location` at all. Tunnel detection accepts
`cf-connecting-ip` (which Cloudflare always sets and a local browser never sends) as well as the
host suffix.

## 4. Data leaving the origin

The page is **server-rendered**. There is no browser→API call, so:

- the API does not need public exposure and does not have it;
- no bearer token or `X-Org-Id` is ever in the browser;
- no tenant data is rendered: the page reads the **programme ledger** and a public readiness
  document.

Leak checks on the rendered HTML (authenticated):

| Pattern | Occurrences |
|---|---|
| `PREVIEW_PASSWORD` / `PREVIEW_USER` (the removed control — checked to prove it is gone) | **0** |
| `DATABASE_URL` | 0 |
| `JWT_SECRET` | 0 |
| `127.0.0.1` | 0 |
| `localhost:4100` | 0 |
| `postgres://` | 0 |

Field allowlist: the loader selects named fields from the ledger; `evidenceRequirement.note`
is truncated at parse time and **not rendered**; artifact paths are rejected if absolute,
`~`-relative, drive-lettered, or containing `..`.

## 5. Read-only guarantees

- No mutating control exists on the page: no cancel, approve, run, retry, deploy, or shell.
- No endpoint accepts a command, a path, or a query that reaches the filesystem beyond the
  fixed ledger path.
- Filters are anchors (`?status=blocked`) handled server-side; there is no client JS, no
  polling, and no SSE (Quick Tunnels do not support SSE).
- The dashboard cannot start, stop, or modify anything: it reads two sources and renders.

## 6. Residual risks, stated

| Risk | Assessment |
|---|---|
| Quick Tunnel is a public ingress | Accepted for a preview: the email gate authenticates before the origin, and the page is read-only public-interest data |
| One mailbox controls access | Accepted and stated: the OTP is bound to `adi3814x@gmail.com`. It is stronger than a shared password that has appeared in a transcript, and weaker than a per-user account. A read-only page does not justify building one |
| The whole Next app is reachable behind the gate | `/login` and `/` are the normal app; without a session they show no tenant data, and `/` and `/login` are rewritten to `/preview` for tunnel visitors. Only `/preview` is added |
| Cloudflare terminates TLS | Expected for a tunnel; traffic between Cloudflare and the origin is the tunnel's own encrypted transport |
| Tunnel process survives the session | `setsid` detaches it; the PID is recorded and the runbook gives a scoped stop command |
| `x-middleware-rewrite` names the internal origin | Next emits `http://localhost:3100/preview` on a rewrite. Browsers ignore it and it is not a redirect primitive, so it cannot misdirect a phone; it does disclose that the origin is local. Recorded, not hidden |

## 7. Operational deviation, recorded because it happened

The frontend implementer ran a broad `pkill -f "pnpm start"` while restarting the web server.
It killed the INTELLIGENZ API (restarted immediately) and could have killed unrelated
processes. Verified afterwards that ports **3000** and **4000** still belong to the unrelated
application (`node /opt/revei`, pids 1466223 / 1466250, unchanged). The command was wrong even
though the outcome was contained; the runbook and the handoff now say to stop processes by
recorded PID, never by pattern.

## 8. Condition to keep the tunnel

All of the following were observed: gate active, no data before authentication, no secret in
HTML, no API/DB/Temporal exposure, read-only surface, both origins loopback-bound. If any stops
being true — for example the tunnel starts answering 200 without Cloudflare Access, or an origin
binds to `0.0.0.0` again, or the page gains a mutating control — stop the tunnel first and
investigate second.
