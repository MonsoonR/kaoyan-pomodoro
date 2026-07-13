#!/bin/sh
set -eu
archive="${1:?backup archive is required}"
case "$archive" in /backups/kaoyan-????????T???????????????Z-*.sqlite.gz) ;; *) echo "Invalid backup path" >&2; exit 64 ;; esac
test -f "$archive" && test ! -L "$archive" || exit 66
db="${DATABASE_PATH:-/var/lib/kaoyan/kaoyan.sqlite}"
dir="$(dirname "$db")"
tmp="$(mktemp "$dir/.restore-XXXXXX.sqlite")"
cleanup() { rm -f -- "$tmp"; }
trap cleanup EXIT HUP INT TERM
gzip -t "$archive"
gzip -dc "$archive" > "$tmp"
test "$(sqlite3 "$tmp" 'PRAGMA integrity_check;')" = "ok" || exit 65
chmod 0600 "$tmp"
mv -f "$tmp" "$db"
rm -f -- "$db-wal" "$db-shm"
test "$(sqlite3 "$db" 'PRAGMA integrity_check;')" = "ok" || exit 65
