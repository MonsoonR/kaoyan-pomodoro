#!/usr/bin/env bash
set -Eeuo pipefail

readonly PRODUCTION_CONTEXT="nzfklii-kite"
readonly PRODUCTION_NAMESPACE="kaoyan-pomodoro"
readonly REQUIRED_NODE="guilyrh"
readonly NODE_LABEL_KEY="deploy.sagirii.me/node-id"
readonly TAINT_KEY="deploy.sagirii.me/edge"
readonly STATE_CONFIGMAP="kaoyan-update-state"
readonly OPERATION_LEASE="kaoyan-update-operation-lock"

namespace="$PRODUCTION_NAMESPACE"
main_sha=""
confirmed_context=""
init_confirmation=""
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"
POLL_ATTEMPTS="${K8S_ADMIN_POLL_ATTEMPTS:-180}"
POLL_DELAY_SECONDS="${K8S_ADMIN_POLL_DELAY_SECONDS:-2}"
LOCK_TTL_SECONDS="${K8S_ADMIN_LOCK_TTL_SECONDS:-1800}"

usage() {
  cat <<'EOF'
Initialize the first administrator through an interactive, one-time Kubernetes Pod.

Usage:
  bash scripts/k8s-admin-init.sh \
    --namespace kaoyan-pomodoro \
    --main-sha <40-hex-main-commit> \
    --confirm-context nzfklii-kite \
    --confirm-init 'INITIALIZE ADMIN IN kaoyan-pomodoro ON nzfklii-kite FOR <40-hex-main-commit>'

The API image is loaded from ConfigMap/kaoyan-update-state. Username and password
are read only from the attached TTY by `node dist/cli/account.js init`; they are
never accepted as arguments, environment variables, ConfigMap data or log fields.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 64
}

