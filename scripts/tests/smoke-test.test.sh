#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
scratch="$(mktemp -d)"
cleanup() {
  status=$?
  rm -rf -- "$scratch"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

# shellcheck source=../lib/smoke-test-helpers.sh
source "$ROOT/scripts/lib/smoke-test-helpers.sh"
export SMOKE_DIAGNOSTIC_DIR="$scratch"

events="$scratch/events"
wait_healthy() {
  local service="$1"
  printf 'wait:%s\n' "$service" >>"$events"
  if [[ "$service" == backup ]]; then
    printf 'backup:lock-held\nbackup:healthy\n' >>"$events"
  fi
}
compose() {
  printf 'manual\n' >>"$events"
  printf '/backups/kaoyan-test-manual.sqlite.gz\n'
}

: >"$events"
wait_for_initial_services
run_manual_backup_with_retry >/dev/null
test "$(grep -n '^backup:healthy$' "$events" | cut -d: -f1)" -lt "$(grep -n '^manual$' "$events" | cut -d: -f1)"
test "$(grep -c '^wait:' "$events")" = 4

retry_state="$scratch/retry-state"
printf '0\n' >"$retry_state"
compose() {
  local count
  read -r count <"$retry_state"
  count=$((count + 1))
  printf '%s\n' "$count" >"$retry_state"
  if (( count == 1 )); then
    echo 'Another backup is already running' >&2
    return 75
  fi
  printf '/backups/kaoyan-retried-manual.sqlite.gz\n'
}
result="$(SMOKE_BACKUP_RETRY_ATTEMPTS=3 SMOKE_BACKUP_RETRY_DELAY_SECONDS=0 run_manual_backup_with_retry)"
test "$result" = /backups/kaoyan-retried-manual.sqlite.gz
test "$(cat "$retry_state")" = 2

printf '0\n' >"$retry_state"
compose() {
  local count
  read -r count <"$retry_state"
  printf '%s\n' "$((count + 1))" >"$retry_state"
  echo 'Another backup is already running' >&2
  return 75
}
set +e
locked_output="$(SMOKE_BACKUP_RETRY_ATTEMPTS=3 SMOKE_BACKUP_RETRY_DELAY_SECONDS=0 run_manual_backup_with_retry 2>&1)"
locked_status=$?
set -e
test "$locked_status" = 75
test "$(cat "$retry_state")" = 3
grep -q 'lock retry exhausted after 3 attempts' <<<"$locked_output"

printf '0\n' >"$retry_state"
compose() {
  local count
  read -r count <"$retry_state"
  printf '%s\n' "$((count + 1))" >"$retry_state"
  echo 'backup integrity failed' >&2
  return 65
}
set +e
failure_output="$(SMOKE_BACKUP_RETRY_ATTEMPTS=3 SMOKE_BACKUP_RETRY_DELAY_SECONDS=0 run_manual_backup_with_retry 2>&1)"
failure_status=$?
set -e
test "$failure_status" = 65
test "$(cat "$retry_state")" = 1
grep -q 'backup integrity failed' <<<"$failure_output"

test "$(SMOKE_STORAGE_MODE=volume MSYSTEM= select_smoke_storage_mode)" = volume
test "$(SMOKE_STORAGE_MODE=bind MSYSTEM=MINGW64 select_smoke_storage_mode)" = bind
test "$(SMOKE_STORAGE_MODE=auto MSYSTEM=MINGW64 select_smoke_storage_mode)" = volume
test "$(SMOKE_STORAGE_MODE=auto MSYSTEM= OS=Windows_NT select_smoke_storage_mode)" = volume
test "$(env -u SMOKE_STORAGE_MODE -u MSYSTEM -u OS -u WSL_INTEROP bash -c 'source "$1"; select_smoke_storage_mode' _ "$ROOT/scripts/lib/smoke-test-helpers.sh")" = bind

grep -q '^  smoke-data:$' "$ROOT/compose.smoke-volumes.yml"
grep -q '^  smoke-backups:$' "$ROOT/compose.smoke-volumes.yml"
grep -q '^  smoke-caddy-data:$' "$ROOT/compose.smoke-volumes.yml"
grep -q '^  smoke-caddy-config:$' "$ROOT/compose.smoke-volumes.yml"
! grep -qE '^[[:space:]]+name:' "$ROOT/compose.smoke-volumes.yml"
grep -q 'user: "0:0"' "$ROOT/compose.smoke-volumes.yml"
grep -q 'chown 10001:10001' "$ROOT/compose.smoke-volumes.yml"
grep -q 'chmod 0750' "$ROOT/compose.smoke-volumes.yml"
grep -q '\.smoke-initialized' "$ROOT/compose.smoke-volumes.yml"
grep -q 'backup-healthy' "$ROOT/compose.test.yml"
grep -q 'down --remove-orphans --volumes' "$ROOT/scripts/smoke-test.sh"
grep -q 'export COMPOSE_FILE COMPOSE_PATH_SEPARATOR' "$ROOT/scripts/smoke-test.sh"
grep -q 'stat -c %a.*600' "$ROOT/scripts/smoke-test.sh"
! grep -q 'chmod 0777' "$ROOT/scripts/smoke-test.sh"

echo 'Docker smoke infrastructure tests passed'
