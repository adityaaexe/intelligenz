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

## 2. Two gates

1. **Cloudflare Quick Tunnel email gate** — `--allowed-mail` restricts the tunnel to an
   allowlist. Cloudflare authenticates the visitor before the request reaches this host.
2. **HTTP Basic auth** on `/preview` only, credentials from `PREVIEW_USER` /
   `PREVIEW_PASSWORD`. If either is unset the route answers **503** and never falls through.

The Basic credential is generated locally for the preview and written to a `0600` file
outside the repository. It is not committed, not logged, and not in this document.

## 3. Start

```bash
# 0. prerequisites (verify, do not assume)
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/preview   # 401 or 503 expected
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

# unauthenticated request: Cloudflare's gate answers, not the app
curl -s -o /dev/null -w '%{http_code}\n' "$URL/preview"        # expect 302 (Access) or 401

# the tunnel itself is healthy
cloudflared tunnel info --help >/dev/null 2>&1 || true
tail -20 /tmp/opencode/preview/cloudflared.log
```

Acceptance:

- the public URL responds;
- an unauthenticated request does **not** return ledger data;
- with the authorised email, Cloudflare's login completes;
- then Basic auth prompts, and the page renders;
- `/` and `/login` still work and are not behind Basic auth;
- no secret appears in the HTML (grep the rendered body for `PREVIEW_PASSWORD`, the API host,
  and `DATABASE_URL`).

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
