#!/usr/bin/env bash

select_smoke_storage_mode() {
  local requested="${SMOKE_STORAGE_MODE:-auto}"
  case "$requested" in
    bind|volume) printf '%s\n' "$requested" ;;
    auto)
      if [[ -n "${MSYSTEM:-}" || "${OS:-}" == Windows_NT || -n "${WSL_INTEROP:-}" ]] || command -v cygpath >/dev/null 2>&1; then
        printf 'volume\n'
      else
        printf 'bind\n'
      fi
      ;;
    *)
      echo "Unsupported SMOKE_STORAGE_MODE: $requested (expected auto, bind, or volume)" >&2
      return 64
      ;;
  esac
}

wait_for_initial_services() {
  local service
  for service in api web backup caddy; do
    wait_healthy "$service"
  done
}

run_manual_backup_with_retry() {
  local attempts="${SMOKE_BACKUP_RETRY_ATTEMPTS:-20}"
  local delay="${SMOKE_BACKUP_RETRY_DELAY_SECONDS:-1}"
  case "$attempts" in ''|*[!0-9]*) echo 'SMOKE_BACKUP_RETRY_ATTEMPTS must be a positive integer' >&2; return 64 ;; esac
  case "$delay" in ''|*[!0-9]*) echo 'SMOKE_BACKUP_RETRY_DELAY_SECONDS must be a non-negative integer' >&2; return 64 ;; esac
  (( attempts > 0 )) || { echo 'SMOKE_BACKUP_RETRY_ATTEMPTS must be greater than zero' >&2; return 64; }

  local diagnostic_dir="${SMOKE_DIAGNOSTIC_DIR:-${TMPDIR:-/tmp}}"
  local attempt status had_errexit stdout_file stderr_file
  mkdir -p "$diagnostic_dir"
  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    stdout_file="$diagnostic_dir/manual-backup-${attempt}.stdout"
    stderr_file="$diagnostic_dir/manual-backup-${attempt}.stderr"
    had_errexit=0
    [[ $- == *e* ]] && had_errexit=1
    set +e
    compose run --rm --no-deps backup /app/scripts/backup.sh manual >"$stdout_file" 2>"$stderr_file"
    status=$?
    (( had_errexit )) && set -e

    if (( status == 0 )); then
      cat "$stderr_file" >&2
      echo 'Manual backup final exit code: 0' >&2
      tail -n 1 "$stdout_file"
      return 0
    fi

    cat "$stdout_file" >&2
    cat "$stderr_file" >&2
    echo "Manual backup final exit code: $status (attempt $attempt/$attempts)" >&2
    if (( status != 75 )); then
      return "$status"
    fi
    if (( attempt < attempts )); then
      echo "Manual backup lock is busy; retrying in ${delay}s" >&2
      sleep "$delay"
    fi
  done

  echo "Manual backup lock retry exhausted after $attempts attempts" >&2
  return 75
}
