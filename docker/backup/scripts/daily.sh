#!/bin/sh
set -eu
: "${BACKUP_HOUR:=3}"
case "$BACKUP_HOUR" in ''|*[!0-9]*) exit 64 ;; esac
test "$BACKUP_HOUR" -ge 0 && test "$BACKUP_HOUR" -le 23 || exit 64

while ! test -f "${DATABASE_PATH:-/var/lib/kaoyan/kaoyan.sqlite}"; do sleep 10 & wait $!; done
if /app/scripts/backup.sh daily; then touch /tmp/backup-healthy; else exit 1; fi

while :; do
  now="$(date +%s)"
  target="$(date -d "today ${BACKUP_HOUR}:00:00" +%s)"
  test "$target" -gt "$now" || target="$(date -d "tomorrow ${BACKUP_HOUR}:00:00" +%s)"
  sleep "$((target - now))" & wait $!
  if test -f "${DATABASE_PATH:-/var/lib/kaoyan/kaoyan.sqlite}"; then
    if /app/scripts/backup.sh daily; then
      touch /tmp/backup-healthy
    else
      rm -f /tmp/backup-healthy
      echo "Daily backup failed" >&2
    fi
  fi
done
