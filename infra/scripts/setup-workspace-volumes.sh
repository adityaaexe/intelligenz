#!/usr/bin/env bash
# Phase 5 — pre-provisioned bounded workspace volumes (Gate D, hard disk quota).
#
# Why this exists at all:
#
#   Gate D asks for a hard per-attempt disk quota. The measured host filesystem is ext4
#   mounted **without `prjquota`** (docs/engineering/PHASE-5-BASELINE.md §3), so
#   filesystem project quotas are unavailable and enabling them would mean `tune2fs` +
#   a remount of `/` — a host-wide change on a filesystem shared with unrelated
#   applications.
#
#   A periodic `du` sweep is not a quota: it reports a breach after the fact and needs
#   the agent to be slower than the sweep. The only mechanism that produces a real
#   kernel-level `ENOSPC` at a fixed ceiling, without touching `/`, is a **fixed-size
#   block device**. Hence: N sparse ext4 images, one loop device each, mounted ahead of
#   time.
#
# Why mounting happens here and never at runtime:
#
#   `mount` needs privilege. Phase 4's rule is that the worker never calls `sudo` and
#   makes no privileged syscall in an execution path (apps/worker/src/cgroup.ts). So the
#   privileged part is a one-time operator step — exactly like `setup-cgroups.sh` — and
#   the worker only *leases* a volume that already exists: it takes an exclusive lock
#   inside it, uses it, clears it and releases it. `docs/engineering/PHASE-5-RESOURCE-
#   ENFORCEMENT.md` records that split, and `packages/workspace-manager/src/volumes.ts`
#   is the only code that touches a volume afterwards.
#
# What it creates (default 8 × 1 GiB):
#
#   /var/lib/intelligenz/volumes/vol-1.img … vol-8.img   sparse ext4, 1024 MiB each
#   /var/lib/intelligenz/volumes/registry.tsv            the manifest the worker reads
#   /var/lib/intelligenz/mnt/vol-1 … vol-8               mounted, owned by the worker
#
# Sparseness is deliberate and is stated in the registry: the image *bounds* one
# attempt's usage but does not *reserve* host space up front. Eight 1 GiB images cost
# approximately nothing until an attempt writes into them, and eight concurrent attempts
# can therefore consume at most 8 GiB of the host. That aggregate is bounded by
# (count × size), not by (count × size) reserved.
#
# Idempotent: re-running reuses images, loop devices and mounts; it only creates what is
# missing. A volume that is already mounted is reported, not remounted.
#
# Usage:
#   sudo bash infra/scripts/setup-workspace-volumes.sh
#   sudo bash infra/scripts/setup-workspace-volumes.sh --count 8 --size-mb 1024
#   sudo bash infra/scripts/setup-workspace-volumes.sh --teardown   # umount + detach, keep images
#   sudo bash infra/scripts/setup-workspace-volumes.sh --teardown --purge  # also delete images
#
# Exit codes:
#   0  every requested volume is present and mounted
#   2  not running as root
#   3  a required tool is missing (losetup/mkfs.ext4/mount)
#   4  a volume could not be prepared (the message says which step)
#   5  the host does not have room for the requested images and --force was not given

set -euo pipefail

VOLUME_ROOT="/var/lib/intelligenz/volumes"
MOUNT_ROOT="/var/lib/intelligenz/mnt"
REGISTRY="${VOLUME_ROOT}/registry.tsv"
VOLUME_COUNT="${VOLUME_COUNT:-8}"
VOLUME_SIZE_MB="${VOLUME_SIZE_MB:-1024}"
WORKER_USER="${WORKER_USER:-${SUDO_USER:-ubuntu}}"
FORCE=0
TEARDOWN=0
PURGE=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --count) VOLUME_COUNT="$2"; shift 2 ;;
    --size-mb) VOLUME_SIZE_MB="$2"; shift 2 ;;
    --user) WORKER_USER="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    --teardown) TEARDOWN=1; shift ;;
    --purge) PURGE=1; shift ;;
    -h|--help) sed -n '2,45p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown argument $1" >&2; exit 2 ;;
  esac
done

if [[ "$(id -u)" -ne 0 ]]; then
  echo "error: this script must run as root (try: sudo bash $0)" >&2
  exit 2
fi

