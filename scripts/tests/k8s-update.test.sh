#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
fake_bin="$scratch/bin"
mkdir -p "$fake_bin" "$scratch/states"

cat >"$fake_bin/kubectl" <<'FAKE_KUBECTL'
#!/usr/bin/env bash
set -Eeuo pipefail

state="${FAKE_STATE:?}"
mkdir -p "$state"
printf '%s\n' "$*" >>"$state/kubectl.log"

getv() { local name="$1" fallback="${2:-}"; [[ -f "$state/$name" ]] && cat "$state/$name" || printf '%s' "$fallback"; }
putv() { printf '%s' "$2" >"$state/$1"; }

if [[ "${1:-}" == "config" ]]; then
  [[ "${2:-}" == "current-context" ]] || exit 99
  getv context nzfklii-kite
  printf '\n'
  exit 0
fi

if [[ "${1:-}" == "get" && "${2:-}" == "namespace" ]]; then
  printf 'namespace/%s\n' "${3:-kaoyan-pomodoro}"
  exit 0
fi

[[ "${1:-}" == "--namespace" ]] || { echo "missing namespace" >&2; exit 99; }
shift 2
verb="${1:-}"
shift || true

case "$verb" in
  get)
    resource="${1:-}"; shift || true
    case "$resource" in
      deployment/kaoyan-api|deployment/kaoyan-web|cronjob/kaoyan-backup)
        args="$*"
        if [[ "$args" == *affinity.nodeAffinity*values* ]]; then printf 'guilyrh'
        elif [[ "$args" == *affinity.nodeAffinity*operator* ]]; then printf 'In'
        elif [[ "$args" == *tolerations*value* ]]; then printf 'true'
        elif [[ "$args" == *tolerations*operator* ]]; then printf 'Equal'
        elif [[ "$args" == *tolerations*effect* ]]; then printf 'NoSchedule'
        else printf '%s\n' "$resource"
        fi
        ;;
      persistentvolumeclaim/kaoyan-data|persistentvolumeclaim/kaoyan-backups|ingress/kaoyan-pomodoro|certificate/kaoyan-pomodoro-certs)
        printf '%s\n' "$resource"
        ;;
      deployment)
        name="${1:-}"; shift || true; args="$*"
        if [[ "$args" == *affinity.nodeAffinity*values* ]]; then printf 'guilyrh'
        elif [[ "$args" == *affinity.nodeAffinity*operator* ]]; then printf 'In'
        elif [[ "$args" == *tolerations*value* ]]; then printf 'true'
        elif [[ "$args" == *tolerations*operator* ]]; then printf 'Equal'
        elif [[ "$args" == *tolerations*effect* ]]; then printf 'NoSchedule'
        elif [[ "$args" == *containers*image* ]]; then
          [[ "$name" == kaoyan-api ]] && getv api_image || getv web_image
        elif [[ "$args" == *spec.replicas* ]]; then
          [[ "$name" == kaoyan-api ]] && getv api_replicas 0 || getv web_replicas 0
        elif [[ "$args" == *status.availableReplicas* ]]; then
          [[ "$name" == kaoyan-api ]] && getv api_available 0 || getv web_available 0
        elif [[ "$args" == *spec.strategy.type* ]]; then printf 'Recreate'
        else echo "Unhandled deployment get: $name $args" >&2; exit 99
        fi
        ;;
      cronjob)
        name="${1:-}"; shift || true; args="$*"
        if [[ "$args" == *affinity.nodeAffinity*values* ]]; then printf 'guilyrh'
        elif [[ "$args" == *affinity.nodeAffinity*operator* ]]; then printf 'In'
        elif [[ "$args" == *tolerations*value* ]]; then printf 'true'
        elif [[ "$args" == *tolerations*operator* ]]; then printf 'Equal'
        elif [[ "$args" == *tolerations*effect* ]]; then printf 'NoSchedule'
        elif [[ "$args" == *containers*image* ]]; then getv backup_image
        elif [[ "$args" == *spec.suspend* ]]; then getv cron_suspend false
        elif [[ "$args" == *status.active* ]]; then getv cron_active
        elif [[ "$args" == *status.lastScheduleTime* ]]; then printf '2026-07-16T02:30:00Z'
        elif [[ "$args" == *status.lastSuccessfulTime* ]]; then printf '2026-07-16T02:31:00Z'
        else echo "Unhandled cronjob get: $name $args" >&2; exit 99
        fi
        ;;
      pvc)
        name="${1:-}"; shift || true
        [[ "$name" == kaoyan-data ]] && getv data_pvc Bound || getv backup_pvc Bound
        ;;
      certificate)
        printf 'True'
        ;;
      ingress)
        args="$*"
        [[ "$args" == *ingressClassName* ]] && printf 'traefik' || printf 'pomodoro.losenone.cn'
        ;;
      pods)
        args="$*"
        component=web
        [[ "$args" == *component=api* ]] && component=api
        replicas="$(getv "${component}_replicas" 0)"
        if [[ "$args" == *'-o name'* ]]; then
          if (( replicas > 0 )); then printf 'pod/kaoyan-%s-0\n' "$component"; fi
        else
          if (( replicas > 0 )); then printf 'guilyrh\n'; fi
        fi
        ;;
      pod)
        name="${1:-}"; shift || true; args="$*"
        if [[ "$args" == *'-o name'* ]]; then
          if [[ -f "$state/pod.$name.phase" ]]; then printf 'pod/%s\n' "$name"; fi
        elif [[ "$args" == *status.phase* ]]; then getv "pod.$name.phase"
        elif [[ "$args" == *containers*image* ]]; then getv "pod.$name.image"
        else echo "Unhandled pod get: $name $args" >&2; exit 99
        fi
        ;;
      configmap)
        name="${1:-}"; shift || true; args="$*"
        if [[ "$args" == *'-o name'* ]]; then
          if [[ -f "$state/configmap.exists" ]]; then printf 'configmap/%s\n' "$name"; fi
        elif [[ "$args" == *jsonpath=*data.* ]]; then
          field="${args#*.data.}"; field="${field%%\}*}"
          getv "cm.$field"
        else echo "Unhandled configmap get: $name $args" >&2; exit 99
        fi
        ;;
      job)
        name="${1:-}"; shift || true; args="$*"
        if [[ "$args" == *'-o name'* ]]; then
          if [[ -f "$state/job.$name.succeeded" ]]; then printf 'job.batch/%s\n' "$name"; fi
        elif [[ "$args" == *status.succeeded* ]]; then getv "job.$name.succeeded" 0
        else echo "Unhandled job get: $name $args" >&2; exit 99
        fi
        ;;
      *) echo "Unhandled get resource: $resource $*" >&2; exit 99 ;;
    esac
    ;;
  exec)
    main=absent wal=absent shm=absent
    [[ "$(getv db_main absent)" == present ]] && main=present
    [[ "$(getv db_wal absent)" == present ]] && wal=present
    [[ "$(getv db_shm absent)" == present ]] && shm=present
    printf 'main=%s wal=%s shm=%s ' "$main" "$wal" "$shm"
    ;;
  create)
    if [[ "${1:-}" == "-f" ]]; then
      yaml="$(cat)"
      printf '\n---\n%s\n' "$yaml" >>"$state/yaml.log"
      name="$(awk '$1 == "name:" { print $2; exit }' <<<"$yaml")"
      component="$(awk '$1 == "app.kubernetes.io/component:" { print $2; exit }' <<<"$yaml")"
      image="$(awk '$1 == "image:" { print $2; exit }' <<<"$yaml")"
      putv "pod.$name.image" "$image"
      phase=Succeeded log=ok
      case "$component" in
        update-pull-*)
          pull_component="${component#update-pull-}"
          if [[ "$(getv pull_fail_component)" == "$pull_component" ]]; then phase=Failed; log="pull failed"; fi
          ;;
        update-reset-check)
          if [[ "$(getv db_main absent)" == present || "$(getv db_wal absent)" == present || "$(getv db_shm absent)" == present ]]; then
            phase=Failed; log="Data PVC is not empty"
          elif [[ "$(getv backup_valid 1)" != 1 ]]; then
            phase=Failed; log="Backup integrity check failed"
          else log=reset-empty-preflight-ok
          fi
          ;;
        update-migration)
          if [[ "$(getv migration_fail 0)" == 1 ]]; then phase=Failed; log="migration failed"
          else putv db_main present; log=migrated
          fi
          ;;
        update-account-status)
          [[ "$(getv admin_initialized 0)" == 1 ]] && log=initialized || log=not-initialized
          ;;
        admin-init) phase=Running; log="" ;;
      esac
      putv "pod.$name.phase" "$phase"
      putv "pod.$name.log" "$log"
    elif [[ "${1:-}" == "configmap" ]]; then
      touch "$state/configmap.exists"
      putv cm.schemaVersion 1
    elif [[ "${1:-}" == "job" ]]; then
      name="${@: -1}"
      [[ "$(getv backup_job_fail 0)" == 1 ]] && putv "job.$name.succeeded" 0 || putv "job.$name.succeeded" 1
    else echo "Unhandled create: $*" >&2; exit 99
    fi
    ;;
  patch)
    resource="${1:-}"; name="${2:-}"; shift 2 || true
    payload=""
    while (($#)); do
      if [[ "$1" == "-p" ]]; then payload="${2:-}"; break; fi
      shift
    done
    if [[ "$resource" == configmap ]]; then
      touch "$state/configmap.exists"
      for field in schemaVersion phase mainSha databaseMode backupFile apiImage webImage backupImage desiredApiReplicas desiredWebReplicas finalCronSuspend databaseStatus backupJob lastResult; do
        needle="\"$field\":\""
        if [[ "$payload" == *"$needle"* ]]; then
          rest="${payload#*"$needle"}"
          putv "cm.$field" "${rest%%\"*}"
        fi
      done
    elif [[ "$resource" == cronjob ]]; then
      if [[ "$payload" == *'"suspend":true'* ]]; then
        putv cron_suspend true
      elif [[ "$payload" == *'"suspend":false'* ]]; then
        putv cron_suspend false
      else
        echo "Unhandled CronJob patch payload: $payload" >&2; exit 99
      fi
    else echo "Unhandled patch: $resource $name $payload" >&2; exit 99
    fi
    ;;
  scale)
    [[ "${1:-}" == deployment ]] || exit 99
    name="${2:-}"; shift 2
    replicas="${1#--replicas=}"
    component="${name#kaoyan-}"
    putv "${component}_replicas" "$replicas"
    if [[ "$replicas" == 0 ]]; then putv "${component}_available" 0
    elif [[ "$(getv "readiness_fail_${component}" 0)" == 1 ]]; then putv "${component}_available" 0
    else putv "${component}_available" "$replicas"
    fi
    ;;
  set)
    [[ "${1:-}" == image ]] || exit 99
    resource="${2:-}" assignment="${3:-}" component="${assignment%%=*}" image="${assignment#*=}"
    case "$resource" in
      deployment/kaoyan-api) putv api_image "$image" ;;
      deployment/kaoyan-web) putv web_image "$image" ;;
      cronjob/kaoyan-backup) putv backup_image "$image" ;;
      *) exit 99 ;;
    esac
    ;;
  delete)
    [[ "${1:-}" == pod ]] || exit 0
    name="${2:-}"
    rm -f "$state/pod.$name.phase" "$state/pod.$name.image" "$state/pod.$name.log"
    ;;
  wait)
    target="${@: -1}"
    if [[ "$target" == job/* ]]; then
      name="${target#job/}"
      [[ "$(getv "job.$name.succeeded" 0)" == 1 ]]
    fi
    ;;
  rollout)
    target="${3:-${2:-}}"
    component="${target#deployment/kaoyan-}"
    [[ "$(getv "readiness_fail_${component}" 0)" != 1 ]]
    ;;
  logs)
    name="${1#pod/}"
    getv "pod.$name.log"
    [[ -f "$state/pod.$name.log" ]] && printf '\n'
    ;;
  attach)
    name="${2:-}"
    putv admin_initialized 1
    putv "pod.$name.phase" Succeeded
    ;;
  *) echo "Unhandled fake kubectl verb: $verb $*" >&2; exit 99 ;;
esac
FAKE_KUBECTL
chmod +x "$fake_bin/kubectl"

cat >"$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
set -eu
[[ "$(cat "$FAKE_STATE/health_fail" 2>/dev/null || printf 0)" != 1 ]]
FAKE_CURL
chmod +x "$fake_bin/curl"

old_sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
new_sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
other_sha=cccccccccccccccccccccccccccccccccccccccc
old_digest=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
new_digest=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
backup_file=kaoyan-20260716T023824338082865Z-daily.sqlite.gz

old_api="ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-$old_sha@sha256:$old_digest"
old_web="ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-$old_sha@sha256:$old_digest"
old_backup="ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-$old_sha@sha256:$old_digest"
new_api="ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-$new_sha@sha256:$new_digest"
new_web="ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-$new_sha@sha256:$new_digest"
new_backup="ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-$new_sha@sha256:$new_digest"

common=(
  --namespace kaoyan-pomodoro
  --main-sha "$new_sha"
  --api-image "$new_api"
  --web-image "$new_web"
  --backup-image "$new_backup"
)
reset_common=(--database-mode reset-empty --backup-file "$backup_file" "${common[@]}")
preserve_confirmation="UPDATE kaoyan-pomodoro ON nzfklii-kite TO $new_sha USING preserve"
reset_execute_confirmation="UPDATE kaoyan-pomodoro ON nzfklii-kite TO $new_sha USING reset-empty"
reset_confirmation="RESET EMPTY DATABASE IN kaoyan-pomodoro ON nzfklii-kite"
backup_confirmation="TRUST VERIFIED BACKUP $backup_file"

put() { printf '%s' "$3" >"$2/$1"; }
new_state() {
  local name="$1" shape="$2" state
  state="$scratch/states/$name"
  rm -rf -- "$state"; mkdir -p "$state"; : >"$state/kubectl.log"
  put context "$state" nzfklii-kite
  put api_image "$state" "$old_api"; put web_image "$state" "$old_web"; put backup_image "$state" "$old_backup"
  put data_pvc "$state" Bound; put backup_pvc "$state" Bound; put cron_active "$state" ""
  put backup_valid "$state" 1; put admin_initialized "$state" 0
  if [[ "$shape" == healthy ]]; then
    put api_replicas "$state" 1; put api_available "$state" 1
    put web_replicas "$state" 1; put web_available "$state" 1
    put cron_suspend "$state" false; put db_main "$state" present
  else
    put api_replicas "$state" 0; put api_available "$state" 0
    put web_replicas "$state" 0; put web_available "$state" 0
    put cron_suspend "$state" true; put db_main "$state" absent
    [[ "$shape" == stopped-present ]] && put db_main "$state" present
  fi
  printf '%s' "$state"
}

run_update() {
  local state="$1"; shift
  set +e
  RUN_OUTPUT="$(env PATH="$fake_bin:$PATH" FAKE_STATE="$state" \
    K8S_UPDATE_POLL_ATTEMPTS=2 K8S_UPDATE_POLL_DELAY_SECONDS=0 \
    bash -u "$ROOT/scripts/k8s-update.sh" "$@" 2>&1)"
  RUN_STATUS=$?
  set -e
}

run_admin_init() {
  local state="$1"; shift
  set +e
  RUN_OUTPUT="$(env PATH="$fake_bin:$PATH" FAKE_STATE="$state" \
    K8S_ADMIN_POLL_ATTEMPTS=2 K8S_ADMIN_POLL_DELAY_SECONDS=0 \
    bash -u "$ROOT/scripts/k8s-admin-init.sh" "$@" 2>&1)"
  RUN_STATUS=$?
  set -e
}

assert_no_mutations() {
  local log="$1"
  ! grep -Eq '(^| )(create|delete|patch|scale|set|apply|annotate)( |$)' "$log"
}

# --status and --plan are strictly read only.
state="$(new_state status healthy)"
run_update "$state" --status --namespace kaoyan-pomodoro
test "$RUN_STATUS" = 0
grep -q 'status (read only)' <<<"$RUN_OUTPUT"
grep -q 'database files: main=present wal=absent shm=absent' <<<"$RUN_OUTPUT"
assert_no_mutations "$state/kubectl.log"

state="$(new_state preserve-plan healthy)"
run_update "$state" --plan "${common[@]}"
test "$RUN_STATUS" = 0
grep -q 'selected flow: new-preserve' <<<"$RUN_OUTPUT"
grep -q 'PLAN ONLY: no Kubernetes object was changed' <<<"$RUN_OUTPUT"
assert_no_mutations "$state/kubectl.log"

# Current stopped/empty production shape selects reset-empty only when explicit.
state="$(new_state reset-plan stopped-empty)"
run_update "$state" --plan "${reset_common[@]}"
test "$RUN_STATUS" = 0
grep -q 'selected flow: new-reset-empty' <<<"$RUN_OUTPUT"
grep -q 'execute preflight performs the mandatory empty-PVC' <<<"$RUN_OUTPUT"
assert_no_mutations "$state/kubectl.log"

state="$(new_state implicit-reset-refused stopped-empty)"
run_update "$state" --plan "${common[@]}"
test "$RUN_STATUS" = 69
grep -q 'requires explicit --database-mode reset-empty' <<<"$RUN_OUTPUT"
assert_no_mutations "$state/kubectl.log"

# reset-empty refuses non-empty data and invalid/missing safety backups before resource changes.
state="$(new_state nonempty-reset stopped-present)"
run_update "$state" --execute "${reset_common[@]}" \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation" \
  --confirm-reset-empty "$reset_confirmation" --confirm-backup "$backup_confirmation"
test "$RUN_STATUS" -ne 0
grep -q 'Data PVC is not empty' <<<"$RUN_OUTPUT"
! grep -Eq ' (patch|scale|set) ' "$state/kubectl.log"
test ! -f "$state/configmap.exists"

state="$(new_state invalid-backup stopped-empty)"
put backup_valid "$state" 0
run_update "$state" --execute "${reset_common[@]}" \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation" \
  --confirm-reset-empty "$reset_confirmation" --confirm-backup "$backup_confirmation"
test "$RUN_STATUS" -ne 0
grep -q 'Backup integrity check failed' <<<"$RUN_OUTPUT"
! grep -Eq ' (patch|scale|set) ' "$state/kubectl.log"
test ! -f "$state/configmap.exists"

# reset-empty migrates, pauses before Web, and emits the safe interactive command.
state="$(new_state admin-pause stopped-empty)"
run_update "$state" --execute "${reset_common[@]}" \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation" \
  --confirm-reset-empty "$reset_confirmation" --confirm-backup "$backup_confirmation"
if [[ "$RUN_STATUS" != 75 ]]; then
  printf '%s\n' "$RUN_OUTPUT" >&2
  cat "$state/kubectl.log" >&2
fi
test "$RUN_STATUS" = 75
grep -q 'PAUSED SAFELY' <<<"$RUN_OUTPUT"
grep -q 'k8s-admin-init.sh' <<<"$RUN_OUTPUT"
test "$(cat "$state/cm.phase")" = awaiting-admin-init
test "$(cat "$state/api_replicas")" = 0
test "$(cat "$state/web_replicas")" = 0
test "$(cat "$state/cron_suspend")" = true
! grep -q 'scale deployment kaoyan-web --replicas=1' "$state/kubectl.log"
grep -q 'automountServiceAccountToken: false' "$state/yaml.log"
grep -q 'allowPrivilegeEscalation: false' "$state/yaml.log"
grep -q 'drop: \["ALL"\]' "$state/yaml.log"
grep -q 'deploy.sagirii.me/node-id: guilyrh' "$state/yaml.log"
grep -q 'deploy.sagirii.me/edge' "$state/yaml.log"
grep -Fq 'command: ["node", "dist/cli/account.js", "status"]' "$state/yaml.log"
! grep -qi 'hostPath' "$state/yaml.log"

# The helper uses only an attached TTY and records success after the CLI Pod succeeds.
state="$(new_state admin-helper stopped-empty)"
run_update "$state" --execute "${reset_common[@]}" \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation" \
  --confirm-reset-empty "$reset_confirmation" --confirm-backup "$backup_confirmation"
test "$RUN_STATUS" = 75
run_admin_init "$state" --namespace kaoyan-pomodoro --main-sha "$new_sha" \
  --confirm-context nzfklii-kite \
  --confirm-init "INITIALIZE ADMIN IN kaoyan-pomodoro ON nzfklii-kite FOR $new_sha"
test "$RUN_STATUS" = 0
grep -q 'Administrator initialization completed' <<<"$RUN_OUTPUT"
test "$(cat "$state/admin_initialized")" = 1
test "$(cat "$state/cm.phase")" = admin-initialized
grep -q 'app.kubernetes.io/component: admin-init' "$state/yaml.log"
! grep -Eqi '(password|token|secret)[=:]' "$state/kubectl.log"

# Administrator completion is detected from the database even if the helper-state patch was lost.
state="$scratch/states/admin-pause"
put admin_initialized "$state" 1
: >"$state/kubectl.log"
run_update "$state" --resume --namespace kaoyan-pomodoro \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation"
test "$RUN_STATUS" = 0
grep -q 'production update completed' <<<"$RUN_OUTPUT"
test "$(cat "$state/cm.phase")" = completed
test "$(cat "$state/api_replicas")" = 1
test "$(cat "$state/web_replicas")" = 1
test "$(cat "$state/cron_suspend")" = false

# A resume where API is already ready but Web is still 0 does not restart or reinitialize API.
state="$(new_state api-started stopped-empty)"
run_update "$state" --execute "${reset_common[@]}" \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation" \
  --confirm-reset-empty "$reset_confirmation" --confirm-backup "$backup_confirmation"
test "$RUN_STATUS" = 75
put admin_initialized "$state" 1
put cm.phase "$state" admin-initialized
put api_replicas "$state" 1; put api_available "$state" 1
: >"$state/kubectl.log"
run_update "$state" --resume --namespace kaoyan-pomodoro \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation"
test "$RUN_STATUS" = 0
! grep -q 'scale deployment kaoyan-api --replicas=1' "$state/kubectl.log"
grep -q 'scale deployment kaoyan-web --replicas=1' "$state/kubectl.log"

# Resume is independent of /tmp and the original terminal working directory.
state="$(new_state tmp-loss stopped-empty)"
run_update "$state" --execute "${reset_common[@]}" \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation" \
  --confirm-reset-empty "$reset_confirmation" --confirm-backup "$backup_confirmation"
test "$RUN_STATUS" = 75
put admin_initialized "$state" 1
mkdir -p "$scratch/new-terminal"
pushd "$scratch/new-terminal" >/dev/null
run_update "$state" --resume --namespace kaoyan-pomodoro \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation"
popd >/dev/null
test "$RUN_STATUS" = 0
test "$(cat "$state/cm.phase")" = completed

# Image pull failure is before write freeze and never touches workload state.
state="$(new_state pull-failure healthy)"
put pull_fail_component "$state" backup
run_update "$state" --execute "${common[@]}" --migration-check-passed \
  --confirm-context nzfklii-kite --confirm-execute "$preserve_confirmation"
test "$RUN_STATUS" -ne 0
grep -q 'image pull Pod.*failed' <<<"$RUN_OUTPUT"
test "$(cat "$state/api_replicas")" = 1
test "$(cat "$state/web_replicas")" = 1
test "$(cat "$state/cron_suspend")" = false
! grep -Eq ' (patch|scale|set) ' "$state/kubectl.log"
test ! -f "$state/configmap.exists"

# Migration and readiness failures enforce the stopped/suspended failure boundary.
state="$(new_state migration-failure stopped-empty)"
put migration_fail "$state" 1
run_update "$state" --execute "${reset_common[@]}" \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation" \
  --confirm-reset-empty "$reset_confirmation" --confirm-backup "$backup_confirmation"
test "$RUN_STATUS" -ne 0
grep -q 'migration Pod.*failed' <<<"$RUN_OUTPUT"
test "$(cat "$state/api_replicas")" = 0
test "$(cat "$state/web_replicas")" = 0
test "$(cat "$state/cron_suspend")" = true

state="$(new_state readiness-failure healthy)"
put readiness_fail_api "$state" 1
run_update "$state" --execute "${common[@]}" --migration-check-passed \
  --confirm-context nzfklii-kite --confirm-execute "$preserve_confirmation"
test "$RUN_STATUS" -ne 0
test "$(cat "$state/api_replicas")" = 0
test "$(cat "$state/web_replicas")" = 0
test "$(cat "$state/cron_suspend")" = true
grep -q 'failed-safe-stopped' "$state/cm.lastResult"

# A completed resume is a no-op and cannot repeat deletion, migration or admin initialization.
state="$(new_state repeated-resume stopped-empty)"
run_update "$state" --execute "${reset_common[@]}" \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation" \
  --confirm-reset-empty "$reset_confirmation" --confirm-backup "$backup_confirmation"
test "$RUN_STATUS" = 75
put admin_initialized "$state" 1
run_update "$state" --resume --namespace kaoyan-pomodoro \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation"
test "$RUN_STATUS" = 0
: >"$state/kubectl.log"
run_update "$state" --resume --namespace kaoyan-pomodoro \
  --confirm-context nzfklii-kite --confirm-execute "$reset_execute_confirmation"
test "$RUN_STATUS" = 0
grep -q 'RESUME NO-OP' <<<"$RUN_OUTPUT"
assert_no_mutations "$state/kubectl.log"
test "$(cat "$state/cm.phase")" = completed

# Invalid image forms, short SHA, wrong context and wrong confirmations are rejected.
state="$(new_state invalid-input healthy)"
run_update "$state" --plan --namespace kaoyan-pomodoro --main-sha "$new_sha" \
  --api-image "ghcr.io/monsoonr/kaoyan-pomodoro-api:latest@sha256:$new_digest" \
  --web-image "$new_web" --backup-image "$new_backup"
test "$RUN_STATUS" = 64
grep -q 'must not use latest' <<<"$RUN_OUTPUT"

run_update "$state" --plan --namespace kaoyan-pomodoro --main-sha "$new_sha" \
  --api-image "ghcr.io/monsoonr/kaoyan-pomodoro-api:feature-test@sha256:$new_digest" \
  --web-image "$new_web" --backup-image "$new_backup"
test "$RUN_STATUS" = 64
grep -q 'official repository and sha-' <<<"$RUN_OUTPUT"

run_update "$state" --plan --namespace kaoyan-pomodoro --main-sha "${new_sha:0:12}" \
  --api-image "$new_api" --web-image "$new_web" --backup-image "$new_backup"
test "$RUN_STATUS" = 64
grep -q '40-character' <<<"$RUN_OUTPUT"

wrong_api="ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-$other_sha@sha256:$new_digest"
run_update "$state" --plan --namespace kaoyan-pomodoro --main-sha "$new_sha" \
  --api-image "$wrong_api" --web-image "$new_web" --backup-image "$new_backup"
test "$RUN_STATUS" = 64
grep -q 'does not match --main-sha' <<<"$RUN_OUTPUT"

run_update "$state" --plan --namespace kaoyan-pomodoro --main-sha "$old_sha" \
  --api-image "$old_api" --web-image "$old_web" --backup-image "$old_backup"
test "$RUN_STATUS" = 69
grep -q 'already the current images' <<<"$RUN_OUTPUT"

put context "$state" wrong-context
run_update "$state" --plan "${common[@]}"
test "$RUN_STATUS" = 69
grep -q "expected 'nzfklii-kite'" <<<"$RUN_OUTPUT"
put context "$state" nzfklii-kite

: >"$state/kubectl.log"
run_update "$state" --execute "${common[@]}" --migration-check-passed \
  --confirm-context nzfklii-kite --confirm-execute WRONG
test "$RUN_STATUS" = 64
grep -q -- '--confirm-execute must exactly match' <<<"$RUN_OUTPUT"
assert_no_mutations "$state/kubectl.log"

echo 'Kubernetes update state-machine safety tests passed'
