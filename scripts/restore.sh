#!/usr/bin/env bash
# shellcheck disable=SC2016 # sqlite expressions expand inside the backup container.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
exec 9>"$ROOT/.maintenance.lock"
flock -n 9 || { echo "Another restore or update is already running" >&2; exit 75; }

requested="${1:?Usage: ./scripts/restore.sh kaoyan-...sqlite.gz}"
case "$requested" in
  backups/*) name="${requested#backups/}" ;;
  */*|*\\*|*..*) echo "Restore accepts only a backup filename or backups/<filename>" >&2; exit 64 ;;
  *) name="$requested" ;;
esac
if [[ ! "$name" =~ ^kaoyan-[0-9]{8}T[0-9]{15}Z-(manual|daily|pre-update|pre-restore)\.sqlite\.gz$ ]]; then
  echo "Invalid application backup filename" >&2
  exit 64
fi

pre_name=""
backup_was_running=0
backup_state_known=0
restore_started=0

compose() { docker compose "$@"; }
ready_request() {
  compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
}
wait_ready() {
  local attempts="${1:-${READINESS_ATTEMPTS:-30}}"
  local delay="${READINESS_DELAY_SECONDS:-2}"
  local i
  for ((i = 1; i <= attempts; i++)); do
    if ready_request; then return 0; fi
    if (( i < attempts )); then sleep "$delay"; fi
  done
  return 1
}
restore_backup_service() {
  if (( backup_state_known && backup_was_running )); then compose up -d backup; fi
}
rollback() {
  echo "Restore failed; rolling back to the verified pre-restore database" >&2
  compose stop api backup >/dev/null 2>&1 || true
  if [[ -n "$pre_name" ]] &&
    compose run --rm --no-deps backup /app/scripts/restore-db.sh "/backups/$pre_name" &&
    compose up -d api && wait_ready && restore_backup_service; then
    echo "Restore failed, but the original database was rolled back and API is ready" >&2
    return 0
  fi
  compose stop api backup >/dev/null 2>&1 || true
  echo "ROLLBACK FAILED. API and backup remain stopped." >&2
  echo "Restore manually with: docker compose run --rm --no-deps backup /app/scripts/restore-db.sh /backups/$pre_name" >&2
  return 1
}
on_exit() {
  local status=$?
  if (( status != 0 )); then
    if (( restore_started )); then
      rollback || true
    elif ! restore_backup_service; then
      echo "Restore failed before database replacement, and the backup service could not be restarted" >&2
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

compose config --quiet
compose run --rm --no-deps backup /app/scripts/validate-backup.sh "/backups/$name"
if compose ps --status running --services backup | grep -qx backup; then backup_was_running=1; fi
backup_state_known=1
compose stop backup
if compose ps --status running --services backup | grep -qx backup; then
  echo "Backup service did not stop" >&2
  exit 69
fi
pre_path="$(compose run --rm --no-deps backup /app/scripts/backup.sh pre-restore | tail -n 1)"
pre_name="$(basename "$pre_path")"
compose run --rm --no-deps backup /app/scripts/validate-backup.sh "/backups/$pre_name"
compose stop api
restore_started=1
compose run --rm --no-deps backup /app/scripts/restore-db.sh "/backups/$name"
compose up -d api
wait_ready
compose run --rm --no-deps backup sh -c 'test "$(sqlite3 "$DATABASE_PATH" "PRAGMA integrity_check;")" = ok'
compose run --rm --no-deps backup sh -c 'test "$(sqlite3 "$DATABASE_PATH" "SELECT count(*) FROM users;")" -eq 1'
restore_backup_service
trap - EXIT
echo "Restore completed from $name (rollback point: $pre_name)"
