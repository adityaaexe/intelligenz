#!/usr/bin/env bash
# Phase 4 — start the worker inside its delegated cgroup leaf.
#
# This script runs as root. The worker itself never does (see
# `apps/worker/src/cgroup.ts`: there is no `sudo`, no `setuid` helper and no privileged
# syscall anywhere in the execution path).
#
# Why a wrapper is required at all — measured on this host, not assumed:
#
#   A cgroup v2 `cgroup.procs` write is authorised against **both** the source and the
#   destination cgroup. A process started from a login session lives under
#   `/user.slice/...`, which `ubuntu` does not own, so writing its child's pid into
#   `/sys/fs/cgroup/intelligenz/<attempt>/cgroup.procs` fails with EPERM even though the
#   destination is owned by `ubuntu` and world-writable. Proven with:
#
#     echo $$ > /sys/fs/cgroup/intelligenz/self-probe/cgroup.procs   → EPERM
#
#   The fix is to make the source owned too: start the worker inside
#   `/sys/fs/cgroup/intelligenz/worker`, which the setup script chowns to the worker
#   user. Then source and destination share the delegated subtree, the common ancestor
#   is owned by the worker user, and the migration is legal without privilege:
#
#     launcher(owned) → attempt(owned)  → OK  (verified)
#
# So: root writes one pid, drops uid, and execs. Everything after that is unprivileged.
#
# Usage:
#   sudo bash infra/scripts/worker-with-cgroup.sh                    # pnpm dev
#   sudo bash infra/scripts/worker-with-cgroup.sh node dist/main.js  # built worker
#
# Environment:
#   WORKER_USER   uid to run as        (default: ubuntu)
#   CGROUP_ROOT   delegation root      (default: /sys/fs/cgroup/intelligenz)

set -euo pipefail

CGROUP_ROOT="${CGROUP_ROOT:-/sys/fs/cgroup/intelligenz}"
WORKER_LEAF="${CGROUP_ROOT}/worker"
WORKER_USER="${WORKER_USER:-ubuntu}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: this wrapper must start as root (it moves one pid, then drops privilege)" >&2
  exit 2
fi

if [[ ! -d "${WORKER_LEAF}" ]]; then
  echo "error: ${WORKER_LEAF} does not exist; run: sudo bash infra/scripts/setup-cgroups.sh" >&2
  exit 3
fi

if ! id -u "${WORKER_USER}" >/dev/null 2>&1; then
  echo "error: user '${WORKER_USER}' does not exist" >&2
  exit 4
fi

WORKER_UID="$(id -u "${WORKER_USER}")"
WORKER_GID="$(id -g "${WORKER_USER}")"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

# Bound the leaf so a worker bug cannot consume the host, but do not use an agent
# profile: the worker's own footprint is not an agent's. `max` on memory is deliberate —
# capping the supervisor would make it the OOM victim when an agent misbehaves.
echo max > "${WORKER_LEAF}/memory.max" 2>/dev/null || true
echo max > "${WORKER_LEAF}/pids.max" 2>/dev/null || true

# Move this shell into the leaf. Its pid becomes the worker's pid after `exec`, and
# `setpriv` keeps it: no fork, no window in which the worker is outside its cgroup.
echo $$ > "${WORKER_LEAF}/cgroup.procs"

if [[ $# -eq 0 ]]; then
  set -- pnpm --filter @intelligenz/worker dev
fi

cd "${REPO_ROOT}"
exec setpriv \
  --reuid="${WORKER_UID}" \
  --regid="${WORKER_GID}" \
  --init-groups \
  -- "$@"
