#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2251 # Fake scripts delay expansion and use negative assertions.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
scratch="$(mktemp -d)"
cleanup() {
  status=$?
  rm -rf -- "$scratch"
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

fake_bin="$scratch/bin"
mkdir -p "$fake_bin"
cat >"$fake_bin/docker" <<'FAKE_DOCKER'
#!/usr/bin/env bash
set -u
[[ "${1:-}" == compose ]] || exit 64
shift
printf '%s\n' "$*" >>"$FAKE_DOCKER_LOG"
case "$*" in
  'ps --status running --services backup')
    state="${FAKE_BACKUP_RUNNING:-1}"
    [[ -f "${FAKE_BACKUP_STATE:-}" ]] && read -r state <"$FAKE_BACKUP_STATE"
    [[ "$state" == 1 ]] && printf 'backup\n'
    ;;
  'stop backup'|'stop api backup')
    [[ -n "${FAKE_BACKUP_STATE:-}" ]] && printf '0\n' >"$FAKE_BACKUP_STATE"
    ;;
  'up -d backup')
    [[ -n "${FAKE_BACKUP_STATE:-}" ]] && printf '1\n' >"$FAKE_BACKUP_STATE"
    ;;
  'run --rm --no-deps backup /app/scripts/backup.sh pre-update')
    printf '/backups/kaoyan-20260713T120000000000000Z-pre-update.sqlite.gz\n'
    ;;
  'run --rm --no-deps backup /app/scripts/backup.sh pre-restore')
    [[ "${FAKE_PRE_RESTORE_FAIL:-0}" == 0 ]] || exit 41
    printf '/backups/kaoyan-20260713T120100000000000Z-pre-restore.sqlite.gz\n'
    ;;
  'run --rm --no-deps api node dist/db/migrate.js')
    exit "${FAKE_MIGRATION_STATUS:-0}"
    ;;
  'exec -T api node -e '*)
    count=0
    [[ -f "$FAKE_READY_COUNT" ]] && read -r count <"$FAKE_READY_COUNT"
    count=$((count + 1))
    printf '%s\n' "$count" >"$FAKE_READY_COUNT"
    ready_after="${FAKE_READY_AFTER:-1}"
    (( ready_after > 0 && count >= ready_after ))
    ;;
  'run --rm --no-deps backup /app/scripts/restore-db.sh '*)
    count=0
    [[ -f "${FAKE_RESTORE_COUNT:-}" ]] && read -r count <"$FAKE_RESTORE_COUNT"
    count=$((count + 1))
    printf '%s\n' "$count" >"$FAKE_RESTORE_COUNT"
    [[ "${FAKE_ROLLBACK_FAIL:-0}" == 0 || "$count" -lt 2 ]]
    ;;
  *'SELECT count(*) FROM users WHERE role = char(97,100,109,105,110)'*)
    [[ "${FAKE_POSTCHECK_FAIL:-0}" == 0 ]]
    ;;
esac
FAKE_DOCKER
chmod +x "$fake_bin/docker"
cat >"$fake_bin/git" <<'FAKE_GIT'
#!/bin/sh
test "${1:-}" = rev-parse && printf '2727d1547b04617b1b9695291d08c9e5a31d5ffe\n'
FAKE_GIT
chmod +x "$fake_bin/git"

run_update() {
  printf '1\n' >"$scratch/backup.state"
  env PATH="$fake_bin:$PATH" \
    FAKE_DOCKER_LOG="$scratch/docker.log" \
    FAKE_READY_COUNT="$scratch/ready.count" \
    FAKE_BACKUP_STATE="$scratch/backup.state" \
    READINESS_ATTEMPTS="${READINESS_ATTEMPTS:-3}" \
    READINESS_DELAY_SECONDS=0 \
    FAKE_READY_AFTER="${FAKE_READY_AFTER:-1}" \
    FAKE_MIGRATION_STATUS="${FAKE_MIGRATION_STATUS:-0}" \
    bash "$ROOT/scripts/update.sh"
}

