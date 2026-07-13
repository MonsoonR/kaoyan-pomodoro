#!/bin/sh
set -eu

mode="${1:-manual}"
case "$mode" in manual|daily|pre-update|pre-restore) ;; *) echo "Unsupported backup type" >&2; exit 64 ;; esac
: "${DATABASE_PATH:=/var/lib/kaoyan/kaoyan.sqlite}"
: "${BACKUP_DIR:=/backups}"
test -f "$DATABASE_PATH" || { echo "Database does not exist yet" >&2; exit 66; }
mkdir -p "$BACKUP_DIR"

exec 9>"$BACKUP_DIR/.backup.lock"
flock -n 9 || { echo "Another backup is already running" >&2; exit 75; }
stamp="$(date -u +%Y%m%dT%H%M%S%NZ)"
base="kaoyan-${stamp}-${mode}.sqlite.gz"
final="$BACKUP_DIR/$base"
tmpdir="$(mktemp -d "$BACKUP_DIR/.backup-${stamp}-XXXXXX")"
cleanup() { rm -rf -- "$tmpdir"; }
trap cleanup EXIT HUP INT TERM

tmpdb="$tmpdir/backup.sqlite"
verified="$tmpdir/verified.sqlite"
sqlite3 "$DATABASE_PATH" ".timeout 10000" ".backup '$tmpdb'"
test "$(sqlite3 "$tmpdb" 'PRAGMA integrity_check;')" = "ok" || { echo "Backup integrity check failed" >&2; exit 65; }
gzip -c -9 "$tmpdb" > "$tmpdir/archive.gz"
gzip -t "$tmpdir/archive.gz"
gzip -dc "$tmpdir/archive.gz" > "$verified"
test "$(sqlite3 "$verified" 'PRAGMA integrity_check;')" = "ok" || { echo "Compressed backup verification failed" >&2; exit 65; }
chmod 0600 "$tmpdir/archive.gz"
mv "$tmpdir/archive.gz" "$final"
echo "Backup created: $base" >&2
/app/scripts/retention.sh
printf '%s\n' "$final"