for tool in losetup mkfs.ext4 mount umount df truncate blkid; do
  if ! command -v "${tool}" >/dev/null 2>&1; then
    echo "error: required tool '${tool}' is not installed" >&2
    exit 3
  fi
done

# ── Teardown ─────────────────────────────────────────────────────────────────────
if [[ "${TEARDOWN}" -eq 1 ]]; then
  if [[ -f "${REGISTRY}" ]]; then
    while IFS=$'\t' read -r index _image loop mountpoint _dev _bytes; do
      [[ "${index}" == "index" || -z "${index:-}" ]] && continue

      if mountpoint -q "${mountpoint}" 2>/dev/null; then
        umount "${mountpoint}" || echo "warning: could not umount ${mountpoint}" >&2
      fi

      if [[ -n "${loop:-}" ]] && losetup "${loop}" >/dev/null 2>&1; then
        losetup -d "${loop}" || echo "warning: could not detach ${loop}" >&2
      fi
    done < "${REGISTRY}"
  fi

  # Belt and braces: anything under the mount root that is still a mount is unmounted.
  while read -r target; do
    [[ -z "${target}" ]] && continue
    umount "${target}" || true
  done < <(findmnt -rn -o TARGET --submounts "${MOUNT_ROOT}" 2>/dev/null || true)

  if [[ "${PURGE}" -eq 1 ]]; then
    rm -f "${REGISTRY}"
    rm -f "${VOLUME_ROOT}"/vol-*.img
    echo "removed workspace volume images under ${VOLUME_ROOT}"
  else
    echo "unmounted and detached; images kept under ${VOLUME_ROOT} (use --purge to delete)"
  fi

  exit 0
fi

if ! id -u "${WORKER_USER}" >/dev/null 2>&1; then
  echo "error: worker user '${WORKER_USER}' does not exist (override with --user or WORKER_USER)" >&2
  exit 4
fi

WORKER_GROUP="$(id -gn "${WORKER_USER}")"

# ── 0. Space check, and the honest statement about sparseness ────────────────────
# Sparse images are not billed until written. The risk is therefore not "the images are
# too big to create", it is "N concurrent attempts can fill the host". That bound is
# count × size and it is printed, not assumed.
REQUESTED_MB=$(( VOLUME_COUNT * VOLUME_SIZE_MB ))

# The image directory may not exist yet, and `df` on a missing path exits non-zero. Walk
# up to the nearest existing ancestor so the measurement is always of the filesystem the
# images will actually land on.
SPACE_REF="${VOLUME_ROOT%/*}"
while [[ ! -d "${SPACE_REF}" && "${SPACE_REF}" != "/" ]]; do
  SPACE_REF="$(dirname "${SPACE_REF}")"
done
AVAILABLE_MB="$(df -Pm "${SPACE_REF}" | awk 'NR==2 {print $4}')"
AVAILABLE_MB="${AVAILABLE_MB:-0}"

echo "workspace volumes: ${VOLUME_COUNT} × ${VOLUME_SIZE_MB} MiB = ${REQUESTED_MB} MiB aggregate ceiling"
echo "host free on ${SPACE_REF}: ${AVAILABLE_MB} MiB (images are sparse; nothing is reserved up front)"

if [[ "${AVAILABLE_MB}" -lt $(( REQUESTED_MB / 10 )) && "${FORCE}" -ne 1 ]]; then
  echo "error: less than 10% of the aggregate ceiling is free (${AVAILABLE_MB} MiB < $(( REQUESTED_MB / 10 )) MiB)." >&2
  echo "       Concurrent attempts can consume up to ${REQUESTED_MB} MiB. Re-run with --force to proceed." >&2
  exit 5
fi

mkdir -p "${VOLUME_ROOT}" "${MOUNT_ROOT}"

# ── 1. Prepare each volume ───────────────────────────────────────────────────────
printf 'index\timage\tloop\tmountpoint\tdevice\tbytes\n' > "${REGISTRY}.tmp"