run_restore() {
  printf '1\n' >"$scratch/backup.state"
  : >"$scratch/restore.count"
  env PATH="$fake_bin:$PATH" \
    FAKE_DOCKER_LOG="$scratch/docker.log" \
    FAKE_READY_COUNT="$scratch/ready.count" \
    FAKE_RESTORE_COUNT="$scratch/restore.count" \
    FAKE_BACKUP_STATE="$scratch/backup.state" \
    READINESS_ATTEMPTS=3 READINESS_DELAY_SECONDS=0 \
    FAKE_READY_AFTER=1 \
    FAKE_PRE_RESTORE_FAIL="${FAKE_PRE_RESTORE_FAIL:-0}" \
    FAKE_POSTCHECK_FAIL="${FAKE_POSTCHECK_FAIL:-0}" \
    FAKE_ROLLBACK_FAIL="${FAKE_ROLLBACK_FAIL:-0}" \
    bash "$ROOT/scripts/restore.sh" kaoyan-20260713T120000000000000Z-manual.sqlite.gz
}

: >"$scratch/docker.log"
FAKE_READY_AFTER=3 output="$(run_update 2>&1)"
grep -q '^Deployed ' <<<"$output"
test "$(cat "$scratch/ready.count")" = 3
caddy_line="$(grep -n '^up -d caddy$' "$scratch/docker.log" | cut -d: -f1)"
backup_line="$(grep -n '^up -d backup$' "$scratch/docker.log" | tail -n 1 | cut -d: -f1)"
test "$caddy_line" -gt "$backup_line"

: >"$scratch/docker.log"
rm -f "$scratch/ready.count"
set +e
FAKE_READY_AFTER=0 READINESS_ATTEMPTS=3 output="$(run_update 2>&1)"
status=$?
set -e
test "$status" -ne 0
test "$(cat "$scratch/ready.count")" = 3
! grep -q '^Deployed ' <<<"$output"
! grep -q '^up -d caddy$' "$scratch/docker.log"
grep -q 'Verified pre-update backup: /backups/kaoyan-' <<<"$output"
grep -q 'new API and scheduled backup remain stopped' <<<"$output"

: >"$scratch/docker.log"
rm -f "$scratch/ready.count"
output="$(run_restore 2>&1)"
grep -q '^Restore completed ' <<<"$output"
test "$(cat "$scratch/backup.state")" = 1
test "$(cat "$scratch/restore.count")" = 1

: >"$scratch/docker.log"
rm -f "$scratch/ready.count"
set +e
FAKE_PRE_RESTORE_FAIL=1 output="$(run_restore 2>&1)"
status=$?
set -e
test "$status" -ne 0
test "$(cat "$scratch/backup.state")" = 1
grep -q '^up -d backup$' "$scratch/docker.log"

: >"$scratch/docker.log"
rm -f "$scratch/ready.count"
set +e
FAKE_PRE_RESTORE_FAIL=0 FAKE_POSTCHECK_FAIL=1 FAKE_ROLLBACK_FAIL=0 output="$(run_restore 2>&1)"
status=$?
set -e
test "$status" -ne 0
test "$(cat "$scratch/backup.state")" = 1
test "$(cat "$scratch/restore.count")" = 2
grep -q 'original database was rolled back and API is ready' <<<"$output"

: >"$scratch/docker.log"
rm -f "$scratch/ready.count"
set +e
FAKE_PRE_RESTORE_FAIL=0 FAKE_POSTCHECK_FAIL=1 FAKE_ROLLBACK_FAIL=1 output="$(run_restore 2>&1)"
status=$?
set -e
test "$status" -ne 0
test "$(cat "$scratch/backup.state")" = 0
test "$(cat "$scratch/restore.count")" = 2
grep -q 'ROLLBACK FAILED. API and backup remain stopped' <<<"$output"

: >"$scratch/docker.log"
rm -f "$scratch/ready.count"
set +e
FAKE_MIGRATION_STATUS=42 output="$(run_update 2>&1)"
status=$?
set -e
test "$status" -ne 0
! grep -q '^up -d api web$' "$scratch/docker.log"
! grep -q '^Deployed ' <<<"$output"
grep -q 'Verified pre-update backup: /backups/kaoyan-' <<<"$output"

