#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
exec 9>"$ROOT/.maintenance.lock"
flock -n 9 || { echo "Another restore or update is already running" >&2; exit 75; }

backup=""
backup_was_running=0
backup_state_known=0
critical_stage=0
failure_reported=0

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
on_exit() {
  local status=$?
  if (( status != 0 )); then
    if (( critical_stage )); then
      compose stop api backup >/dev/null 2>&1 || true
      if (( ! failure_reported )); then
        echo "Update failed after API writes were stopped. API and scheduled backup remain stopped." >&2
        echo "Verified pre-update backup: $backup" >&2
      fi
    else
      if ! restore_backup_service; then
        echo "Update failed before API shutdown, and the backup service could not be restarted" >&2
      fi
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

compose config --quiet
if compose ps --status running --services backup | grep -qx backup; then backup_was_running=1; fi
backup_state_known=1
compose stop backup
backup="$(compose run --rm --no-deps backup /app/scripts/backup.sh pre-update | tail -n 1)"
compose run --rm --no-deps backup /app/scripts/validate-backup.sh "$backup"
IMAGE_VERSION="$(git rev-parse HEAD)"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
export IMAGE_VERSION BUILD_DATE
compose build
critical_stage=1
compose stop api
compose run --rm --no-deps api node dist/db/migrate.js
compose up -d api web
if ! wait_ready; then
  compose stop api backup >/dev/null 2>&1 || true
  echo "Readiness timed out. The new API and scheduled backup remain stopped." >&2
  echo "Verified pre-update backup: $backup" >&2
  echo "Restore it with: bash scripts/restore.sh $(basename "$backup")" >&2
  failure_reported=1
  exit 70
fi
restore_backup_service
compose up -d caddy
compose ps
trap - EXIT
echo "Deployed $IMAGE_VERSION after verified backup $(basename "$backup")"
