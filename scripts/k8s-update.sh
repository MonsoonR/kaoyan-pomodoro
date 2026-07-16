#!/usr/bin/env bash
set -Eeuo pipefail

readonly PRODUCTION_CONTEXT="nzfklii-kite"
readonly PRODUCTION_NAMESPACE="kaoyan-pomodoro"
readonly REQUIRED_NODE="guilyrh"
readonly NODE_LABEL_KEY="deploy.sagirii.me/node-id"
readonly TAINT_KEY="deploy.sagirii.me/edge"
readonly PRODUCTION_ORIGIN="https://pomodoro.losenone.cn"
readonly STATE_CONFIGMAP="kaoyan-update-state"
readonly STATE_SCHEMA_VERSION="1"

action="plan"
action_selected=0
namespace="$PRODUCTION_NAMESPACE"
database_mode="preserve"
database_mode_set=0
backup_file=""
api_image=""
web_image=""
backup_image=""
main_sha=""
confirmed_context=""
execute_confirmation=""
reset_confirmation=""
backup_confirmation=""
migration_check_passed=0
record_file=""
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
POLL_ATTEMPTS="${K8S_UPDATE_POLL_ATTEMPTS:-90}"
POLL_DELAY_SECONDS="${K8S_UPDATE_POLL_DELAY_SECONDS:-2}"

usage() {
  cat <<'EOF'
Plan, inspect, execute or resume the Kubernetes production update state machine.

Status (strictly read only):
  bash scripts/k8s-update.sh --status --namespace kaoyan-pomodoro

Plan (strictly read only; preserve is the default database mode):
  bash scripts/k8s-update.sh --plan \
    --namespace kaoyan-pomodoro \
    --main-sha <40-hex-main-commit> \
    --api-image ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-<40-hex>@sha256:<64-hex> \
    --web-image ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-<40-hex>@sha256:<64-hex> \
    --backup-image ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-<40-hex>@sha256:<64-hex>

Empty-database rebuild Plan:
  bash scripts/k8s-update.sh --plan \
    --namespace kaoyan-pomodoro \
    --database-mode reset-empty \
    --backup-file kaoyan-YYYYMMDDTHHMMSSNNNNNNNNNZ-daily.sqlite.gz \
    --main-sha <40-hex-main-commit> \
    --api-image <digest-pinned-api-image> \
    --web-image <digest-pinned-web-image> \
    --backup-image <digest-pinned-backup-image>

Execution additionally requires the exact confirmations printed by Plan.
Preserve execution also requires --migration-check-passed. reset-empty execution
requires both --confirm-reset-empty and --confirm-backup. Resume loads its mode,
images, backup filename and original state from the kaoyan-update-state ConfigMap:

  bash scripts/k8s-update.sh --resume \
    --namespace kaoyan-pomodoro \
    --confirm-context nzfklii-kite \
    --confirm-execute '<exact confirmation printed by Plan>'

Safety properties:
  * Status and Plan never create, patch, scale, set, delete or apply resources.
  * Images must share one full main SHA and use sha-<40-hex>@sha256:<64-hex>.
  * reset-empty only accepts a PVC where kaoyan.sqlite, WAL and SHM are absent.
    This script never deletes those database files.
  * After write freeze, every failure leaves API/Web at 0 and Backup suspended.
  * There is no automatic image rollback, SQLite restore or down migration.
  * No Secret object is read. Passwords are handled only by k8s-admin-init.sh.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 64
}

select_action() {
  local requested="$1"
  (( action_selected == 0 )) || die "choose exactly one of --status, --plan, --execute or --resume"
  action="$requested"
  action_selected=1
}

