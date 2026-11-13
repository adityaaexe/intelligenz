#!/usr/bin/env bash
#
# Runs the three long-lived processes together: api (4100), web (3100), worker.
#
# This is the entire local deployment procedure for Phase 2 (baseline §8). There
# is no supervisor: if one process dies, the other two keep running and nothing
# restarts it. Watch the output.
#
# Ports 3000/4000 are NOT used — another product's backend owns them on this
# host (contract §15 A1). Binding them would collide with a live system.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

API_PORT="${API_PORT:-4100}"
WEB_PORT="${WEB_PORT:-3100}"
TEMPORAL_PORT="${TEMPORAL_PORT:-7233}"

log() { printf '[dev] %s\n' "$*"; }
warn() { printf '[dev] WARN: %s\n' "$*" >&2; }

# ─── Preflight ──────────────────────────────────────────────────────────────
missing=()
[[ -f apps/api/src/main.ts ]] || missing+=("apps/api/src/main.ts")
[[ -d apps/web/src/app ]] || missing+=("apps/web/src/app/")
[[ -f apps/worker/src/main.ts ]] || missing+=("apps/worker/src/main.ts")

if ((${#missing[@]} > 0)); then
  cat >&2 <<EOF
[dev] The applications are not implemented yet — this repository is at the
      scaffold stage (DO-001). dev.sh has nothing to start.

      Missing entrypoints:
$(printf '        - %s\n' "${missing[@]}")

      Order per contract §14: contracts → database → API → web → workflows.
      Re-run this script once those units have landed.
EOF
  exit 1
fi

# ─── Port guard ─────────────────────────────────────────────────────────────
port_in_use() {
  ss -ltn "sport = :$1" 2>/dev/null | grep -q LISTEN
}

for pair in "api:${API_PORT}" "web:${WEB_PORT}"; do
  name="${pair%%:*}"
  port="${pair##*:}"
  if port_in_use "$port"; then
    printf '[dev] ERROR: %s port %s is already in use. Refusing to start.\n' "$name" "$port" >&2
    printf '[dev]        Inspect with: ss -ltnp "sport = :%s"\n' "$port" >&2
    printf '[dev]        Do not kill a process you did not start.\n' >&2
    exit 1
  fi
done

# ─── Dependency hints (warn only; api and web can run without them) ─────────
if ! port_in_use "$TEMPORAL_PORT"; then
  warn "nothing is listening on ${TEMPORAL_PORT}. The worker will not connect."
  warn "start it in another terminal: bash infra/scripts/start-temporal.sh"
fi

if [[ ! -d node_modules ]]; then
  printf '[dev] ERROR: node_modules is absent. Run: pnpm install\n' >&2
  exit 1
fi

# ─── Run ────────────────────────────────────────────────────────────────────
log "api    → http://localhost:${API_PORT}"
log "web    → http://localhost:${WEB_PORT}"
log "worker → Temporal ${TEMPORAL_PORT}"
log "Ctrl-C stops all three."

exec pnpm -r --parallel --stream \
  --filter @intelligenz/api \
  --filter @intelligenz/web \
  --filter @intelligenz/worker \
  run dev
