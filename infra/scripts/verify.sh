#!/usr/bin/env bash
#
# The quality gate sequence, exactly as CI runs it (contract §12).
#
# Runs every gate even if an earlier one fails, then prints a summary — a single
# red gate should not hide the state of the others. Exit code is 1 if any failed.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

GATES=(
  "typecheck|pnpm -w typecheck"
  "lint|pnpm -w lint"
  "test|pnpm -w test"
  "build|pnpm -w build"
)

results=()
failed=0

for entry in "${GATES[@]}"; do
  name="${entry%%|*}"
  cmd="${entry#*|}"
  printf '\n════ %s ════\n' "$name"
  printf '$ %s\n\n' "$cmd"
  if bash -c "$cmd"; then
    results+=("PASS  ${name}")
  else
    results+=("FAIL  ${name}")
    failed=1
  fi
done

printf '\n════ summary ════\n'
for line in "${results[@]}"; do
  printf '  %s\n' "$line"
done

if ((failed == 1)); then
  printf '\nverify: FAILED\n'
  exit 1
fi

printf '\nverify: PASSED\n'