for (( index = 1; index <= VOLUME_COUNT; index += 1 )); do
  image="${VOLUME_ROOT}/vol-${index}.img"
  mountpoint="${MOUNT_ROOT}/vol-${index}"

  # -- image ----------------------------------------------------------------------
  if [[ ! -f "${image}" ]]; then
    truncate -s "${VOLUME_SIZE_MB}M" "${image}" || {
      echo "error: could not create ${image}" >&2; exit 4; }
    echo "created sparse image ${image} ($(du -h --apparent-size "${image}" | cut -f1) apparent, $(du -h "${image}" | cut -f1) on disk)"
  fi

  # -- loop device ----------------------------------------------------------------
  # `losetup -j` finds an existing attachment for this exact file, so a re-run after a
  # reboot attaches the same image to a (possibly different) /dev/loopN without
  # stacking a second device on it.
  loop="$(losetup -j "${image}" -n -O NAME | head -n1)"
  if [[ -z "${loop}" ]]; then
    loop="$(losetup --find --show --noheadings "${image}")" || {
      echo "error: could not attach ${image} to a loop device (no free loop devices?)" >&2; exit 4; }
  fi

  # -- filesystem -----------------------------------------------------------------
  # `-m 0` is not a micro-optimisation: the default 5% reserved-block margin would make
  # a "1 GiB" volume report ~980 MiB usable and produce ENOSPC ~5% early. A bounded
  # volume should be describable by one number.
  if ! blkid -p -s TYPE "${loop}" 2>/dev/null | grep -q 'TYPE="ext4"'; then
    mkfs.ext4 -q -F -m 0 -L "iz-vol-${index}" "${loop}" || {
      echo "error: mkfs.ext4 failed on ${loop}" >&2; exit 4; }
  fi

  # -- mount ----------------------------------------------------------------------
  mkdir -p "${mountpoint}"
  if ! mountpoint -q "${mountpoint}"; then
    # `nosuid,nodev` because the volume holds agent-written files: a setuid binary the
    # agent wrote is a privilege boundary the sandbox never agreed to. `noatime` keeps
    # the quota about bytes, not inode touches.
    mount -t ext4 -o noatime,nosuid,nodev "${loop}" "${mountpoint}" || {
      echo "error: could not mount ${loop} at ${mountpoint}" >&2; exit 4; }
  fi

  chmod 0700 "${mountpoint}"
  chown "${WORKER_USER}:${WORKER_GROUP}" "${mountpoint}"

  # The device the quorum applies to, for `io.max`: taken from the mount table rather
  # than guessed from the loop name, because that is the number the kernel wants.
  device="$(findmnt -n -o MAJ:MIN --target "${mountpoint}")"
  bytes="$(findmnt -n -b -o SIZE --target "${mountpoint}")"

  printf '%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${index}" "${image}" "${loop}" "${mountpoint}" "${device}" "${bytes}" >> "${REGISTRY}.tmp"
done

mv "${REGISTRY}.tmp" "${REGISTRY}"

# ── 2. Print the proof ───────────────────────────────────────────────────────────
# A control is not in place because this script exists; it is in place because `df` and
# `findmnt` say so afterwards.
echo
echo "workspace volumes ready"
echo "  registry:      ${REGISTRY}"
echo "  owner:         ${WORKER_USER}:${WORKER_GROUP}"
echo

printf '%-6s %-12s %-14s %-22s %-12s %s\n' INDEX DEVICE SIZE AVAIL MOUNT LOOP
while IFS=$'\t' read -r index _image loop mountpoint device _bytes; do
  [[ "${index}" == "index" ]] && continue

  read -r size avail <<<"$(df -Ph "${mountpoint}" | awk 'NR==2 {print $2, $4}')"

  printf '%-6s %-12s %-14s %-22s %-12s %s\n' \
    "${index}" "${device}" "${size}" "${avail}" "${mountpoint}" "${loop}"
done < "${REGISTRY}"

echo
echo "df -h per volume:"
df -h $(awk -F'\t' 'NR>1 {print $4}' "${REGISTRY}")

echo
echo "Sparseness (state this, do not hide it): the images bound one attempt each at"
echo "${VOLUME_SIZE_MB} MiB, but they do not reserve ${REQUESTED_MB} MiB of the host."
echo "Concurrent attempts can consume up to ${REQUESTED_MB} MiB in total, and the host"
echo "filesystem sees that usage only as it is written."
echo
echo "The worker now leases one volume per attempt and never mounts anything:"
echo "  WORKSPACE_VOLUMES_ROOT=${MOUNT_ROOT} pnpm --filter @intelligenz/worker dev"
