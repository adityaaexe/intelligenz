#!/usr/bin/env bash
#
# SEC-403 — prove the spawn-discipline lint rule is live.
#
# The rule is only worth having if it fails on a bare `child_process` import and
# passes for the sanctioned owners. This asserts both by piping synthetic files
# through `eslint --stdin --stdin-filename`, so nothing is written into the tree
# and `pnpm -w lint` can run at the same time.
#
# Exit 0: the guard behaved as specified. Exit 1: it did not (or ESLint failed for
# a reason other than the rule, which is reported as a failure too).
#
# Usage: bash infra/scripts/check-spawn-discipline.sh

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../.." || exit 2

fail=0

# run_case <label> <fail|pass> <synthetic path> <single-line source>
run_case() {
  local label="$1" expected="$2" filename="$3" source="$4"
  local output status

  output=$(printf '%s\n' "$source" | pnpm exec eslint --stdin --stdin-filename "$filename" 2>&1)
  status=$?

  if [ "$expected" = "fail" ]; then
    if [ "$status" -eq 0 ]; then
      printf 'FAIL  %s — expected a lint error, ESLint exited 0\n' "$label"
      fail=1
    elif ! printf '%s' "$output" | grep -q 'no-restricted-\(imports\|syntax\)'; then
      # A parse error or broken config also exits non-zero; that is not the guard firing.
      printf 'FAIL  %s — ESLint failed, but not on the spawn rule:\n%s\n' "$label" "$output"
      fail=1
    else
      printf 'ok    %s — blocked (eslint exit %s)\n' "$label" "$status"
    fi
  else
    if [ "$status" -ne 0 ]; then
      printf 'FAIL  %s — expected no lint error, ESLint exited %s:\n%s\n' "$label" "$status" "$output"
      fail=1
    else
      printf 'ok    %s — allowed (eslint exit %s)\n' "$label" "$status"
    fi
  fi

  printf '%s\n' "$output" | sed 's/^/        /'
  printf '\n'
}

printf 'SEC-403 spawn discipline — rule behaviour\n'
printf '─────────────────────────────────────────\n\n'

run_case \
  'bare import in packages/agent-runtime/src' fail \
  'packages/agent-runtime/src/bare-spawn.fixture.ts' \
  "import { execFile } from 'node:child_process'; export const leak = (): void => { execFile('bwrap', [], {}); };"

run_case \
  'bare import in apps/worker/src' fail \
  'apps/worker/src/bare-spawn.fixture.ts' \
  "import { spawn } from 'node:child_process'; export const leak = (): void => { spawn('bwrap', []); };"

run_case \
  'bare import in infra/scripts' fail \
  'infra/scripts/bare-spawn.fixture.ts' \
  "import { execFile } from 'child_process'; export const leak = (): void => { execFile('bwrap', [], {}); };"

run_case \
  'dynamic import bypass' fail \
  'apps/worker/src/bare-dynamic.fixture.ts' \
  "export const leak = async (): Promise<unknown> => await import('node:child_process');"

run_case \
  'require() bypass' fail \
  'apps/worker/src/bare-require.fixture.ts' \
  "declare const require: (id: string) => unknown; export const leak = (): unknown => require('node:child_process');"

run_case \
  'sanctioned owner stays allowed' pass \
  'packages/workspace-manager/src/sandbox.ts' \
  "import { execFile } from 'node:child_process'; export const ok = (): void => { execFile('git', ['--version'], {}); };"

if [ "$fail" -ne 0 ]; then
  printf 'RESULT: FAIL — the guard does not behave as specified.\n'
  exit 1
fi

printf 'RESULT: PASS — bare spawns are lint errors; sanctioned owners are not.\n'
