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
| Inner gate | **none** — the Basic gate was removed on 2026-11-17 (§3); Cloudflare Access is the only authentication |
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

## 3. Superseded: the second gate was removed (2026-11-17)

The preview previously required HTTP Basic auth as a second gate. **It has been removed**, for
two reasons recorded rather than hidden:

1. It was the step the operator could not get past on a phone, so the stronger gate (Cloudflare
   Access, bound to one mailbox) was unusable behind it.
2. Its password had been transmitted in a chat transcript, which made it the weakest credential
   in the path — weaker than the email OTP.

The authentication model is now **one gate**: Cloudflare Access with `--allowed-mail`, verified
above. There is no application-level credential on `/preview`, and no `PREVIEW_*` environment
variable is read anywhere in the web app.

What replaces the second gate is a **network boundary**, not a secret:

| Control | State |
|---|---|
| Web origin | `127.0.0.1:3100` — loopback only; LAN request returns `000` (connection refused) |
| API origin | `127.0.0.1:4100` — loopback only; LAN request returns `000` |
| Public ingress | the tunnel only, behind Cloudflare Access |

Before this change the API listened on `0.0.0.0:4100`, so anything on the LAN could reach it and
bypass the tunnel entirely. That is fixed; the subagent review that found it is credited in the
commit.

A rewrite, not a redirect, sends a tunnel visitor from `/` and `/login` to `/preview`: a redirect
must name an absolute origin, and the forwarded `Host` is exactly what is uncertain behind a
tunnel. `cf-connecting-ip` is the authoritative signal that a request came through Cloudflare.

**The trade-off, stated:** anyone who controls the authorised mailbox can view the page. The page
is read-only, renders no tenant data, holds no session, and has no mutating control. If any of
those stop being true, an application-level gate becomes mandatory again.

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
