#!/bin/sh
set -eu
archive="${1:?backup archive is required}"
backup_root="${BACKUP_DIR:-/backups}"
case "$archive" in "$backup_root"/kaoyan-????????T???????????????Z-*.sqlite.gz) ;; *) echo "Invalid backup path" >&2; exit 64 ;; esac
resolved="$(realpath -e "$archive")" || { echo "Backup does not exist" >&2; exit 66; }
case "$resolved" in "$backup_root"/kaoyan-????????T???????????????Z-*.sqlite.gz) ;; *) echo "Backup resolves outside $backup_root" >&2; exit 64 ;; esac
test "$resolved" = "$archive" && test -f "$archive" && test ! -L "$archive" || { echo "Backup is not a regular non-symlink file" >&2; exit 66; }
tmp="$(mktemp /tmp/validate-XXXXXX.sqlite)"
trap 'rm -f -- "$tmp"' EXIT HUP INT TERM
gzip -t "$archive"
gzip -dc "$archive" > "$tmp"
test "$(sqlite3 "$tmp" 'PRAGMA integrity_check;')" = "ok" || { echo "Backup integrity check failed" >&2; exit 65; }
echo "Backup is valid: $(basename "$archive")"