hold_release="$scratch/release-maintenance"
hold_ready="$scratch/maintenance-held"
flock "$ROOT/.maintenance.lock" bash -c 'touch "$1"; while [[ ! -e "$2" ]]; do sleep 0.05; done' _ "$hold_ready" "$hold_release" &
holder=$!
while [[ ! -e "$hold_ready" ]]; do sleep 0.05; done
: >"$scratch/docker.log"
set +e
lock_output="$(env PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$scratch/docker.log" bash "$ROOT/scripts/restore.sh" kaoyan-20260713T120000000000000Z-manual.sqlite.gz 2>&1)"
restore_status=$?
update_output="$(env PATH="$fake_bin:$PATH" FAKE_DOCKER_LOG="$scratch/docker.log" bash "$ROOT/scripts/update.sh" 2>&1)"
update_status=$?
set -e
test "$restore_status" = 75
test "$update_status" = 75
grep -q 'Another restore or update is already running' <<<"$lock_output"
grep -q 'Another restore or update is already running' <<<"$update_output"
test ! -s "$scratch/docker.log"
touch "$hold_release"
wait "$holder"

cat >"$fake_bin/sqlite3" <<'FAKE_SQLITE'
#!/usr/bin/env bash
set -eu
if [[ "${3:-}" == .backup\ \'* ]]; then
  target="${3#.backup \'}"
  target="${target%\'}"
  if [[ -n "${FAKE_BACKUP_SIGNAL:-}" ]]; then
    touch "$FAKE_BACKUP_SIGNAL"
    while [[ ! -e "$FAKE_RELEASE" ]]; do sleep 0.05; done
  fi
  cp -- "$1" "$target"
  exit 0
fi
if [[ "$1" == */.restore-*.sqlite && -n "${FAKE_RESTORE_SIGNAL:-}" ]]; then
  touch "$FAKE_RESTORE_SIGNAL"
  while [[ ! -e "$FAKE_RELEASE" ]]; do sleep 0.05; done
fi
printf 'ok\n'
FAKE_SQLITE
chmod +x "$fake_bin/sqlite3"

backup_root="$scratch/backups"
data_root="$scratch/data"
mkdir -p "$backup_root" "$data_root"
database="$data_root/kaoyan.sqlite"
archive="$backup_root/kaoyan-20260713T120000000000000Z-manual.sqlite.gz"
printf 'original-database\n' >"$database"
printf 'restored-database\n' | gzip -c >"$archive"

backup_signal="$scratch/backup-held"
backup_release="$scratch/release-backup"
env PATH="$fake_bin:$PATH" BACKUP_DIR="$backup_root" DATABASE_PATH="$database" \
  FAKE_BACKUP_SIGNAL="$backup_signal" FAKE_RELEASE="$backup_release" \
  RETENTION_DAYS=30 sh "$ROOT/docker/backup/scripts/backup.sh" manual >/dev/null &
backup_pid=$!
while [[ ! -e "$backup_signal" ]]; do sleep 0.05; done
env PATH="$fake_bin:$PATH" BACKUP_DIR="$backup_root" DATABASE_PATH="$database" \
  sh "$ROOT/docker/backup/scripts/restore-db.sh" "$archive" &
restore_pid=$!
sleep 0.2
kill -0 "$restore_pid"
grep -q '^original-database$' "$database"
touch "$backup_release"
wait "$backup_pid"
wait "$restore_pid"
grep -q '^restored-database$' "$database"

printf 'original-again\n' >"$database"
restore_signal="$scratch/restore-held"
restore_release="$scratch/release-restore"
env PATH="$fake_bin:$PATH" BACKUP_DIR="$backup_root" DATABASE_PATH="$database" \
  FAKE_RESTORE_SIGNAL="$restore_signal" FAKE_RELEASE="$restore_release" \
  sh "$ROOT/docker/backup/scripts/restore-db.sh" "$archive" &
restore_pid=$!
while [[ ! -e "$restore_signal" ]]; do sleep 0.05; done
set +e
env PATH="$fake_bin:$PATH" BACKUP_DIR="$backup_root" DATABASE_PATH="$database" \
  RETENTION_DAYS=30 sh "$ROOT/docker/backup/scripts/backup.sh" manual >/dev/null 2>&1
backup_status=$?
set -e
test "$backup_status" = 75
touch "$restore_release"
wait "$restore_pid"

echo 'Deployment maintenance script tests passed'
