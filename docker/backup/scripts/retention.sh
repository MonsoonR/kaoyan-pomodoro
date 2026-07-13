#!/bin/sh
set -eu
: "${BACKUP_DIR:=/backups}"
: "${RETENTION_DAYS:=30}"
case "$RETENTION_DAYS" in ''|*[!0-9]*) echo "RETENTION_DAYS must be a non-negative integer" >&2; exit 64 ;; esac
test -d "$BACKUP_DIR" || exit 0

newest="$(find "$BACKUP_DIR" -maxdepth 1 -type f -name 'kaoyan-????????T???????????????Z-*.sqlite.gz' -printf '%T@ %p\n' | sort -nr | sed -n '1s/^[^ ]* //p')"
find "$BACKUP_DIR" -maxdepth 1 -type f -name 'kaoyan-????????T???????????????Z-*.sqlite.gz' -mtime "+$RETENTION_DAYS" -print | while IFS= read -r candidate; do
  test -n "$newest" && test "$candidate" = "$newest" && continue
  rm -- "$candidate"
  echo "Expired backup removed: $(basename "$candidate")" >&2
done
