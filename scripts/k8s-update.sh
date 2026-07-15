#!/usr/bin/env bash
set -Eeuo pipefail

readonly PRODUCTION_NAMESPACE="kaoyan-pomodoro"
readonly REQUIRED_NODE="guilyrh"
readonly NODE_LABEL_KEY="deploy.sagirii.me/node-id"
readonly TAINT_KEY="deploy.sagirii.me/edge"
readonly PRODUCTION_ORIGIN="https://pomodoro.losenone.cn"

mode="plan"
namespace="$PRODUCTION_NAMESPACE"
api_image=""
web_image=""
backup_image=""
main_sha=""
confirmed_context=""
execute_confirmation=""
migration_check_passed=0
record_file=""
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"

usage() {
  cat <<'EOF'
Plan or execute the current Kubernetes production update.

Usage:
  bash scripts/k8s-update.sh [--plan | --execute] \
    --namespace kaoyan-pomodoro \
    --main-sha <40-hex-main-commit> \
    --api-image ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-<40-hex>@sha256:<64-hex> \
    --web-image ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-<40-hex>@sha256:<64-hex> \
    --backup-image ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-<40-hex>@sha256:<64-hex> \
    [--confirm-context <exact-current-context>] \
    [--confirm-execute 'UPDATE kaoyan-pomodoro ON <context> TO <40-hex-main-commit>'] \
    [--migration-check-passed] \
    [--record-file <path>]

Safety:
  --plan is the default and performs read-only Kubernetes checks only.
  --execute additionally requires --confirm-context, --confirm-execute and
  --migration-check-passed. The exact second confirmation is printed after Plan.
  Images must be the three official main-only GHCR images, share one full Git SHA,
  and be pinned by both sha-<Git SHA> tag and sha256 OCI digest. latest and branch
  tags are rejected. This script never performs an automatic SQLite rollback.
  Host dependencies: Bash and kubectl; execute mode also requires curl. It does
  not use Docker, Docker Compose, jq, Python, or access Secret objects.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --plan) mode="plan"; shift ;;
    --execute) mode="execute"; shift ;;
    --namespace) (($# >= 2)) || die "--namespace requires a value"; namespace="$2"; shift 2 ;;
    --main-sha) (($# >= 2)) || die "--main-sha requires a value"; main_sha="$2"; shift 2 ;;
    --api-image) (($# >= 2)) || die "--api-image requires a value"; api_image="$2"; shift 2 ;;
    --web-image) (($# >= 2)) || die "--web-image requires a value"; web_image="$2"; shift 2 ;;
    --backup-image) (($# >= 2)) || die "--backup-image requires a value"; backup_image="$2"; shift 2 ;;
    --confirm-context) (($# >= 2)) || die "--confirm-context requires a value"; confirmed_context="$2"; shift 2 ;;
    --confirm-execute) (($# >= 2)) || die "--confirm-execute requires a value"; execute_confirmation="$2"; shift 2 ;;
    --migration-check-passed) migration_check_passed=1; shift ;;
    --record-file) (($# >= 2)) || die "--record-file requires a value"; record_file="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$namespace" == "$PRODUCTION_NAMESPACE" ]] || die "namespace must be exactly $PRODUCTION_NAMESPACE"
[[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || die "--main-sha must be the reviewed 40-character commit already merged to main"

validate_image() {
  local component="$1" image="$2" expected_sha
  [[ -n "$image" ]] || die "--${component}-image is required"
  [[ "${image,,}" != *latest* ]] || die "$component image must not use latest"
  if [[ ! "$image" =~ ^ghcr\.io/monsoonr/kaoyan-pomodoro-${component}:sha-([0-9a-f]{40})@sha256:([0-9a-f]{64})$ ]]; then
    die "$component image must use the official repository and sha-<40-hex>@sha256:<64-hex>"
  fi
  expected_sha="${BASH_REMATCH[1]}"
  [[ "$expected_sha" == "$main_sha" ]] || die "$component image tag does not match --main-sha"
}

validate_image api "$api_image"
validate_image web "$web_image"
validate_image backup "$backup_image"

if [[ "$mode" == "execute" ]]; then
  [[ -n "$confirmed_context" ]] || die "--execute requires --confirm-context with the exact current context"
  [[ -n "$execute_confirmation" ]] || die "--execute requires --confirm-execute as a second explicit confirmation"
  (( migration_check_passed )) || die "--execute requires --migration-check-passed after an offline migration rehearsal against a verified production-backup copy"
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

current_context="$("$KUBECTL_BIN" config current-context)" || { echo "ERROR: cannot read current kubectl context" >&2; exit 69; }
[[ -n "$current_context" ]] || { echo "ERROR: current kubectl context is empty" >&2; exit 69; }
if [[ "$mode" == "execute" && "$confirmed_context" != "$current_context" ]]; then
  die "--confirm-context does not exactly match current context '$current_context'"
fi

"$KUBECTL_BIN" get namespace "$namespace" -o name >/dev/null
for resource in \
  deployment/kaoyan-api deployment/kaoyan-web \
  cronjob/kaoyan-backup \
  persistentvolumeclaim/kaoyan-data persistentvolumeclaim/kaoyan-backups \
  ingress/kaoyan-pomodoro certificate/kaoyan-pomodoro-certs; do
  k get "$resource" -o name >/dev/null
done

old_api_image="$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.template.spec.containers[?(@.name=="api")].image}')"
old_web_image="$(safe_get get deployment kaoyan-web -o 'jsonpath={.spec.template.spec.containers[?(@.name=="web")].image}')"
old_backup_image="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[?(@.name=="backup")].image}')"
old_api_replicas="$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.replicas}')"
old_web_replicas="$(safe_get get deployment kaoyan-web -o 'jsonpath={.spec.replicas}')"
old_api_available="$(safe_get get deployment kaoyan-api -o 'jsonpath={.status.availableReplicas}')"
old_web_available="$(safe_get get deployment kaoyan-web -o 'jsonpath={.status.availableReplicas}')"
old_api_strategy="$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.strategy.type}')"
old_cron_suspend="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.suspend}')"
cron_active="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.active[*].name}')"
cron_last_schedule="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.lastScheduleTime}')"
cron_last_success="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.lastSuccessfulTime}')"

[[ "$old_api_replicas" =~ ^[0-9]+$ && "$old_web_replicas" =~ ^[0-9]+$ ]] || { echo "ERROR: deployment replica state is invalid" >&2; exit 69; }
require_equal "API replicas" "$old_api_replicas" "1"
require_equal "API strategy" "$old_api_strategy" "Recreate"
require_equal "API available replicas" "${old_api_available:-0}" "$old_api_replicas"
require_equal "Web available replicas" "${old_web_available:-0}" "$old_web_replicas"
(( old_web_replicas > 0 )) || { echo "ERROR: Web must be running before the update" >&2; exit 69; }
[[ -z "$cron_active" ]] || { echo "ERROR: Backup CronJob currently has active Job(s): $cron_active" >&2; exit 69; }
[[ "$old_cron_suspend" == "true" || "$old_cron_suspend" == "false" ]] || { echo "ERROR: invalid CronJob suspend state" >&2; exit 69; }

require_equal "data PVC phase" "$(safe_get get pvc kaoyan-data -o 'jsonpath={.status.phase}')" "Bound"
require_equal "backup PVC phase" "$(safe_get get pvc kaoyan-backups -o 'jsonpath={.status.phase}')" "Bound"
require_equal "Certificate Ready condition" "$(safe_get get certificate kaoyan-pomodoro-certs -o 'jsonpath={.status.conditions[?(@.type=="Ready")].status}')" "True"
require_equal "Ingress class" "$(safe_get get ingress kaoyan-pomodoro -o 'jsonpath={.spec.ingressClassName}')" "traefik"
require_contains_word "Ingress host" "$(safe_get get ingress kaoyan-pomodoro -o 'jsonpath={.spec.rules[*].host}')" "pomodoro.losenone.cn"

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

check_template_scheduling "API" deployment/kaoyan-api '.spec.template.spec'
check_template_scheduling "Web" deployment/kaoyan-web '.spec.template.spec'
check_template_scheduling "Backup" cronjob/kaoyan-backup '.spec.jobTemplate.spec.template.spec'

check_pod_nodes() {
  local component="$1" nodes node
  nodes="$(safe_get get pods -l "app.kubernetes.io/component=$component" -o 'jsonpath={range .items[*]}{.spec.nodeName}{"\n"}{end}')"
  [[ -n "$nodes" ]] || { echo "ERROR: no $component Pod is running" >&2; exit 69; }
  while IFS= read -r node; do
    [[ -z "$node" || "$node" == "$REQUIRED_NODE" ]] || { echo "ERROR: $component Pod is on '$node', expected '$REQUIRED_NODE'" >&2; exit 69; }
  done <<<"$nodes"
}

check_pod_nodes api
check_pod_nodes web

print_state() {
  cat <<EOF
Kubernetes production update preflight passed.
  mode: $mode
  context: $current_context
  namespace: $namespace
  required node: $REQUIRED_NODE
  old API image: $old_api_image
  old Web image: $old_web_image
  old Backup image: $old_backup_image
  old API replicas: $old_api_replicas
  old Web replicas: $old_web_replicas
  old Backup CronJob suspend: $old_cron_suspend
  Backup last schedule: ${cron_last_schedule:-<none>}
  Backup last success: ${cron_last_success:-<none>}
  target main SHA: $main_sha
  target API image: $api_image
  target Web image: $web_image
  target Backup image: $backup_image
EOF
}

print_plan() {
  cat <<'EOF'

Planned maintenance-window sequence:
  1. Pull-check all three digest-pinned images on guilyrh.
  2. Suspend kaoyan-backup and verify no scheduled backup Job is active.
  3. Scale kaoyan-web to 0, then kaoyan-api to 0; wait until all API Pods are gone.
  4. Create and wait for kaoyan-backup-pre-update-<timestamp> from the existing CronJob.
  5. Set API, Web and Backup images while application Deployments remain at 0.
  6. Restore the single API replica first; API startup runs Drizzle migrations 0007-0009.
  7. Only after API rollout/readiness succeeds, restore Web and verify the public HTTPS endpoints.
  8. Restore the recorded CronJob suspend state and print the complete before/after record.

Failure boundary:
  Once write freeze begins, failures leave API/Web at 0 and the CronJob suspended.
  The script never restores an old SQLite backup, never applies a down migration,
  and never automatically changes images back after migrations may have run.
EOF
}

print_state
print_plan
required_execute_confirmation="UPDATE $namespace ON $current_context TO $main_sha"
echo "Required execute confirmation: $required_execute_confirmation"
if [[ "$mode" == "plan" ]]; then
  echo "PLAN ONLY: no Kubernetes object was changed."
  exit 0
fi

[[ "$execute_confirmation" == "$required_execute_confirmation" ]] || die "--confirm-execute must exactly match the printed confirmation"

command -v curl >/dev/null 2>&1 || die "curl is required for execute mode health checks"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
[[ -n "$record_file" ]] || record_file="./k8s-update-${timestamp}.log"
umask 077
{
  echo "timestamp=$timestamp"
  echo "context=$current_context"
  echo "namespace=$namespace"
  echo "old_api_image=$old_api_image"
  echo "old_web_image=$old_web_image"
  echo "old_backup_image=$old_backup_image"
  echo "old_api_replicas=$old_api_replicas"
  echo "old_web_replicas=$old_web_replicas"
  echo "old_backup_cronjob_suspend=$old_cron_suspend"
  echo "target_main_sha=$main_sha"
  echo "target_api_image=$api_image"
  echo "target_web_image=$web_image"
  echo "target_backup_image=$backup_image"
} >"$record_file"
chmod 0600 "$record_file"
echo "Pre-update state record: $record_file"

pull_probe_names=()
cron_changed=0
freeze_started=0
completed=0
backup_job="<not-created>"

cleanup_pull_probes() {
  local pod
  for pod in "${pull_probe_names[@]}"; do
    k delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  done
}
on_exit() {
  local status=$?
  cleanup_pull_probes
  if (( status != 0 && ! completed )); then
    if (( freeze_started )); then
      echo "ERROR: update failed after write freeze began; enforcing safe stopped state." >&2
      k scale deployment kaoyan-web --replicas=0 >/dev/null 2>&1 || true
      k scale deployment kaoyan-api --replicas=0 >/dev/null 2>&1 || true
      k patch cronjob kaoyan-backup --type=merge -p '{"spec":{"suspend":true}}' >/dev/null 2>&1 || true
      echo "API/Web are intended to remain at 0 and Backup CronJob suspended." >&2
      echo "No image rollback, database restore, or down migration was attempted." >&2
      echo "Pre-update backup Job: $backup_job" >&2
      echo "State record: $record_file" >&2
    elif (( cron_changed )); then
      k patch cronjob kaoyan-backup --type=merge -p "{\"spec\":{\"suspend\":$old_cron_suspend}}" >/dev/null 2>&1 || true
    fi
  fi
  exit "$status"
}
trap on_exit EXIT

wait_for_pod_success() {
  local pod="$1" attempts=90 phase i
  for ((i = 1; i <= attempts; i++)); do
    phase="$(safe_get get pod "$pod" -o 'jsonpath={.status.phase}')"
    case "$phase" in
      Succeeded) return 0 ;;
      Failed) echo "ERROR: image pull probe $pod failed" >&2; return 1 ;;
    esac
    (( i < attempts )) && sleep 2
  done
  echo "ERROR: image pull probe $pod timed out" >&2
  return 1
}
pull_check() {
  local component="$1"
  local image="$2"
  local uid="$3"
  local pod="kaoyan-pull-${component}-${timestamp,,}"
  pull_probe_names+=("$pod")
  k run "$pod" --image="$image" --image-pull-policy=Always --restart=Never --command \
    --overrides="{\"spec\":{\"automountServiceAccountToken\":false,\"nodeSelector\":{\"${NODE_LABEL_KEY}\":\"${REQUIRED_NODE}\"},\"tolerations\":[{\"key\":\"${TAINT_KEY}\",\"operator\":\"Equal\",\"value\":\"true\",\"effect\":\"NoSchedule\"}],\"securityContext\":{\"runAsNonRoot\":true,\"runAsUser\":${uid},\"runAsGroup\":${uid}}}}" \
    -- /bin/sh -c 'exit 0' >/dev/null
  wait_for_pod_success "$pod"
  echo "Image pull check passed on $REQUIRED_NODE: $component"
}

pull_check api "$api_image" 10001
pull_check web "$web_image" 10002
pull_check backup "$backup_image" 10001
cleanup_pull_probes
pull_probe_names=()

k patch cronjob kaoyan-backup --type=merge -p '{"spec":{"suspend":true}}' >/dev/null
cron_changed=1
active_after_suspend="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.active[*].name}')"
[[ -z "$active_after_suspend" ]] || { echo "ERROR: Backup Job became active during preflight: $active_after_suspend" >&2; exit 69; }

freeze_started=1
k scale deployment kaoyan-web --replicas=0
k scale deployment kaoyan-api --replicas=0

wait_no_pods() {
  local component="$1" attempts=90 pods i
  for ((i = 1; i <= attempts; i++)); do
    pods="$(safe_get get pods -l "app.kubernetes.io/component=$component" -o name)"
    [[ -z "$pods" ]] && return 0
    (( i < attempts )) && sleep 2
  done
  echo "ERROR: $component Pods did not terminate" >&2
  return 1
}
wait_no_pods web
wait_no_pods api

backup_job="kaoyan-backup-pre-update-${timestamp,,}"
k create job --from=cronjob/kaoyan-backup "$backup_job"
k wait --for=condition=complete --timeout=1800s "job/$backup_job"
require_equal "pre-update backup Job succeeded count" "$(safe_get get job "$backup_job" -o 'jsonpath={.status.succeeded}')" "1"
echo "Verified pre-update backup Job completed: $backup_job"

k set image deployment/kaoyan-api "api=$api_image"
k set image deployment/kaoyan-web "web=$web_image"
k set image cronjob/kaoyan-backup "backup=$backup_image"

k scale deployment kaoyan-api --replicas="$old_api_replicas"
k rollout status deployment/kaoyan-api --timeout=300s
check_pod_nodes api

k scale deployment kaoyan-web --replicas="$old_web_replicas"
k rollout status deployment/kaoyan-web --timeout=300s
check_pod_nodes web

curl -fsS --max-time 15 -o /dev/null "$PRODUCTION_ORIGIN/api/health/live"
curl -fsS --max-time 30 -o /dev/null "$PRODUCTION_ORIGIN/api/health/ready"
curl -fsS --max-time 30 -o /dev/null "$PRODUCTION_ORIGIN/"
require_equal "Certificate Ready condition after update" "$(safe_get get certificate kaoyan-pomodoro-certs -o 'jsonpath={.status.conditions[?(@.type=="Ready")].status}')" "True"

k patch cronjob kaoyan-backup --type=merge -p "{\"spec\":{\"suspend\":$old_cron_suspend}}" >/dev/null
cron_changed=0
completed=1
{
  echo "pre_update_backup_job=$backup_job"
  echo "result=success"
} >>"$record_file"
trap - EXIT
echo "Kubernetes production update completed for main commit $main_sha."
echo "State record: $record_file"
echo "No automatic database rollback was performed."
