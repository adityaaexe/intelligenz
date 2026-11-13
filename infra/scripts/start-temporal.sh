#!/usr/bin/env bash
#
# Starts the Temporal dev server (SQLite-backed, single binary).
#
# Installs the CLI into ~/.local/bin on first use. There is no Docker on this
# host, so this dev server *is* the workflow engine (contract §1, ADR-003).
#
# Stop it with Ctrl-C. It runs in the foreground on purpose: no supervisor, no
# daemon, no hidden process to forget about. Store lives at .temporal/dev.db and
# is gitignored — deleting it deletes all workflow history, and there is no backup.

set -euo pipefail

BIN_DIR="${HOME}/.local/bin"
TEMPORAL_BIN="${BIN_DIR}/temporal"
DB_FILE="${TEMPORAL_DB_FILE:-.temporal/dev.db}"
GRPC_PORT="${TEMPORAL_PORT:-7233}"
UI_PORT="${TEMPORAL_UI_PORT:-8233}"

log() { printf '[temporal] %s\n' "$*"; }
fail() {
  printf '[temporal] ERROR: %s\n' "$*" >&2
  exit 1
}

detect_arch() {
  case "$(uname -m)" in
    x86_64 | amd64) printf 'amd64' ;;
    aarch64 | arm64) printf 'arm64' ;;
    *) fail "unsupported architecture: $(uname -m)" ;;
  esac
}

install_cli() {
  local arch url tmp
  arch="$(detect_arch)"
  url="https://temporal.download/cli/archive/latest?platform=linux&arch=${arch}"

  command -v curl >/dev/null 2>&1 || fail "curl not found; cannot download the Temporal CLI."
  command -v tar >/dev/null 2>&1 || fail "tar not found; cannot unpack the Temporal CLI."

  log "Temporal CLI not found at ${TEMPORAL_BIN} — installing from ${url}"
  mkdir -p "$BIN_DIR"

  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # expand tmp now, not at trap time
  trap "rm -rf '${tmp}'" EXIT

  curl -fsSL --max-time 300 "$url" -o "${tmp}/temporal.tar.gz" ||
    fail "download failed (network or GitHub release unavailable)."
  tar -xzf "${tmp}/temporal.tar.gz" -C "$tmp" temporal ||
    fail "archive did not contain a 'temporal' binary."

  install -m 0755 "${tmp}/temporal" "$TEMPORAL_BIN"
  log "installed $( "${TEMPORAL_BIN}" --version 2>/dev/null || echo 'temporal CLI')"
}

[[ -x "$TEMPORAL_BIN" ]] || install_cli

"$TEMPORAL_BIN" --version >/dev/null 2>&1 || fail "${TEMPORAL_BIN} is not executable."

case ":$PATH:" in
  *":${BIN_DIR}:"*) ;;
  *) log "note: ${BIN_DIR} is not on PATH in this shell; the script uses the absolute path anyway." ;;
esac

mkdir -p "$(dirname "$DB_FILE")"

log "gRPC 127.0.0.1:${GRPC_PORT} · UI http://127.0.0.1:${UI_PORT} · store ${DB_FILE}"
log "namespace: default · task queue: see TEMPORAL_TASK_QUEUE in .env"

exec "$TEMPORAL_BIN" server start-dev \
  --ip 127.0.0.1 \
  --port "$GRPC_PORT" \
  --ui-port "$UI_PORT" \
  --db-filename "$DB_FILE"
