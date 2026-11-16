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
| Inner gate | HTTP Basic on `/preview` only |

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

## 3. Gate 2 — HTTP Basic on `/preview` only (observed)

| Condition | Result |
|---|---|
| `PREVIEW_USER`/`PREVIEW_PASSWORD` unset | **503** `Preview is not configured.` — no page, no challenge |
| Credentials set, no `Authorization` | **401**, `WWW-Authenticate: Basic realm="INTELLIGENZ preview"` |
| Wrong password | **401** |
| Correct credentials | **200**, 176 kB rendered page |
| `/` and `/login` without auth | **200**, no challenge — matcher is scoped, not app-wide |

The matcher is `['/preview', '/preview/:path*']`. Comparison is constant-time; the password is
never logged, echoed, or placed in a header. There is no development bypass.

## 4. Data leaving the origin

The page is **server-rendered**. There is no browser→API call, so:

- the API does not need public exposure and does not have it;
- no bearer token or `X-Org-Id` is ever in the browser;
- no tenant data is rendered: the page reads the **programme ledger** and a public readiness
  document.

Leak checks on the rendered HTML (authenticated):

| Pattern | Occurrences |
|---|---|
| the Basic password | **0** |
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
| Two gates on a phone (OTP then Basic) | Friction, not risk. Basic credentials are stored by the mobile browser after first entry |
| Basic credentials live in a `0600` file under `/tmp` | Outside the repository, not committed; lost on reboot (which also kills the tunnel) |
| The whole Next app is reachable behind the gate | `/login` and `/` are the normal app; without a session they show no tenant data. Only `/preview` is added |
| Cloudflare terminates TLS | Expected for a tunnel; traffic between Cloudflare and the origin is the tunnel's own encrypted transport |
| Tunnel process survives the session | `setsid` detaches it; the PID is recorded and the runbook gives a scoped stop command |

## 7. Operational deviation, recorded because it happened

The frontend implementer ran a broad `pkill -f "pnpm start"` while restarting the web server.
It killed the INTELLIGENZ API (restarted immediately) and could have killed unrelated
processes. Verified afterwards that ports **3000** and **4000** still belong to the unrelated
application (`node /opt/revei`, pids 1466223 / 1466250, unchanged). The command was wrong even
though the outcome was contained; the runbook and the handoff now say to stop processes by
recorded PID, never by pattern.

## 8. Condition to keep the tunnel

All of the following were observed: gate active, no data before authentication, no secret in
HTML, no API/DB/Temporal exposure, read-only surface. If any stops being true — for example
credentials are removed from the environment and the route starts answering 200 — stop the
tunnel first and investigate second.