while (($#)); do
  case "$1" in
    --namespace) (($# >= 2)) || die "--namespace requires a value"; namespace="$2"; shift 2 ;;
    --main-sha) (($# >= 2)) || die "--main-sha requires a value"; main_sha="$2"; shift 2 ;;
    --confirm-context) (($# >= 2)) || die "--confirm-context requires a value"; confirmed_context="$2"; shift 2 ;;
    --confirm-init) (($# >= 2)) || die "--confirm-init requires a value"; init_confirmation="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$namespace" == "$PRODUCTION_NAMESPACE" ]] || die "namespace must be exactly $PRODUCTION_NAMESPACE"
[[ "$main_sha" =~ ^[0-9a-f]{40}$ ]] || die "--main-sha must be a full 40-character main commit"
[[ "$POLL_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || die "K8S_ADMIN_POLL_ATTEMPTS must be a positive integer"
[[ "$POLL_DELAY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]] || die "K8S_ADMIN_POLL_DELAY_SECONDS must be non-negative"
[[ "$LOCK_TTL_SECONDS" =~ ^[1-9][0-9]*$ ]] || die "K8S_ADMIN_LOCK_TTL_SECONDS must be a positive integer"
command -v "$KUBECTL_BIN" >/dev/null 2>&1 || die "kubectl is required"

k() { "$KUBECTL_BIN" --namespace "$namespace" "$@"; }
safe_get() {
  local value
  value="$(k "$@")" || { echo "ERROR: kubectl check failed: $*" >&2; exit 69; }
  printf '%s' "$value"
}
require_equal() {
  local description="$1" actual="$2" expected="$3"
  [[ "$actual" == "$expected" ]] || { echo "ERROR: $description is '$actual', expected '$expected'" >&2; exit 69; }
}

current_context="$("$KUBECTL_BIN" config current-context)" || { echo "ERROR: cannot read current kubectl context" >&2; exit 69; }
require_equal "kubectl context" "$current_context" "$PRODUCTION_CONTEXT"
require_equal "confirmed context" "$confirmed_context" "$current_context"
required_confirmation="INITIALIZE ADMIN IN $namespace ON $current_context FOR $main_sha"
[[ "$init_confirmation" == "$required_confirmation" ]] || die "--confirm-init must exactly match '$required_confirmation'"

state_name="$(safe_get get configmap "$STATE_CONFIGMAP" -o name --ignore-not-found)"
[[ -n "$state_name" ]] || die "ConfigMap/$STATE_CONFIGMAP does not exist; run reset-empty execution first"
state_field() { safe_get get configmap "$STATE_CONFIGMAP" -o "jsonpath={.data.$1}"; }
state_schema="$(state_field schemaVersion)"
state_phase="$(state_field phase)"
state_mode="$(state_field databaseMode)"
state_sha="$(state_field mainSha)"
api_image="$(state_field apiImage)"

require_equal "state schema version" "$state_schema" "1"
require_equal "state database mode" "$state_mode" "reset-empty"
require_equal "state main SHA" "$state_sha" "$main_sha"
[[ "$api_image" =~ ^ghcr\.io/monsoonr/kaoyan-pomodoro-api:sha-${main_sha}@sha256:[0-9a-f]{64}$ ]] ||
  die "persistent API image is not the digest-pinned image for $main_sha"

case "$state_phase" in
  admin-initialized|api-started|web-started|health-verified|completed)
    echo "Administrator initialization is already recorded at phase $state_phase; nothing was changed."
    exit 0
    ;;
  awaiting-admin-init) ;;
  *) die "administrator initialization is only allowed at awaiting-admin-init, not '$state_phase'" ;;
esac

require_equal "API replicas" "$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.replicas}')" "0"
require_equal "Web replicas" "$(safe_get get deployment kaoyan-web -o 'jsonpath={.spec.replicas}')" "0"
require_equal "Backup CronJob suspend" "$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.suspend}')" "true"
active_jobs="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.active[*].name}')"
[[ -z "$active_jobs" ]] || { echo "ERROR: Backup CronJob has active Job(s): $active_jobs" >&2; exit 69; }
require_equal "data PVC phase" "$(safe_get get pvc kaoyan-data -o 'jsonpath={.status.phase}')" "Bound"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)-$$"
lock_holder="${main_sha}:admin-init:${timestamp}"
lock_acquired=0
render_operation_lease() {
  local resource_version="$1" holder="$2" expires_epoch="$3" resource_version_line=""
  [[ -z "$resource_version" ]] || resource_version_line="  resourceVersion: \"$resource_version\""
  cat <<EOF
apiVersion: coordination.k8s.io/v1
kind: Lease
metadata:
  name: $OPERATION_LEASE
  annotations:
    kaoyan.losenone.cn/expires-at-epoch: "$expires_epoch"
$resource_version_line
spec:
  holderIdentity: "$holder"
  leaseDurationSeconds: $LOCK_TTL_SECONDS
  acquireTime: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  renewTime: "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
EOF
}
acquire_operation_lock() {
  local now expires existing holder resource_version
  now="$(date +%s)"; expires="$((now + LOCK_TTL_SECONDS))"
  if render_operation_lease "" "$lock_holder" "$expires" | k create -f - >/dev/null 2>&1; then
    lock_acquired=1
    return 0
  fi
  existing="$(safe_get get lease "$OPERATION_LEASE" -o name --ignore-not-found)"
  [[ -n "$existing" ]] || { echo "ERROR: could not create or inspect Lease/$OPERATION_LEASE" >&2; return 73; }
  holder="$(safe_get get lease "$OPERATION_LEASE" -o 'jsonpath={.spec.holderIdentity}')"
  expires="$(safe_get get lease "$OPERATION_LEASE" -o 'jsonpath={.metadata.annotations.kaoyan\.losenone\.cn/expires-at-epoch}')"
  resource_version="$(safe_get get lease "$OPERATION_LEASE" -o 'jsonpath={.metadata.resourceVersion}')"
  if [[ -n "$holder" && ( ! "$expires" =~ ^[0-9]+$ || "$now" -lt "$expires" ) ]]; then
    echo "ERROR: another update process holds Lease/$OPERATION_LEASE (owner=$holder, expiresEpoch=${expires:-unknown})." >&2
    return 73
  fi
  render_operation_lease "$resource_version" "$lock_holder" "$((now + LOCK_TTL_SECONDS))" | k replace -f - >/dev/null 2>&1 || {
    echo "ERROR: Lease/$OPERATION_LEASE changed while taking over an expired lock; retry." >&2
    return 73
  }
  lock_acquired=1
}
release_operation_lock() {
  local holder resource_version
  (( lock_acquired )) || return 0
  holder="$(k get lease "$OPERATION_LEASE" -o 'jsonpath={.spec.holderIdentity}' 2>/dev/null)" || return 1
  [[ "$holder" == "$lock_holder" ]] || { lock_acquired=0; return 1; }
  resource_version="$(k get lease "$OPERATION_LEASE" -o 'jsonpath={.metadata.resourceVersion}' 2>/dev/null)" || return 1
  render_operation_lease "$resource_version" "" 0 | k replace -f - >/dev/null || return 1
  lock_acquired=0
}

pod="kaoyan-admin-init-${main_sha:0:12}"
status_pod="kaoyan-admin-status-${main_sha:0:12}"
pod_created=0
cleanup_failed_pod() {
  local status=$?
  trap - EXIT
  if (( status != 0 && pod_created )); then
    k delete pod "$pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  fi
  k delete pod "$status_pod" --ignore-not-found --wait=false >/dev/null 2>&1 || true
  release_operation_lock || true
  exit "$status"
}
trap cleanup_failed_pod EXIT

if acquire_operation_lock; then :; else lock_status=$?; exit "$lock_status"; fi

render_status_pod() {
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $status_pod
  labels:
    app.kubernetes.io/name: kaoyan-pomodoro
    app.kubernetes.io/component: admin-status
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
    runAsUser: 10001
    runAsGroup: 10001
    fsGroup: 10001
    fsGroupChangePolicy: OnRootMismatch
    seccompProfile:
      type: RuntimeDefault
  containers:
    - name: account-status
      image: $api_image
      imagePullPolicy: IfNotPresent
      env:
        - name: DATABASE_PATH
          value: /var/lib/kaoyan/kaoyan.sqlite
      command: ["node", "dist/cli/account.js", "status"]
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop: ["ALL"]
      volumeMounts:
        - name: data
          mountPath: /var/lib/kaoyan
          readOnly: true
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

status_existing="$(safe_get get pod "$status_pod" -o name --ignore-not-found)"
if [[ -n "$status_existing" ]]; then
  require_equal "existing administrator status Pod image" "$(safe_get get pod "$status_pod" -o 'jsonpath={.spec.containers[0].image}')" "$api_image"
  status_phase="$(safe_get get pod "$status_pod" -o 'jsonpath={.status.phase}')"
  if [[ "$status_phase" == "Failed" ]]; then
    k delete pod "$status_pod" --wait=true >/dev/null
    status_existing=""
  fi
fi
if [[ -z "$status_existing" ]]; then
  render_status_pod | k create -f - >/dev/null
fi
for ((i = 1; i <= POLL_ATTEMPTS; i++)); do
  status_phase="$(safe_get get pod "$status_pod" -o 'jsonpath={.status.phase}')"
  case "$status_phase" in
    Succeeded) break ;;
    Failed) echo "ERROR: administrator status check failed; initialization was not attempted" >&2; exit 1 ;;
  esac
  (( i < POLL_ATTEMPTS )) && sleep "$POLL_DELAY_SECONDS"
done
require_equal "administrator status Pod phase" "$status_phase" "Succeeded"
administrator_status="$(safe_get logs "$status_pod")"
k delete pod "$status_pod" --ignore-not-found --wait=true >/dev/null
case "$administrator_status" in
  initialized)
    k patch configmap "$STATE_CONFIGMAP" --type=merge \
      -p '{"data":{"phase":"admin-initialized","databaseStatus":"administrator-initialized","lastResult":"in-progress"}}' >/dev/null
    release_operation_lock || echo "WARNING: Lease/$OPERATION_LEASE will remain until its recorded expiry." >&2
    trap - EXIT
    cat <<EOF
Administrator already exists in the database; interactive initialization was not run.
Persistent phase converged to admin-initialized. API/Web remain stopped and Backup remains suspended.

Continue with:
  bash scripts/k8s-update.sh --resume --namespace $namespace \\
    --confirm-context $current_context \\
    --confirm-execute 'UPDATE $namespace ON $current_context TO $main_sha USING reset-empty'
EOF
    exit 0
    ;;
  not-initialized) ;;
  *) echo "ERROR: unexpected administrator status: '$administrator_status'" >&2; exit 1 ;;
esac

render_admin_pod() {
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  labels:
    app.kubernetes.io/name: kaoyan-pomodoro
    app.kubernetes.io/component: admin-init
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  activeDeadlineSeconds: 1800
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
    - name: account
      image: $api_image
      imagePullPolicy: IfNotPresent
      stdin: true
      tty: true
      env:
        - name: DATABASE_PATH
          value: /var/lib/kaoyan/kaoyan.sqlite
      command: ["node", "dist/cli/account.js", "init"]
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

existing="$(safe_get get pod "$pod" -o name --ignore-not-found)"
if [[ -n "$existing" ]]; then
  pod_image="$(safe_get get pod "$pod" -o 'jsonpath={.spec.containers[0].image}')"
  require_equal "existing administrator Pod image" "$pod_image" "$api_image"
  pod_phase="$(safe_get get pod "$pod" -o 'jsonpath={.status.phase}')"
  if [[ "$pod_phase" == "Failed" ]]; then
    k delete pod "$pod" --wait=true >/dev/null
    existing=""
  fi
fi

if [[ -z "$existing" ]]; then
  render_admin_pod | k create -f - >/dev/null
  pod_created=1
fi

pod_phase="$(safe_get get pod "$pod" -o 'jsonpath={.status.phase}')"
if [[ "$pod_phase" != "Succeeded" ]]; then
  echo "Attaching to the one-time administrator initializer. Password input is hidden."
  k attach -it "$pod" --pod-running-timeout=5m
fi

for ((i = 1; i <= POLL_ATTEMPTS; i++)); do
  pod_phase="$(safe_get get pod "$pod" -o 'jsonpath={.status.phase}')"
  case "$pod_phase" in
    Succeeded) break ;;
    Failed) echo "ERROR: administrator initialization failed; API/Web remain stopped" >&2; exit 1 ;;
  esac
  (( i < POLL_ATTEMPTS )) && sleep "$POLL_DELAY_SECONDS"
done
require_equal "administrator Pod phase" "$pod_phase" "Succeeded"

k patch configmap "$STATE_CONFIGMAP" --type=merge \
  -p '{"data":{"phase":"admin-initialized","databaseStatus":"administrator-initialized","lastResult":"in-progress"}}' >/dev/null
k delete pod "$pod" --ignore-not-found --wait=true >/dev/null
pod_created=0
release_operation_lock || echo "WARNING: Lease/$OPERATION_LEASE will remain until its recorded expiry." >&2
trap - EXIT

cat <<EOF
Administrator initialization completed without storing credentials in Kubernetes metadata.
API/Web remain stopped and Backup remains suspended.

Continue with:
  bash scripts/k8s-update.sh --resume --namespace $namespace \\
    --confirm-context $current_context \\
    --confirm-execute 'UPDATE $namespace ON $current_context TO $main_sha USING reset-empty'
EOF
