#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
BACKUP_ROOT="$(realpath -e "${BACKUP_HOST_DIR:-${BACKUP_DIR:-backups}}")"
requested="${1:?Usage: ./scripts/restore.sh backups/kaoyan-...sqlite.gz}"
target="$(realpath -e "$requested")" || { echo "Backup does not exist" >&2; exit 66; }
case "$target" in "$BACKUP_ROOT"/kaoyan-????????T???????????????Z-*.sqlite.gz) ;; *) echo "Restore only accepts named backups inside backups/" >&2; exit 64 ;; esac
[[ -f "$target" && ! -L "$requested" ]] || { echo "Backup must be a regular non-symlink file" >&2; exit 64; }
name="$(basename "$target")"
pre_name=""

compose() { docker compose "$@"; }
wait_ready() {
  for _ in {1..30}; do
    if compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then return 0; fi
    sleep 2
  done
  return 1
}
rollback() {
  echo "Restore failed; rolling back to the pre-restore database" >&2
  compose stop api >/dev/null 2>&1 || true
  if [[ -n "$pre_name" ]] && compose run --rm --no-deps backup /app/scripts/restore-db.sh "/backups/$pre_name" && compose up -d api && wait_ready; then
    echo "Restore failed, but the original database was rolled back and API is ready" >&2
    return 0
  fi
  compose stop api >/dev/null 2>&1 || true
  echo "ROLLBACK FAILED. API remains stopped. Restore manually with: docker compose run --rm --no-deps backup /app/scripts/restore-db.sh /backups/$pre_name" >&2
  return 1
}
trap 'status=$?; if (( status != 0 )) && [[ -n "$pre_name" ]]; then rollback || true; fi; exit "$status"' EXIT

compose config --quiet
compose run --rm --no-deps backup /app/scripts/validate-backup.sh "/backups/$name"
pre_path="$(compose run --rm --no-deps backup /app/scripts/backup.sh pre-restore | tail -n 1)"
pre_name="$(basename "$pre_path")"
compose run --rm --no-deps backup /app/scripts/validate-backup.sh "/backups/$pre_name"
compose stop api
compose run --rm --no-deps backup /app/scripts/restore-db.sh "/backups/$name"
compose up -d api
wait_ready
compose run --rm --no-deps backup sh -c 'test "$(sqlite3 "$DATABASE_PATH" "PRAGMA integrity_check;")" = ok'
compose run --rm --no-deps backup sh -c 'test "$(sqlite3 "$DATABASE_PATH" "SELECT count(*) FROM users;")" -eq 1'
trap - EXIT
echo "Restore completed from $name (rollback point: $pre_name)"
