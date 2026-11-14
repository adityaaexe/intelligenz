#!/usr/bin/env bash
# Phase 4 — one-time cgroup v2 delegation for the worker.
#
# Why this exists as a separate root-only step:
#
#   The worker must never call `sudo`. A `sudo` in an execution path is a privilege
#   escalation primitive reachable from a scheduled activity, and an agent that can
#   influence what runs next can influence when it runs. So the root-owned part —
#   creating one delegated subtree and handing it to the worker's uid — happens once,
#   here, by an operator. After that the worker creates `/sys/fs/cgroup/intelligenz/
#   <attemptId>/`, writes its limits and reads its own usage as an ordinary user.
#
# What it does, and why each step is needed:
#
#   1. mkdir /sys/fs/cgroup/intelligenz
#        A cgroup v2 hierarchy is a directory tree. This is the worker's delegation
#        root: everything the worker creates lives underneath it, and nothing else does.
#
#   2. enable +cpu +memory +pids on the parent's subtree_control
#        Controllers are delegated *downward*. The root already has `cpu memory pids`
#        in `cgroup.subtree_control` on this host; if that ever changes, the child
#        would silently lose `memory.max` and the worker would claim enforcement it
#        does not have. This script re-asserts it rather than assuming it.
#
#   3. enable +cpu +memory +pids on /sys/fs/cgroup/intelligenz/cgroup.subtree_control
#        Step 2 makes the controllers *available* to `intelligenz`; this step makes
#        them available to its **children** — the per-attempt cgroups. Without it an
#        attempt directory has no `memory.max` file at all.
#
#   4. chown the subtree to the worker user
#        So `mkdir`, `cgroup.procs`, `memory.max`, `cgroup.kill` are writable without
#        privilege. `cgroup.subtree_control` is deliberately left root-only after this
#        script runs (see the note at step 4) so a worker bug cannot re-delegate.
#
#   5. print the resulting controllers as proof
#        The script's output is the evidence. A control is not in place because this
#        file exists; it is in place because `cgroup.controllers` says so afterwards.
#
# Idempotent: running it twice changes nothing and exits 0.
#
# Usage:
#   sudo bash infra/scripts/setup-cgroups.sh
#   sudo bash infra/scripts/setup-cgroups.sh --teardown     # remove the subtree
#
# Exit codes:
#   0  delegated (or already delegated)
#   2  not running as root
#   3  cgroup v2 is not the mount at /sys/fs/cgroup
#   4  the parent does not expose a controller we need
#   5  the delegated subtree could not be prepared

set -euo pipefail

CGROUP_ROOT="/sys/fs/cgroup"
SUBTREE="${CGROUP_ROOT}/intelligenz"
# The worker's own leaf cgroup. Not a convenience: the kernel refuses a cross-cgroup
# `cgroup.procs` write unless the writer can write the **source** cgroup's
# `cgroup.procs` too. A process started in a login session lives under
# `/user.slice/...`, which the worker does not own, so it cannot migrate its own
# children into an attempt cgroup at all. Starting the worker inside this leaf makes
# the source writable and the migration legal — verified on this host, see
# docs/engineering/PHASE-4-CGROUP.md.
WORKER_CGROUP="${SUBTREE}/worker"
WORKER_USER="${SUDO_USER:-ubuntu}"

# The three controllers this worker's enforcement depends on, and what each one buys:
#   memory → memory.max (aggregate RSS, not per-process)
#   pids   → pids.max   (fork-bomb ceiling)
#   cpu    → cpu.max    (bandwidth: quota per period)
REQUIRED_CONTROLLERS=(cpu memory pids)