while (($#)); do
  case "$1" in
    --status) select_action status; shift ;;
    --plan) select_action plan; shift ;;
    --execute) select_action execute; shift ;;
    --resume) select_action resume; shift ;;
    --namespace) (($# >= 2)) || die "--namespace requires a value"; namespace="$2"; shift 2 ;;
    --database-mode) (($# >= 2)) || die "--database-mode requires a value"; database_mode="$2"; database_mode_set=1; shift 2 ;;
    --backup-file) (($# >= 2)) || die "--backup-file requires a value"; backup_file="$2"; shift 2 ;;
    --main-sha) (($# >= 2)) || die "--main-sha requires a value"; main_sha="$2"; shift 2 ;;
    --api-image) (($# >= 2)) || die "--api-image requires a value"; api_image="$2"; shift 2 ;;
    --web-image) (($# >= 2)) || die "--web-image requires a value"; web_image="$2"; shift 2 ;;
    --backup-image) (($# >= 2)) || die "--backup-image requires a value"; backup_image="$2"; shift 2 ;;
    --confirm-context) (($# >= 2)) || die "--confirm-context requires a value"; confirmed_context="$2"; shift 2 ;;
    --confirm-execute) (($# >= 2)) || die "--confirm-execute requires a value"; execute_confirmation="$2"; shift 2 ;;
    --confirm-reset-empty) (($# >= 2)) || die "--confirm-reset-empty requires a value"; reset_confirmation="$2"; shift 2 ;;
    --confirm-backup) (($# >= 2)) || die "--confirm-backup requires a value"; backup_confirmation="$2"; shift 2 ;;
    --migration-check-passed) migration_check_passed=1; shift ;;
    --record-file) (($# >= 2)) || die "--record-file requires a value"; record_file="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$namespace" == "$PRODUCTION_NAMESPACE" ]] || die "namespace must be exactly $PRODUCTION_NAMESPACE"
[[ "$database_mode" == "preserve" || "$database_mode" == "reset-empty" ]] || die "--database-mode must be preserve or reset-empty"
[[ "$POLL_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "K8S_UPDATE_POLL_ATTEMPTS must be a positive integer"
[[ "$POLL_DELAY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "K8S_UPDATE_POLL_DELAY_SECONDS must be a non-negative number"

validate_backup_filename() {
  [[ -n "$backup_file" ]] || die "--backup-file is required with --database-mode reset-empty"
  [[ "$backup_file" =~ ^kaoyan-[0-9]{8}T[0-9]{15}Z-(manual|daily|pre-update|pre-restore)\.sqlite\.gz$ ]] ||
    die "backup filename must be an exact kaoyan timestamped .sqlite.gz filename without a path"
}

validate_image() {
  local component="$1" image="$2" image_sha
  [[ -n "$image" ]] || die "--${component}-image is required"
  [[ "${image,,}" != *latest* ]] || die "$component image must not use latest"
  if [[ ! "$image" =~ ^ghcr\.io/monsoonr/kaoyan-pomodoro-${component}:sha-([0-9a-f]{40})@sha256:([0-9a-f]{64})$ ]]; then
    die "$component image must use the official repository and sha-<40-hex>@sha256:<64-hex>"
  fi
  image_sha="${BASH_REMATCH[1]}"
  [[ "$image_sha" == "$main_sha" ]] || die "$component image tag does not match --main-sha"
}

validate_target() {
  [[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || die "--main-sha must be a reviewed 40-character commit already merged to main"
  validate_image api "$api_image"
  validate_image web "$web_image"
  validate_image backup "$backup_image"
  if [[ "$database_mode" == "reset-empty" ]]; then
    validate_backup_filename
  elif [[ -n "$backup_file" ]]; then
    die "--backup-file is only valid with --database-mode reset-empty"
  fi
}

if [[ "$action" == "plan" || "$action" == "execute" ]]; then
  validate_target
fi

command -v "$KUBECTL_BIN" >/dev/null 2>&1 || die "kubectl is required"
k() { "$KUBECTL_BIN" --namespace "$namespace" "$@"; }
safe_get() {
  local value
  value="$(k "$@")" || { echo "ERROR: kubectl read-only check failed: $*" >&2; exit 69; }
  printf '%s' "$value"
}
require_equal() {
  local description="$1" actual="$2" expected="$3"
  [[ "$actual" == "$expected" ]] || { echo "ERROR: $description is '$actual', expected '$expected'" >&2; exit 69; }
}
require_contains_word() {
  local description="$1" actual="$2" expected="$3"
  case " $actual " in
    *" $expected "*) ;;
    *) echo "ERROR: $description does not contain '$expected'" >&2; exit 69 ;;
  esac
}
line_count() {
  local value="$1" count=0 line
  while IFS= read -r line; do
    [[ -n "$line" ]] && count=$((count + 1))
  done <<<"$value"
  printf '%s' "$count"
}

current_context="$("$KUBECTL_BIN" config current-context)" || { echo "ERROR: cannot read current kubectl context" >&2; exit 69; }
require_equal "kubectl context" "$current_context" "$PRODUCTION_CONTEXT"

"$KUBECTL_BIN" get namespace "$namespace" -o name >/dev/null
for resource in \
  deployment/kaoyan-api deployment/kaoyan-web cronjob/kaoyan-backup \
  persistentvolumeclaim/kaoyan-data persistentvolumeclaim/kaoyan-backups \
  ingress/kaoyan-pomodoro certificate/kaoyan-pomodoro-certs; do
  k get "$resource" -o name >/dev/null
done

api_current_image="$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.template.spec.containers[?(@.name=="api")].image}')"
web_current_image="$(safe_get get deployment kaoyan-web -o 'jsonpath={.spec.template.spec.containers[?(@.name=="web")].image}')"
backup_current_image="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[?(@.name=="backup")].image}')"
api_replicas="$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.replicas}')"
web_replicas="$(safe_get get deployment kaoyan-web -o 'jsonpath={.spec.replicas}')"
api_available="$(safe_get get deployment kaoyan-api -o 'jsonpath={.status.availableReplicas}')"
web_available="$(safe_get get deployment kaoyan-web -o 'jsonpath={.status.availableReplicas}')"
api_strategy="$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.strategy.type}')"
cron_suspend="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.suspend}')"
cron_active="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.active[*].name}')"
cron_last_schedule="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.lastScheduleTime}')"
cron_last_success="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.lastSuccessfulTime}')"
data_pvc_phase="$(safe_get get pvc kaoyan-data -o 'jsonpath={.status.phase}')"
backup_pvc_phase="$(safe_get get pvc kaoyan-backups -o 'jsonpath={.status.phase}')"
certificate_ready="$(safe_get get certificate kaoyan-pomodoro-certs -o 'jsonpath={.status.conditions[?(@.type=="Ready")].status}')"
ingress_class="$(safe_get get ingress kaoyan-pomodoro -o 'jsonpath={.spec.ingressClassName}')"
ingress_hosts="$(safe_get get ingress kaoyan-pomodoro -o 'jsonpath={.spec.rules[*].host}')"
api_pods="$(safe_get get pods -l 'app.kubernetes.io/component=api' -o name)"
web_pods="$(safe_get get pods -l 'app.kubernetes.io/component=web' -o name)"
api_pod_count="$(line_count "$api_pods")"
web_pod_count="$(line_count "$web_pods")"

state_name="$(safe_get get configmap "$STATE_CONFIGMAP" -o name --ignore-not-found)"
state_exists=0
[[ -n "$state_name" ]] && state_exists=1
read_state_field() {
  local field="$1"
  if (( state_exists )); then
    safe_get get configmap "$STATE_CONFIGMAP" -o "jsonpath={.data.${field}}"
  fi
}

state_schema="$(read_state_field schemaVersion)"
state_phase="$(read_state_field phase)"
state_main_sha="$(read_state_field mainSha)"
state_database_mode="$(read_state_field databaseMode)"
state_backup_file="$(read_state_field backupFile)"
state_api_image="$(read_state_field apiImage)"
state_web_image="$(read_state_field webImage)"
state_backup_image="$(read_state_field backupImage)"
state_api_replicas="$(read_state_field desiredApiReplicas)"
state_web_replicas="$(read_state_field desiredWebReplicas)"
state_final_cron_suspend="$(read_state_field finalCronSuspend)"
state_database_status="$(read_state_field databaseStatus)"
state_backup_job="$(read_state_field backupJob)"

database_files="unknown-no-running-api-pod"
if [[ -n "$api_pods" ]]; then
  first_api_pod="${api_pods%%$'\n'*}"
  first_api_pod="${first_api_pod#pod/}"
  if live_database_files="$(k exec "$first_api_pod" -- /bin/sh -ceu '
    for entry in main:kaoyan.sqlite wal:kaoyan.sqlite-wal shm:kaoyan.sqlite-shm; do
      label=${entry%%:*}; file=${entry#*:}
      if test -e "/var/lib/kaoyan/$file"; then printf "%s=present " "$label"; else printf "%s=absent " "$label"; fi
    done
  ' 2>/dev/null)"; then
    database_files="${live_database_files% }"
  else
    database_files="unknown-live-inspection-failed"
  fi
elif [[ -n "$state_database_status" ]]; then
  database_files="state:$state_database_status"
fi

print_status() {
  cat <<EOF
Kubernetes production update status (read only).
  context: $current_context
  namespace: $namespace
  state object: ${state_name:-<none>}
  state phase: ${state_phase:-<none>}
  state target main SHA: ${state_main_sha:-<none>}
  state database mode: ${state_database_mode:-<none>}
  API image: $api_current_image
  Web image: $web_current_image
  Backup image: $backup_current_image
  API replicas / available / Pods: $api_replicas / ${api_available:-0} / $api_pod_count
  API Pod objects: ${api_pods:-<none>}
  Web replicas / available / Pods: $web_replicas / ${web_available:-0} / $web_pod_count
  Web Pod objects: ${web_pods:-<none>}
  Backup suspended / active Jobs: $cron_suspend / ${cron_active:-0}
  Backup last schedule: ${cron_last_schedule:-<none>}
  Backup last success: ${cron_last_success:-<none>}
  data PVC / backup PVC: $data_pvc_phase / $backup_pvc_phase
  Certificate Ready: ${certificate_ready:-<none>}
  database files: $database_files
EOF
  if [[ "$database_files" == unknown-* ]]; then
    echo "  database evidence note: strict read-only mode will not create a PVC inspector Pod."
  fi
}

if [[ "$action" == "status" ]]; then
  print_status
  echo "STATUS ONLY: no Kubernetes object was changed."
  exit 0
fi

if [[ "$action" == "resume" ]]; then
  (( state_exists )) || die "--resume requires the persistent $STATE_CONFIGMAP ConfigMap"
  require_equal "state schema version" "$state_schema" "$STATE_SCHEMA_VERSION"
  [[ -n "$state_main_sha" && -n "$state_database_mode" && -n "$state_api_image" && -n "$state_web_image" && -n "$state_backup_image" ]] ||
    die "persistent update state is incomplete"

  supplied_targets=0
  [[ -n "$main_sha$api_image$web_image$backup_image" ]] && supplied_targets=1
  if (( supplied_targets )); then
    [[ -n "$main_sha" && -n "$api_image" && -n "$web_image" && -n "$backup_image" ]] ||
      die "resume target overrides must include --main-sha and all three images"
  else
    main_sha="$state_main_sha"
    api_image="$state_api_image"
    web_image="$state_web_image"
    backup_image="$state_backup_image"
  fi
  if (( database_mode_set )); then
    require_equal "resume database mode" "$database_mode" "$state_database_mode"
  else
    database_mode="$state_database_mode"
  fi
  if [[ -n "$backup_file" ]]; then
    require_equal "resume backup file" "$backup_file" "$state_backup_file"
  else
    backup_file="$state_backup_file"
  fi
  validate_target
  require_equal "resume main SHA" "$main_sha" "$state_main_sha"
  require_equal "resume API image" "$api_image" "$state_api_image"
  require_equal "resume Web image" "$web_image" "$state_web_image"
  require_equal "resume Backup image" "$backup_image" "$state_backup_image"
fi

validate_common_topology() {
  [[ "$api_replicas" =~ ^[0-9]+$ && "$web_replicas" =~ ^[0-9]+$ ]] || { echo "ERROR: deployment replica state is invalid" >&2; exit 69; }
  [[ "$cron_suspend" == "true" || "$cron_suspend" == "false" ]] || { echo "ERROR: invalid CronJob suspend state" >&2; exit 69; }
  require_equal "API strategy" "$api_strategy" "Recreate"
  require_equal "data PVC phase" "$data_pvc_phase" "Bound"
  require_equal "backup PVC phase" "$backup_pvc_phase" "Bound"
  require_equal "Certificate Ready condition" "$certificate_ready" "True"
  require_equal "Ingress class" "$ingress_class" "traefik"
  require_contains_word "Ingress host" "$ingress_hosts" "pomodoro.losenone.cn"
  [[ -z "$cron_active" ]] || { echo "ERROR: Backup CronJob has active Job(s): $cron_active" >&2; exit 69; }
}

check_template_scheduling() {
  local description="$1" resource="$2" prefix="$3" node_values node_operators toleration_values toleration_operators toleration_effects
  node_values="$(safe_get get "$resource" -o "jsonpath={${prefix}.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[*].matchExpressions[?(@.key==\"${NODE_LABEL_KEY}\")].values[*]}")"
  node_operators="$(safe_get get "$resource" -o "jsonpath={${prefix}.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[*].matchExpressions[?(@.key==\"${NODE_LABEL_KEY}\")].operator}")"
  toleration_values="$(safe_get get "$resource" -o "jsonpath={${prefix}.tolerations[?(@.key==\"${TAINT_KEY}\")].value}")"
  toleration_operators="$(safe_get get "$resource" -o "jsonpath={${prefix}.tolerations[?(@.key==\"${TAINT_KEY}\")].operator}")"
  toleration_effects="$(safe_get get "$resource" -o "jsonpath={${prefix}.tolerations[?(@.key==\"${TAINT_KEY}\")].effect}")"
  require_contains_word "$description node affinity" "$node_values" "$REQUIRED_NODE"
  require_contains_word "$description node affinity operator" "$node_operators" "In"
  require_contains_word "$description edge toleration value" "$toleration_values" "true"
  require_contains_word "$description edge toleration operator" "$toleration_operators" "Equal"
  require_contains_word "$description edge toleration effect" "$toleration_effects" "NoSchedule"
}

check_pod_nodes_if_present() {
  local component="$1" nodes node
  nodes="$(safe_get get pods -l "app.kubernetes.io/component=$component" -o 'jsonpath={range .items[*]}{.spec.nodeName}{"\n"}{end}')"
  while IFS= read -r node; do
    [[ -z "$node" || "$node" == "$REQUIRED_NODE" ]] || { echo "ERROR: $component Pod is on '$node', expected '$REQUIRED_NODE'" >&2; exit 69; }
  done <<<"$nodes"
}

validate_common_topology
check_template_scheduling "API" deployment/kaoyan-api '.spec.template.spec'
check_template_scheduling "Web" deployment/kaoyan-web '.spec.template.spec'
check_template_scheduling "Backup" cronjob/kaoyan-backup '.spec.jobTemplate.spec.template.spec'
check_pod_nodes_if_present api
check_pod_nodes_if_present web

plan_kind="new-$database_mode"
if (( state_exists )) && [[ -n "$state_phase" && "$state_phase" != "completed" ]]; then
  require_equal "active state main SHA" "$state_main_sha" "$main_sha"
  require_equal "active state database mode" "$state_database_mode" "$database_mode"
  require_equal "active state API image" "$state_api_image" "$api_image"
  require_equal "active state Web image" "$state_web_image" "$web_image"
  require_equal "active state Backup image" "$state_backup_image" "$backup_image"
  plan_kind="resume-$database_mode"
elif (( state_exists )) && [[ "$state_phase" == "completed" && "$state_main_sha" == "$main_sha" ]]; then
  plan_kind="completed-$database_mode"
fi

if [[ "$plan_kind" == new-* &&
      "$api_current_image" == "$api_image" && "$web_current_image" == "$web_image" && "$backup_current_image" == "$backup_image" ]]; then
  echo "ERROR: all three target images are already the current images; refusing an update that does not advance the main image set" >&2
  exit 69
fi

if [[ "$plan_kind" == "new-preserve" ]]; then
  (( api_replicas > 0 && web_replicas > 0 )) || {
    echo "ERROR: preserve mode requires healthy running API/Web. This stopped site requires explicit --database-mode reset-empty only if the data PVC is already empty." >&2
    exit 69
  }
  require_equal "API available replicas" "${api_available:-0}" "$api_replicas"
  require_equal "Web available replicas" "${web_available:-0}" "$web_replicas"
  (( api_pod_count > 0 && web_pod_count > 0 )) || { echo "ERROR: preserve mode requires running API/Web Pods" >&2; exit 69; }
  [[ "$database_files" == *"main=present"* ]] || { echo "ERROR: preserve mode could not confirm the running SQLite database" >&2; exit 69; }
elif [[ "$plan_kind" == "new-reset-empty" ]]; then
  require_equal "API replicas" "$api_replicas" "0"
  require_equal "Web replicas" "$web_replicas" "0"
  require_equal "API Pod count" "$api_pod_count" "0"
  require_equal "Web Pod count" "$web_pod_count" "0"
  require_equal "Backup CronJob suspend" "$cron_suspend" "true"
  [[ "$database_files" != *"main=present"* && "$database_files" != *"wal=present"* && "$database_files" != *"shm=present"* ]] || {
    echo "ERROR: reset-empty refuses a data PVC containing SQLite, WAL or SHM" >&2
    exit 69
  }
fi

required_execute_confirmation="UPDATE $namespace ON $current_context TO $main_sha USING $database_mode"
required_reset_confirmation="RESET EMPTY DATABASE IN $namespace ON $current_context"
required_backup_confirmation="TRUST VERIFIED BACKUP $backup_file"

print_plan() {
  print_status
  cat <<EOF
  selected flow: $plan_kind
  target main SHA: $main_sha
  target API image: $api_image
  target Web image: $web_image
  target Backup image: $backup_image
EOF
  if [[ "$plan_kind" == resume-* ]]; then
    echo "  persistent resume phase: $state_phase"
  fi
  cat <<EOF

Planned state-machine sequence:
  1. Pull-check all three digest-pinned images on $REQUIRED_NODE before write freeze.
  2. Persist the operation identity and phase in ConfigMap/$STATE_CONFIGMAP.
EOF
  if [[ "$database_mode" == "preserve" ]]; then
    cat <<'EOF'
  3. Suspend Backup, stop Web and API, and wait for all application Pods to exit.
  4. Create one deterministic pre-update Job and require its validated backup to succeed.
  5. Update the API, Web and Backup images while application writes remain stopped.
  6. Start API first; wait for migrations, rollout, node placement and readiness.
  7. Start Web only after API is ready; then verify HTTPS and Certificate readiness.
  8. Restore the recorded pre-update CronJob suspend state and mark completed.
EOF
  else
    cat <<EOF
  3. Before any existing resource is changed, use a restricted temporary Pod to prove:
     API/Web are stopped, Backup is suspended with no active Job, SQLite/WAL/SHM
     are absent, and $backup_file exists and passes gzip/integrity/foreign-key checks.
  4. Update all three images, then run all migrations with the new API image on kaoyan-data.
  5. Persist awaiting-admin-init and keep API/Web at 0. Run k8s-admin-init.sh interactively.
  6. On --resume, prove an administrator exists, start API first, then start Web.
  7. Verify HTTPS and Certificate readiness, resume Backup, and mark completed.
EOF
  fi
  cat <<EOF

Failure boundary:
  After write freeze, every failure enforces API/Web=0 and Backup suspend=true.
  No old image, old SQLite file or down migration is applied automatically.

Required execute confirmation: $required_execute_confirmation
EOF
  if [[ "$database_mode" == "reset-empty" ]]; then
    cat <<EOF
Required reset-empty confirmation: $required_reset_confirmation
Required backup confirmation: $required_backup_confirmation
Read-only limitation: with API at 0, Plan cannot mount the PVC without creating a Pod.
The execute preflight performs the mandatory empty-PVC and backup validation before
changing Deployment or CronJob state. The update script itself never deletes SQLite files.
EOF
  fi
}

if [[ "$action" == "plan" ]]; then
  print_plan
  echo "PLAN ONLY: no Kubernetes object was changed."
  exit 0
fi

if [[ "$action" == "execute" && "$plan_kind" == resume-* ]]; then
  die "an incomplete persistent operation exists; use --resume with the printed target"
fi
if [[ "$action" == "execute" && "$plan_kind" == completed-* ]]; then
  die "this target is already recorded as completed; use --status or --resume to verify it"
fi

[[ -n "$confirmed_context" ]] || die "--$action requires --confirm-context"
require_equal "confirmed context" "$confirmed_context" "$current_context"
[[ "$execute_confirmation" == "$required_execute_confirmation" ]] || die "--confirm-execute must exactly match '$required_execute_confirmation'"
if [[ "$action" == "execute" && "$database_mode" == "preserve" ]]; then
  (( migration_check_passed )) || die "preserve execution requires --migration-check-passed after an offline rehearsal against a verified backup copy"
fi
if [[ "$action" == "execute" && "$database_mode" == "reset-empty" ]]; then
  [[ "$reset_confirmation" == "$required_reset_confirmation" ]] || die "--confirm-reset-empty must exactly match '$required_reset_confirmation'"
  [[ "$backup_confirmation" == "$required_backup_confirmation" ]] || die "--confirm-backup must exactly match '$required_backup_confirmation'"
fi
command -v curl >/dev/null 2>&1 || die "curl is required for execute and resume health checks"

if [[ "$action" == "resume" && "$state_phase" == "completed" &&
      "$api_current_image" == "$api_image" && "$web_current_image" == "$web_image" && "$backup_current_image" == "$backup_image" &&
      "$api_replicas" == "$state_api_replicas" && "${api_available:-0}" == "$state_api_replicas" &&
      "$web_replicas" == "$state_web_replicas" && "${web_available:-0}" == "$state_web_replicas" &&
      "$cron_suspend" == "$state_final_cron_suspend" && "$certificate_ready" == "True" ]]; then
  curl -fsS --max-time 15 -o /dev/null "$PRODUCTION_ORIGIN/api/health/live" || die "completed-state live health verification failed"
  curl -fsS --max-time 30 -o /dev/null "$PRODUCTION_ORIGIN/api/health/ready" || die "completed-state readiness verification failed"
  curl -fsS --max-time 30 -o /dev/null "$PRODUCTION_ORIGIN/" || die "completed-state Web health verification failed"
  echo "Persistent update state is already completed and live resources match the recorded target."
  echo "RESUME NO-OP: no Kubernetes object was changed."
  exit 0
fi

timestamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
temp_pods=()
freeze_started=0
completed=0
state_writable=0

cleanup_temp_pods() {
  local pod
  for pod in "${temp_pods[@]}"; do
    k delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
}

state_patch() {
  local data_json="$1"
  k patch configmap "$STATE_CONFIGMAP" --type=merge -p "{\"data\":{$data_json}}" >/dev/null
}

set_phase() {
  state_phase="$1"
  state_patch "\"phase\":\"$state_phase\",\"lastResult\":\"in-progress\""
  echo "Persistent update phase: $state_phase"
}

on_exit() {
  local status=$?
  trap - EXIT
  cleanup_temp_pods
  if (( status != 0 && ! completed && freeze_started )); then
    echo "ERROR: update did not complete; enforcing the safe stopped state." >&2
    k scale deployment kaoyan-web --replicas=0 >/dev/null 2>&1 || true
    k scale deployment kaoyan-api --replicas=0 >/dev/null 2>&1 || true
    k patch cronjob kaoyan-backup --type=merge -p '{"spec":{"suspend":true}}' >/dev/null 2>&1 || true
    if (( state_writable )); then
      state_patch '"lastResult":"failed-safe-stopped"' >/dev/null 2>&1 || true
    fi
    echo "API/Web remain at 0 and Backup remains suspended." >&2
    echo "No image rollback, SQLite restore or down migration was attempted." >&2
    echo "Resume from ConfigMap/$STATE_CONFIGMAP; no /tmp file is required." >&2
  fi
  exit "$status"
}
trap on_exit EXIT

wait_for_pod_success() {
  local pod="$1" purpose="$2" phase i
  for ((i = 1; i <= POLL_ATTEMPTS; i++)); do
    phase="$(safe_get get pod "$pod" -o 'jsonpath={.status.phase}')"
    case "$phase" in
      Succeeded) return 0 ;;
      Failed)
        echo "ERROR: $purpose Pod $pod failed" >&2
        k logs "$pod" >&2 || true
        return 1
        ;;
    esac
    (( i < POLL_ATTEMPTS )) && sleep "$POLL_DELAY_SECONDS"
  done
  echo "ERROR: $purpose Pod $pod timed out" >&2
  return 1
}

render_pull_pod() {
  local pod="$1" component="$2" image="$3" uid="$4"
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  labels:
    app.kubernetes.io/name: kaoyan-pomodoro
    app.kubernetes.io/component: update-pull-$component
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  activeDeadlineSeconds: 300
  nodeSelector:
    $NODE_LABEL_KEY: $REQUIRED_NODE
  tolerations:
    - key: $TAINT_KEY
      operator: Equal
      value: "true"
      effect: NoSchedule
  securityContext:
    runAsNonRoot: true
    runAsUser: $uid
    runAsGroup: $uid
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: pull
      image: $image
      imagePullPolicy: Always
      command: ["/bin/sh", "-c", "exit 0"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
EOF
}

pull_check() {
  local component="$1" image="$2" uid="$3" pod
  pod="kaoyan-pull-${component}-${timestamp,,}"
  temp_pods+=("$pod")
  render_pull_pod "$pod" "$component" "$image" "$uid" | k create -f - >/dev/null
  wait_for_pod_success "$pod" "image pull"
  k delete pod "$pod" --wait=true >/dev/null
  echo "Image pull check passed on $REQUIRED_NODE: $component"
}

render_reset_check_pod() {
  local pod="$1"
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  labels:
    app.kubernetes.io/name: kaoyan-pomodoro
    app.kubernetes.io/component: update-reset-check
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  activeDeadlineSeconds: 900
  nodeSelector:
    $NODE_LABEL_KEY: $REQUIRED_NODE
  tolerations:
    - key: $TAINT_KEY
      operator: Equal
      value: "true"
      effect: NoSchedule
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    fsGroupChangePolicy: OnRootMismatch
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: reset-check
      image: $backup_image
      imagePullPolicy: IfNotPresent
      env:
        - name: BACKUP_FILE
          value: "$backup_file"
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          for file in kaoyan.sqlite kaoyan.sqlite-wal kaoyan.sqlite-shm; do
            test ! -e "/var/lib/kaoyan/\$file" || { echo "Data PVC is not empty" >&2; exit 66; }
          done
          archive="/backups/\$BACKUP_FILE"
          /app/scripts/validate-backup.sh "\$archive" >/dev/null
          gzip -dc "\$archive" >/tmp/safety.sqlite
          test "\$(sqlite3 /tmp/safety.sqlite 'PRAGMA integrity_check;')" = ok
          test -z "\$(sqlite3 /tmp/safety.sqlite 'PRAGMA foreign_key_check;')"
          echo reset-empty-preflight-ok
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: data
          mountPath: /var/lib/kaoyan
          readOnly: true
        - name: backups
          mountPath: /backups
          readOnly: true
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: kaoyan-data
    - name: backups
      persistentVolumeClaim:
        claimName: kaoyan-backups
    - name: tmp
      emptyDir: {}
EOF
}

run_reset_validation() {
  local pod="kaoyan-reset-check-${main_sha:0:12}"
  temp_pods+=("$pod")
  k delete pod "$pod" --ignore-not-found --wait=true >/dev/null
  render_reset_check_pod "$pod" | k create -f - >/dev/null
  wait_for_pod_success "$pod" "reset-empty validation"
  require_equal "reset-empty validation marker" "$(safe_get logs "$pod")" "reset-empty-preflight-ok"
  k delete pod "$pod" --wait=true >/dev/null
  echo "Empty data PVC and verified safety backup confirmed. No database file was deleted."
}

render_api_task_pod() {
  local pod="$1" component="$2" command_arg="$3" task_arg="${4:-}" command_json
  command_json="[\"node\", \"$command_arg\"]"
  if [[ -n "$task_arg" ]]; then
    command_json="[\"node\", \"$command_arg\", \"$task_arg\"]"
  fi
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  labels:
    app.kubernetes.io/name: kaoyan-pomodoro
    app.kubernetes.io/component: $component
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  activeDeadlineSeconds: 900
  nodeSelector:
    $NODE_LABEL_KEY: $REQUIRED_NODE
  tolerations:
    - key: $TAINT_KEY
      operator: Equal
      value: "true"
      effect: NoSchedule
  securityContext:
    runAsNonRoot: true
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    fsGroupChangePolicy: OnRootMismatch
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: task
      image: $api_image
      imagePullPolicy: IfNotPresent
      env:
        - name: DATABASE_PATH
          value: /var/lib/kaoyan/kaoyan.sqlite
      command: $command_json
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: data
          mountPath: /var/lib/kaoyan
        - name: tmp
          mountPath: /tmp
  volumes:
    - name: data
      persistentVolumeClaim:
        claimName: kaoyan-data
    - name: tmp
      emptyDir: {}
EOF
}

run_api_task() {
  local pod="$1" component="$2" command_arg="$3" purpose="$4" task_arg="${5:-}" existing phase pod_image
  existing="$(safe_get get pod "$pod" -o name --ignore-not-found)"
  if [[ -n "$existing" ]]; then
    pod_image="$(safe_get get pod "$pod" -o 'jsonpath={.spec.containers[0].image}')"
    require_equal "$purpose Pod image" "$pod_image" "$api_image"
    phase="$(safe_get get pod "$pod" -o 'jsonpath={.status.phase}')"
    if [[ "$phase" == "Failed" ]]; then
      k delete pod "$pod" --wait=true >/dev/null
      existing=""
    fi
  fi
  if [[ -z "$existing" ]]; then
    render_api_task_pod "$pod" "$component" "$command_arg" "$task_arg" | k create -f - >/dev/null
  fi
  temp_pods+=("$pod")
  wait_for_pod_success "$pod" "$purpose"
}

ensure_state_object() {
  local existing
  existing="$(safe_get get configmap "$STATE_CONFIGMAP" -o name --ignore-not-found)"
  if [[ -z "$existing" ]]; then
    k create configmap "$STATE_CONFIGMAP" --from-literal=schemaVersion="$STATE_SCHEMA_VERSION" >/dev/null
  fi
  state_writable=1
}

begin_state() {
  local desired_api="$1" desired_web="$2" final_suspend="$3" initial_phase="$4" database_status="$5"
  ensure_state_object
  state_patch "\"schemaVersion\":\"$STATE_SCHEMA_VERSION\",\"phase\":\"$initial_phase\",\"mainSha\":\"$main_sha\",\"databaseMode\":\"$database_mode\",\"backupFile\":\"$backup_file\",\"apiImage\":\"$api_image\",\"webImage\":\"$web_image\",\"backupImage\":\"$backup_image\",\"desiredApiReplicas\":\"$desired_api\",\"desiredWebReplicas\":\"$desired_web\",\"finalCronSuspend\":\"$final_suspend\",\"databaseStatus\":\"$database_status\",\"backupJob\":\"\",\"lastResult\":\"in-progress\""
  state_phase="$initial_phase"
  state_api_replicas="$desired_api"
  state_web_replicas="$desired_web"
  state_final_cron_suspend="$final_suspend"
  echo "Persistent update state initialized: ConfigMap/$STATE_CONFIGMAP ($state_phase)"
}

if [[ "$action" == "execute" ]]; then
  pull_check api "$api_image" 10001
  pull_check web "$web_image" 10002
  pull_check backup "$backup_image" 10001

  if [[ "$database_mode" == "reset-empty" ]]; then
    run_reset_validation
    begin_state 1 1 false reset-verified empty-verified
    freeze_started=1
  else
    begin_state "$api_replicas" "$web_replicas" "$cron_suspend" preflight-complete present
  fi

  if [[ -n "$record_file" ]]; then
    umask 077
    {
      echo "context=$current_context"
      echo "namespace=$namespace"
      echo "database_mode=$database_mode"
      echo "target_main_sha=$main_sha"
      echo "state_configmap=$STATE_CONFIGMAP"
    } >"$record_file"
    chmod 0600 "$record_file"
    echo "Optional local audit record: $record_file"
  fi
else
  state_writable=1
  state_api_replicas="${state_api_replicas:-1}"
  state_web_replicas="${state_web_replicas:-1}"
  state_final_cron_suspend="${state_final_cron_suspend:-false}"
  freeze_started=1
fi

wait_no_pods() {
  local component="$1" pods i
  for ((i = 1; i <= POLL_ATTEMPTS; i++)); do
    pods="$(safe_get get pods -l "app.kubernetes.io/component=$component" -o name)"
    [[ -z "$pods" ]] && return 0
    (( i < POLL_ATTEMPTS )) && sleep "$POLL_DELAY_SECONDS"
  done
  echo "ERROR: $component Pods did not terminate" >&2
  return 1
}

phase_is_before_freeze=0
[[ "$state_phase" == "preflight-complete" ]] && phase_is_before_freeze=1
if (( phase_is_before_freeze )); then
  k patch cronjob kaoyan-backup --type=merge -p '{"spec":{"suspend":true}}' >/dev/null
  active_after_suspend="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.active[*].name}')"
  [[ -z "$active_after_suspend" ]] || { echo "ERROR: Backup Job became active before write freeze: $active_after_suspend" >&2; exit 69; }
  freeze_started=1
  k scale deployment kaoyan-web --replicas=0 >/dev/null
  k scale deployment kaoyan-api --replicas=0 >/dev/null
  wait_no_pods web
  wait_no_pods api
  set_phase write-frozen
fi

if [[ "$database_mode" == "preserve" && ( "$state_phase" == "write-frozen" || "$state_phase" == "preflight-complete" ) ]]; then
  backup_job="${state_backup_job:-kaoyan-backup-pre-update-${main_sha:0:12}}"
  existing_job="$(safe_get get job "$backup_job" -o name --ignore-not-found)"
  if [[ -z "$existing_job" ]]; then
    k create job --from=cronjob/kaoyan-backup "$backup_job" >/dev/null
  fi
  k wait --for=condition=complete --timeout=1800s "job/$backup_job" >/dev/null
  require_equal "pre-update backup Job succeeded count" "$(safe_get get job "$backup_job" -o 'jsonpath={.status.succeeded}')" "1"
  state_patch "\"backupJob\":\"$backup_job\""
  set_phase backup-verified
  echo "Verified pre-update backup Job: $backup_job"
fi

current_api_image="$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.template.spec.containers[?(@.name=="api")].image}')"
current_web_image="$(safe_get get deployment kaoyan-web -o 'jsonpath={.spec.template.spec.containers[?(@.name=="web")].image}')"
current_backup_image="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[?(@.name=="backup")].image}')"
if [[ "$current_api_image" != "$api_image" || "$current_web_image" != "$web_image" || "$current_backup_image" != "$backup_image" ]]; then
  k patch cronjob kaoyan-backup --type=merge -p '{"spec":{"suspend":true}}' >/dev/null
  k scale deployment kaoyan-web --replicas=0 >/dev/null
  k scale deployment kaoyan-api --replicas=0 >/dev/null
  wait_no_pods web
  wait_no_pods api
  k set image deployment/kaoyan-api "api=$api_image" >/dev/null
  k set image deployment/kaoyan-web "web=$web_image" >/dev/null
  k set image cronjob/kaoyan-backup "backup=$backup_image" >/dev/null
fi
require_equal "target API image" "$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.template.spec.containers[?(@.name=="api")].image}')" "$api_image"
require_equal "target Web image" "$(safe_get get deployment kaoyan-web -o 'jsonpath={.spec.template.spec.containers[?(@.name=="web")].image}')" "$web_image"
require_equal "target Backup image" "$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[?(@.name=="backup")].image}')" "$backup_image"
if [[ "$state_phase" == "backup-verified" || "$state_phase" == "reset-verified" || "$state_phase" == "write-frozen" ]]; then
  set_phase images-updated
fi

if [[ "$database_mode" == "reset-empty" ]]; then
  if [[ "$state_phase" == "images-updated" || "$state_phase" == "reset-verified" ]]; then
    migration_pod="kaoyan-migrate-${main_sha:0:12}"
    run_api_task "$migration_pod" update-migration dist/db/migrate.js migration
    set_phase migration-completed
    state_patch '"databaseStatus":"migrated-empty"'
    k delete pod "$migration_pod" --ignore-not-found --wait=true >/dev/null
  fi

  if [[ "$state_phase" == "migration-completed" || "$state_phase" == "awaiting-admin-init" ]]; then
    account_pod="kaoyan-account-status-${main_sha:0:12}"
    run_api_task "$account_pod" update-account-status dist/cli/account.js account-status status
    account_status="$(safe_get logs "$account_pod")"
    k delete pod "$account_pod" --ignore-not-found --wait=true >/dev/null
    if [[ "$account_status" != "initialized" ]]; then
      require_equal "administrator status" "$account_status" "not-initialized"
      set_phase awaiting-admin-init
      trap - EXIT
      cleanup_temp_pods
      cat <<EOF
PAUSED SAFELY: migrations completed, but no administrator is initialized.
API/Web remain at 0 and Backup remains suspended.

Run the interactive one-time initializer (password stays on the TTY only):
  bash scripts/k8s-admin-init.sh --namespace $namespace --main-sha $main_sha \\
    --confirm-context $current_context \\
    --confirm-init 'INITIALIZE ADMIN IN $namespace ON $current_context FOR $main_sha'

Then resume without any /tmp state:
  bash scripts/k8s-update.sh --resume --namespace $namespace \\
    --confirm-context $current_context \\
    --confirm-execute '$required_execute_confirmation'
EOF
      exit 75
    fi
    set_phase admin-initialized
    state_patch '"databaseStatus":"administrator-initialized"'
  fi
fi

ensure_deployment_ready() {
  local component="$1" deployment="$2" desired="$3" current available
  current="$(safe_get get deployment "$deployment" -o 'jsonpath={.spec.replicas}')"
  if [[ "$current" != "$desired" ]]; then
    k scale deployment "$deployment" --replicas="$desired" >/dev/null
  fi
  k rollout status "deployment/$deployment" --timeout=300s >/dev/null
  available="$(safe_get get deployment "$deployment" -o 'jsonpath={.status.availableReplicas}')"
  require_equal "$component available replicas" "${available:-0}" "$desired"
  check_pod_nodes_if_present "$component"
}

ensure_deployment_ready api kaoyan-api "$state_api_replicas"
set_phase api-started
ensure_deployment_ready web kaoyan-web "$state_web_replicas"
set_phase web-started

curl -fsS --max-time 15 -o /dev/null "$PRODUCTION_ORIGIN/api/health/live"
curl -fsS --max-time 30 -o /dev/null "$PRODUCTION_ORIGIN/api/health/ready"
curl -fsS --max-time 30 -o /dev/null "$PRODUCTION_ORIGIN/"
require_equal "Certificate Ready condition after update" "$(safe_get get certificate kaoyan-pomodoro-certs -o 'jsonpath={.status.conditions[?(@.type=="Ready")].status}')" "True"
set_phase health-verified

current_cron_suspend="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.suspend}')"
if [[ "$current_cron_suspend" != "$state_final_cron_suspend" ]]; then
  k patch cronjob kaoyan-backup --type=merge -p "{\"spec\":{\"suspend\":$state_final_cron_suspend}}" >/dev/null
fi
require_equal "final Backup CronJob suspend" "$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.suspend}')" "$state_final_cron_suspend"
set_phase completed
state_patch '"lastResult":"success"'
completed=1
trap - EXIT
cleanup_temp_pods

echo "Kubernetes production update completed for main commit $main_sha."
echo "Persistent state: ConfigMap/$STATE_CONFIGMAP (phase=completed)."
echo "No automatic database rollback was performed."
