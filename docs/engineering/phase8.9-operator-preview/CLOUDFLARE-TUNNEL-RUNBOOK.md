# Cloudflare Quick Tunnel runbook — temporary preview

**This tunnel is a preview, not a deployment.** It stops when the process stops. The URL
changes on every restart. Nothing in this file is a credential.

---

## 1. What is exposed

| Exposed | Not exposed |
|---|---|
| `http://127.0.0.1:3100` — the Next.js web origin | `4100` API, `5432` Postgres, `6379` Redis, `7233`/`8233` Temporal, SSH, any worker or host endpoint |

The preview page is **server-rendered**: it reads the programme ledger and API readiness on
the server. The browser never calls the API, so the API does not need to be exposed and is
not.

## 2. One gate

**Cloudflare Access, restricted by `--allowed-mail`.** It authenticates the visitor before the
request reaches this host. There is **no** application-level credential on `/preview`: the Basic
gate was removed on 2026-11-17 (see `PREVIEW-SECURITY-REVIEW.md` §3) because it was the step the
operator could not pass on a phone, and its password had appeared in a chat transcript.

What replaces it is a network boundary, not a secret:

- web origin binds `127.0.0.1:3100` (`pnpm start:preview`), not `*:3100`;
- API binds `127.0.0.1:4100` (start it with `API_HOST=127.0.0.1`), not `0.0.0.0:4100`;
- the only public ingress is the tunnel.

Verify both bindings before starting the tunnel: a LAN address on 3100 or 4100 means the tunnel
is not the only way in.

## 3. Start

```bash
# 0. prerequisites (verify, do not assume)
ss -ltnp | grep -E ':3100|:4100'        # both must be 127.0.0.1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/preview   # 200 expected
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:4100/health/ready

# 1. start the tunnel, detached, with its log and pid recorded
mkdir -p /tmp/opencode/preview
setsid nohup "$HOME/.local/bin/cloudflared" tunnel \
  --url http://127.0.0.1:3100 \
  --allowed-mail "<OPERATOR_EMAIL>" \
  --no-autoupdate \
  > /tmp/opencode/preview/cloudflared.log 2>&1 &
echo $! > /tmp/opencode/preview/cloudflared.pid

# 2. read the URL from the process output (the only authoritative source)
grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/opencode/preview/cloudflared.log | head -1
```

Do **not** fabricate a URL. If the log does not contain one, the tunnel did not start.

## 4. Verify

```bash
URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/opencode/preview/cloudflared.log | head -1)

# unauthenticated request: Cloudflare Access answers, not the app
curl -s -o /dev/null -w '%{http_code}\n' "$URL/preview"        # expect 302 to login.trycloudflare.com
curl -s "$URL/preview" | grep -c 'TEMPORARY PREVIEW'            # expect 0 — no data before auth

# the tunnel itself is healthy
tail -20 /tmp/opencode/preview/cloudflared.log
```

Then, from a browser: open the URL, sign in with the allowed email, and expect the page — no
second prompt. If the browser shows the app login form instead, the rewrite did not fire; check
that the request carries `cf-connecting-ip` and that `Host` is the tunnel hostname.

Acceptance:

- the public URL responds;
- an unauthenticated request does **not** return ledger data;
- with the authorised email, Cloudflare's login completes and the page renders — **no second prompt**;
- `/` and `/login` reached through the tunnel render the preview (internal rewrite), while on
  localhost they still render the app unchanged;
- no secret appears in the HTML (grep the rendered body for `PREVIEW_PASSWORD`, `DATABASE_URL`,
  and the API host — all should be absent; `PREVIEW_PASSWORD` is absent because the variable is
  no longer read anywhere).

## 5. Status

```bash
PID=$(cat /tmp/opencode/preview/cloudflared.pid)
ps -o pid,etime,cmd -p "$PID"          # must show cloudflared and this URL
grep -c "ERR" /tmp/opencode/preview/cloudflared.log
```

## 6. Stop — this tunnel only

```bash
PID=$(cat /tmp/opencode/preview/cloudflared.pid)
ps -o cmd= -p "$PID" | grep -q 'cloudflared tunnel' && kill "$PID" || echo "pid does not match cloudflared; refusing"
rm -f /tmp/opencode/preview/cloudflared.pid
```

Never `pkill cloudflared`: another user's tunnel is not this process. Do not stop the web
or API servers; only the tunnel is temporary.

After stopping, the URL must no longer reach the application — re-check it, and expect a
Cloudflare error page rather than the dashboard.

## 7. Known limitations, stated up front

| Limitation | Consequence |
|---|---|
| Quick Tunnel URLs are ephemeral | the URL changes on every restart; an old bookmark dies |
| Cloudflare in-flight request limit (~200) | not a production ingress |
| **No SSE support** | the preview uses no streaming; it renders server-side per request |
| Traffic passes through Cloudflare | the tunnel is a public ingress; the email gate is what makes it acceptable for a preview |
| `--allowed-mail` is a Quick Tunnel feature | verified present in cloudflared **2026.11.0** (`Email addresses or wildcard domains allowed to access a protected Quick Tunnel`); re-verify after any upgrade |
| Preview is read-only | no cancel, approve, run or deploy controls exist on it |