if [[ "${1:-}" == "--teardown" ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "error: --teardown needs root (try: sudo bash $0 --teardown)" >&2
    exit 2
  fi

  if [[ -d "${SUBTREE}" ]]; then
    # A cgroup with live processes cannot be removed. Say so instead of half-deleting.
    if [[ -s "${SUBTREE}/cgroup.procs" ]]; then
      echo "error: ${SUBTREE} still has processes; stop the worker first" >&2
      exit 5
    fi
    find "${SUBTREE}" -depth -type d -exec rmdir {} + 2>/dev/null || true
  fi

  echo "removed ${SUBTREE}"
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: this script must run as root (try: sudo bash $0)" >&2
  exit 2
fi

# `cgroup.controllers` is a space-separated word list. A substring test is wrong here
# (`pids` is a substring of `pidsx`), so membership is tested per word.
has_word() {
  local haystack=" $1 "
  local needle="$2"

  [[ "${haystack}" == *" ${needle} "* ]]
}

# ── 0. Refuse to run against anything but a real cgroup v2 hierarchy ──────────────
# The magic number, not the type name: `stat -f -c %T` prints `cgroup2fs` on Linux
# while `findmnt` prints `cgroup2`, and a check that depends on which tool asked is a
# check that silently changes meaning. CGROUP2_SUPER_MAGIC is 0x63677270.
if [[ "$(stat -f -c %t "${CGROUP_ROOT}" 2>/dev/null || true)" != "63677270" ]]; then
  echo "error: ${CGROUP_ROOT} is not a cgroup2 filesystem (magic is not 0x63677270);" >&2
  echo "       cgroup v1 is not supported: it has no aggregate memory.max for a subtree" >&2
  exit 3
fi

if [[ ! -f "${CGROUP_ROOT}/cgroup.controllers" ]]; then
  echo "error: ${CGROUP_ROOT}/cgroup.controllers is missing; cannot verify delegation" >&2
  exit 3
fi

# ── 1. Create the delegation root ────────────────────────────────────────────────
mkdir -p "${SUBTREE}"

# ── 2. Re-assert the parent's delegation (the worker's only source of controllers) ─
PARENT_CONTROLLERS="$(cat "${CGROUP_ROOT}/cgroup.controllers")"
PARENT_SUBTREE_BEFORE="$(cat "${CGROUP_ROOT}/cgroup.subtree_control")"

for controller in "${REQUIRED_CONTROLLERS[@]}"; do
  if ! has_word "${PARENT_CONTROLLERS}" "${controller}"; then
    echo "error: controller '${controller}' is not available at ${CGROUP_ROOT}" >&2
    echo "       available: ${PARENT_CONTROLLERS}" >&2
    echo "       the kernel was built without it, or another hierarchy owns it" >&2
    exit 4
  fi

  if ! has_word "${PARENT_SUBTREE_BEFORE}" "${controller}"; then
    echo "+${controller}" > "${CGROUP_ROOT}/cgroup.subtree_control"
  fi
done

# ── 3. Delegate the same controllers to the *children* of the subtree ────────────
# This is the step that makes `memory.max` exist inside an attempt cgroup. It is done
# here, as root, so the worker never has to write its own delegation boundary.
SUB_CONTROLLERS="$(cat "${SUBTREE}/cgroup.controllers")"
SUB_SUBTREE_BEFORE="$(cat "${SUBTREE}/cgroup.subtree_control" 2>/dev/null || true)"

for controller in "${REQUIRED_CONTROLLERS[@]}"; do
  if ! has_word "${SUB_CONTROLLERS}" "${controller}"; then
    echo "error: '${controller}' did not reach ${SUBTREE} (controllers: ${SUB_CONTROLLERS})" >&2
    exit 4
  fi

  if ! has_word "${SUB_SUBTREE_BEFORE}" "${controller}"; then
    echo "+${controller}" > "${SUBTREE}/cgroup.subtree_control"
  fi
done

# ── 3b. Optional controllers ─────────────────────────────────────────────────────
# `io` is separate from the three the limits depend on: `io.max` support is a property of
# the block device as much as of the kernel, so its absence is a degraded state to
# *report*, not a reason to refuse the whole delegation. The worker probes it and says
# "unsupported" with the errno if it is missing (apps/worker/src/capabilities.ts).
#
# Delegating it needs two writes, both here, both as root: `+io` at the root to make it
# available to `intelligenz`, then `+io` in `intelligenz` to make `io.max` exist inside an
# attempt cgroup. Doing it lazily at runtime is impossible: `cgroup.subtree_control` is
# root-owned on purpose so a worker bug cannot widen its own boundary.
OPTIONAL_CONTROLLERS=(io)

for controller in "${OPTIONAL_CONTROLLERS[@]}"; do
  if ! has_word "${PARENT_CONTROLLERS}" "${controller}"; then
    echo "note: controller '${controller}' is not available at ${CGROUP_ROOT}; io.max will be reported as unsupported"
    continue
  fi

  if ! has_word "$(cat "${CGROUP_ROOT}/cgroup.subtree_control")" "${controller}"; then
    if echo "+${controller}" > "${CGROUP_ROOT}/cgroup.subtree_control" 2>/dev/null; then
      echo "delegated +${controller} at ${CGROUP_ROOT}"
    else
      echo "note: could not delegate +${controller} at ${CGROUP_ROOT}; io.max will be reported as unsupported"
      continue
    fi
  fi

  if ! has_word "$(cat "${SUBTREE}/cgroup.controllers")" "${controller}"; then
    echo "note: '${controller}' did not reach ${SUBTREE}; io.max will be reported as unsupported"
    continue
  fi

  if ! has_word "$(cat "${SUBTREE}/cgroup.subtree_control" 2>/dev/null || true)" "${controller}"; then
    if echo "+${controller}" > "${SUBTREE}/cgroup.subtree_control" 2>/dev/null; then
      echo "delegated +${controller} to the children of ${SUBTREE}"
    else
      echo "note: could not delegate +${controller} to the children of ${SUBTREE}"
    fi
  fi
done

# ── 3c. The worker's own leaf ────────────────────────────────────────────────────
# A leaf: it holds processes, so it must not have `cgroup.subtree_control` enabled.
# Its own usage is charged to the (unlimited) parent, which is deliberate — the worker
# must not be capped by an agent's profile.
mkdir -p "${WORKER_CGROUP}"

# ── 4. Hand the subtree to the worker uid ────────────────────────────────────────
if ! id -u "${WORKER_USER}" >/dev/null 2>&1; then
  echo "error: worker user '${WORKER_USER}' does not exist (override with SUDO_USER)" >&2
  exit 5
fi

WORKER_GROUP="$(id -gn "${WORKER_USER}")"

# What the worker needs, and nothing more:
#
#   intelligenz/          write on the directory → mkdir/rmdir an attempt cgroup.
#                         The *files* in it are left alone: the worker sets limits on
#                         its children, never on the subtree root.
#   intelligenz/worker/   recursively, because a `cgroup.procs` write is checked
#                         against both the source and the destination cgroup. This is
#                         the source.
#
# `cgroup.subtree_control` stays root-owned: re-delegating controllers is a policy
# decision, and a worker that can widen its own boundary is not a boundary.
chown "${WORKER_USER}:${WORKER_GROUP}" "${SUBTREE}"
chmod 0755 "${SUBTREE}"

chown -R "${WORKER_USER}:${WORKER_GROUP}" "${WORKER_CGROUP}"

chown root:root "${SUBTREE}/cgroup.subtree_control"
chmod 0644 "${SUBTREE}/cgroup.subtree_control"

# ── 5. Print the proof ──────────────────────────────────────────────────────────
echo
echo "cgroup delegation ready"
echo "  subtree:                  ${SUBTREE}"
echo "  owner:                    $(stat -c '%U:%G' "${SUBTREE}")"
echo "  root cgroup.controllers:  $(cat "${CGROUP_ROOT}/cgroup.controllers")"
echo "  root subtree_control:     $(cat "${CGROUP_ROOT}/cgroup.subtree_control")"
echo "  subtree cgroup.controllers: $(cat "${SUBTREE}/cgroup.controllers")"
echo "  subtree subtree_control:    $(cat "${SUBTREE}/cgroup.subtree_control")"
echo "  io.max in a child:          $( [[ -f "${SUBTREE}/worker/io.max" ]] && echo present || echo absent )"
echo "  worker leaf:                ${WORKER_CGROUP} ($(stat -c '%U:%G' "${WORKER_CGROUP}"))"
echo
echo "The worker now creates ${SUBTREE}/<attemptId>/ and writes memory.max, pids.max"
echo "and cpu.max there as '${WORKER_USER}' — with no sudo anywhere in that path."
echo
echo "Start it inside its leaf so migration is legal (root at start, never at runtime):"
echo "  sudo bash infra/scripts/worker-with-cgroup.sh"
