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

## 2. The gate

**HTTP Basic at the origin.** Cloudflare Access was tried and removed: with `--allowed-mail` the
OTP flow failed at `sso.cloudflare.dev/…cf-standard-user-authentication-flow` → `/access-denied`,
before traffic reached this host. The tunnel now runs **without** `--allowed-mail`, and the only
gate is the credential the middleware checks.

That means the URL alone is not access: an unauthenticated request gets 401 and 25 bytes.

Boundaries that still hold:

- web origin binds `127.0.0.1:3100` (`pnpm start:preview`), not `*:3100`;
- API binds `127.0.0.1:4100` (`API_HOST=127.0.0.1`), not `0.0.0.0:4100`;
- the tunnel is the only ingress.

## 3. Start

```bash
# 0. prerequisites
ss -ltnp | grep -E ':3100|:4100'        # both must be 127.0.0.1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3100/preview   # 401 without creds

# 1. tunnel — no --allowed-mail; the gate is at the origin
mkdir -p /tmp/opencode/preview
setsid nohup "$HOME/.local/bin/cloudflared" tunnel \
  --url http://127.0.0.1:3100 \
  --no-autoupdate \
  > /tmp/opencode/preview/cloudflared.log 2>&1 &
echo $! > /tmp/opencode/preview/cloudflared.pid

# 2. read the URL from the process output
grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/opencode/preview/cloudflared.log | head -1
```

## 4. Verify

```bash
URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /tmp/opencode/preview/cloudflared.log | head -1)
U=$(grep -oE 'PREVIEW_USER=[^ ]+' /tmp/opencode/preview-credentials.txt | cut -d= -f2-)
P=$(grep -oE 'PREVIEW_PASSWORD=[^ ]+' /tmp/opencode/preview-credentials.txt | cut -d= -f2-)

curl -s -o /dev/null -w '%{http_code}\n' "$URL/preview"        # 401
curl -s "$URL/preview" | grep -c 'TEMPORARY PREVIEW'            # 0
curl -s -o /dev/null -w '%{http_code}\n' -u "operator:wrong" "$URL/preview"   # 401
curl -s -o /dev/null -w '%{http_code}\n' -u "$U:$P" "$URL/preview"            # 200
```

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
