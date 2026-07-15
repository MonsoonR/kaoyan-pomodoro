#!/usr/bin/env bash
set -Eeuo pipefail

readonly PRODUCTION_NAMESPACE="kaoyan-pomodoro"
readonly REQUIRED_NODE="guilyrh"
readonly NODE_LABEL_KEY="deploy.sagirii.me/node-id"
readonly TAINT_KEY="deploy.sagirii.me/edge"

mode="plan"
namespace="$PRODUCTION_NAMESPACE"
backup_file=""
confirmed_context=""
restore_confirmation=""
KUBECTL_BIN="${KUBECTL_BIN:-kubectl}"

usage() {
  cat <<'EOF'
Plan or execute a Kubernetes SQLite backup restore.

Usage:
  bash scripts/k8s-restore-backup.sh --plan \
    --namespace kaoyan-pomodoro \
    --backup-file kaoyan-YYYYMMDDTHHMMSSNNNNNNNNNZ-pre-update.sqlite.gz

  bash scripts/k8s-restore-backup.sh --execute \
    --namespace kaoyan-pomodoro \
    --backup-file <exact-backup-filename> \
    --confirm-context <exact-current-context> \
    --confirm-restore 'RESTORE <filename> IN kaoyan-pomodoro ON <context> AND KEEP APPS STOPPED'

With no arguments this script only displays help. Plan mode performs read-only
kubectl checks. Execute creates one temporary restore Pod and deletes only that
Pod afterward. It never starts API/Web, changes images, or deletes a backup.

WARNING: restoring a pre-update backup discards every user and business write
created after that backup. There is no in-place down migration for 0007-0009.

Host dependencies: Bash and kubectl only. SQLite/gzip/flock/coreutils execute
inside the existing pinned Backup image. Docker, Compose, jq and Python are not used.
EOF
}

die() {
  echo "ERROR: $*" >&2
  exit 64
}

(($#)) || { usage; exit 0; }
while (($#)); do
  case "$1" in
    --plan) mode="plan"; shift ;;
    --execute) mode="execute"; shift ;;
    --namespace) (($# >= 2)) || die "--namespace requires a value"; namespace="$2"; shift 2 ;;
    --backup-file) (($# >= 2)) || die "--backup-file requires a value"; backup_file="$2"; shift 2 ;;
    --confirm-context) (($# >= 2)) || die "--confirm-context requires a value"; confirmed_context="$2"; shift 2 ;;
    --confirm-restore) (($# >= 2)) || die "--confirm-restore requires a value"; restore_confirmation="$2"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ "$namespace" == "$PRODUCTION_NAMESPACE" ]] || die "namespace must be exactly $PRODUCTION_NAMESPACE"
[[ -n "$backup_file" ]] || die "--backup-file with the exact backup filename is required"
if [[ ! "$backup_file" =~ ^kaoyan-[0-9]{8}T[0-9]{15}Z-(manual|daily|pre-update|pre-restore)\.sqlite\.gz$ ]]; then
  die "backup filename must be an exact kaoyan timestamped .sqlite.gz filename, without a path"
fi

if [[ "$mode" == "execute" ]]; then
  [[ -n "$confirmed_context" ]] || die "--execute requires --confirm-context"
  [[ -n "$restore_confirmation" ]] || die "--execute requires --confirm-restore"
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

current_context="$("$KUBECTL_BIN" config current-context)" || { echo "ERROR: cannot read current kubectl context" >&2; exit 69; }
[[ -n "$current_context" ]] || { echo "ERROR: current kubectl context is empty" >&2; exit 69; }
if [[ "$mode" == "execute" && "$confirmed_context" != "$current_context" ]]; then
  die "--confirm-context does not exactly match current context '$current_context'"
fi

"$KUBECTL_BIN" get namespace "$namespace" -o name >/dev/null
for resource in deployment/kaoyan-api deployment/kaoyan-web cronjob/kaoyan-backup persistentvolumeclaim/kaoyan-data persistentvolumeclaim/kaoyan-backups; do
  k get "$resource" -o name >/dev/null
done

api_replicas="$(safe_get get deployment kaoyan-api -o 'jsonpath={.spec.replicas}')"
web_replicas="$(safe_get get deployment kaoyan-web -o 'jsonpath={.spec.replicas}')"
api_pods="$(safe_get get pods -l 'app.kubernetes.io/component=api' -o name)"
web_pods="$(safe_get get pods -l 'app.kubernetes.io/component=web' -o name)"
cron_suspend="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.suspend}')"
cron_active="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.status.active[*].name}')"
backup_image="$(safe_get get cronjob kaoyan-backup -o 'jsonpath={.spec.jobTemplate.spec.template.spec.containers[?(@.name=="backup")].image}')"

require_equal "API replicas" "$api_replicas" "0"
require_equal "Web replicas" "$web_replicas" "0"
[[ -z "$api_pods" ]] || { echo "ERROR: API Pod(s) still exist; SQLite may still be mounted for writes" >&2; exit 69; }
[[ -z "$web_pods" ]] || { echo "ERROR: Web Pod(s) still exist; complete the maintenance shutdown first" >&2; exit 69; }
require_equal "Backup CronJob suspend" "$cron_suspend" "true"
[[ -z "$cron_active" ]] || { echo "ERROR: Backup CronJob has active Job(s): $cron_active" >&2; exit 69; }
require_equal "data PVC phase" "$(safe_get get pvc kaoyan-data -o 'jsonpath={.status.phase}')" "Bound"
require_equal "backup PVC phase" "$(safe_get get pvc kaoyan-backups -o 'jsonpath={.status.phase}')" "Bound"
if [[ ! "$backup_image" =~ ^ghcr\.io/monsoonr/kaoyan-pomodoro-backup:sha-[0-9a-f]{40}@sha256:[0-9a-f]{64}$ ]]; then
  echo "ERROR: current Backup CronJob image is not pinned by a full Git SHA tag and OCI digest" >&2
  exit 69
fi

required_confirmation="RESTORE $backup_file IN $namespace ON $current_context AND KEEP APPS STOPPED"
cat <<EOF
Kubernetes restore preflight passed.
  mode: $mode
  context: $current_context
  namespace: $namespace
  backup file: $backup_file
  restore image: $backup_image
  API replicas / Pods: $api_replicas / 0
  Web replicas / Pods: $web_replicas / 0
  Backup CronJob suspended / active Jobs: $cron_suspend / 0
  data PVC / backup PVC: Bound / Bound

Plan:
  1. Create one temporary non-root restore Pod on $REQUIRED_NODE.
  2. Mount only kaoyan-data and kaoyan-backups PVCs; no HostPath is used.
  3. Validate the requested archive and reject insufficient data/backup PVC space.
  4. Save and verify an additional pre-restore copy of the current database without retention cleanup.
  5. Restore the requested archive, run integrity/foreign-key checks, and verify 10001:10001 mode 0600.
  6. Delete only the temporary restore Pod. API/Web remain at 0; images remain unchanged.

DATA LOSS WARNING: all data written after $backup_file will be lost if restore executes.
Required restore confirmation: $required_confirmation
EOF

if [[ "$mode" == "plan" ]]; then
  echo "PLAN ONLY: no Kubernetes object was changed."
  exit 0
fi

[[ "$restore_confirmation" == "$required_confirmation" ]] || die "--confirm-restore must exactly match the printed confirmation"

pod="kaoyan-restore-${RANDOM}-${RANDOM}"
pod_created=0
cleanup_on_exit() {
  local status=$?
  trap - EXIT
  if (( pod_created )); then
    k delete pod "$pod" --wait=true >/dev/null 2>&1 || echo "WARNING: failed to delete temporary restore Pod $pod" >&2
  fi
  exit "$status"
}
trap cleanup_on_exit EXIT

render_restore_pod() {
  cat <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: $pod
  namespace: $namespace
  labels:
    app.kubernetes.io/name: kaoyan-pomodoro
    app.kubernetes.io/component: restore
spec:
  automountServiceAccountToken: false
  restartPolicy: Never
  activeDeadlineSeconds: 1800
  affinity:
    nodeAffinity:
      requiredDuringSchedulingIgnoredDuringExecution:
        nodeSelectorTerms:
          - matchExpressions:
              - key: $NODE_LABEL_KEY
                operator: In
                values:
                  - $REQUIRED_NODE
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
  containers:
    - name: restore
      image: $backup_image
      imagePullPolicy: IfNotPresent
      env:
        - name: BACKUP_FILE
          value: "$backup_file"
EOF
  cat <<'EOF'
      command:
        - /bin/sh
        - -ceu
      args:
        - |
          archive="/backups/$BACKUP_FILE"
          db="/var/lib/kaoyan/kaoyan.sqlite"
          db_dir="$(dirname "$db")"
          test -f "$archive" && test ! -L "$archive" || { echo "Requested backup is missing or not a regular file" >&2; exit 66; }
          test -f "$db" && test ! -L "$db" || { echo "Current database is missing or not a regular file" >&2; exit 66; }
          /app/scripts/validate-backup.sh "$archive"

          db_bytes="$(stat -c %s "$db")"
          restore_bytes="$(gzip -dc "$archive" | wc -c)"
          data_line="$(df -Pk "$db_dir" | tail -n 1)"
          set -- $data_line
          data_free_kb="$4"
          backup_line="$(df -Pk /backups | tail -n 1)"
          set -- $backup_line
          backup_free_kb="$4"
          db_kb=$(( (db_bytes + 1023) / 1024 ))
          restore_kb=$(( (restore_bytes + 1023) / 1024 ))
          data_required_kb=$(( restore_kb + 16384 ))
          backup_required_kb=$(( db_kb * 3 + 16384 ))
          test "$data_free_kb" -ge "$data_required_kb" || { echo "Insufficient free space on kaoyan-data" >&2; exit 70; }
          test "$backup_free_kb" -ge "$backup_required_kb" || { echo "Insufficient free space on kaoyan-backups" >&2; exit 70; }

          exec 9>/backups/.backup.lock
          flock -n 9 || { echo "Another backup or restore holds the backup lock" >&2; exit 75; }
          stamp="$(date -u +%Y%m%dT%H%M%S%NZ)"
          final="/backups/kaoyan-${stamp}-pre-restore.sqlite.gz"
          tmpdir="$(mktemp -d "/backups/.pre-restore-${stamp}-XXXXXX")"
          cleanup_tmp() { rm -rf -- "$tmpdir"; }
          trap cleanup_tmp EXIT HUP INT TERM
          snapshot="$tmpdir/current.sqlite"
          verified="$tmpdir/verified.sqlite"
          sqlite3 "$db" ".timeout 10000" ".backup '$snapshot'"
          test "$(sqlite3 "$snapshot" 'PRAGMA integrity_check;')" = ok
          gzip -c -9 "$snapshot" >"$tmpdir/archive.gz"
          gzip -t "$tmpdir/archive.gz"
          gzip -dc "$tmpdir/archive.gz" >"$verified"
          test "$(sqlite3 "$verified" 'PRAGMA integrity_check;')" = ok
          chmod 0600 "$tmpdir/archive.gz"
          mv "$tmpdir/archive.gz" "$final"
          test -f "$final" && test ! -L "$final"
          flock -u 9
          exec 9>&-

          /app/scripts/restore-db.sh "$archive"
          chown 10001:10001 "$db"
          chmod 0600 "$db"
          test "$(stat -c '%u:%g:%a' "$db")" = "10001:10001:600"
          test "$(sqlite3 "$db" 'PRAGMA integrity_check;')" = ok
          test -z "$(sqlite3 "$db" 'PRAGMA foreign_key_check;')"
          test -f "$archive" && test ! -L "$archive"
          echo "Restore completed; pre-restore safety copy: $(basename "$final")"
      resources:
        requests:
          cpu: 50m
          memory: 96Mi
        limits:
          cpu: "1"
          memory: 512Mi
      securityContext:
        allowPrivilegeEscalation: false
        readOnlyRootFilesystem: true
        capabilities:
          drop:
            - ALL
      volumeMounts:
        - name: data
          mountPath: /var/lib/kaoyan
        - name: backups
          mountPath: /backups
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
      emptyDir:
        sizeLimit: 2Gi
EOF
}

render_restore_pod | k create -f - >/dev/null
pod_created=1

wait_for_restore() {
  local attempts=900 phase i
  for ((i = 1; i <= attempts; i++)); do
    phase="$(safe_get get pod "$pod" -o 'jsonpath={.status.phase}')"
    case "$phase" in
      Succeeded) return 0 ;;
      Failed) echo "ERROR: restore Pod failed; API/Web remain stopped" >&2; return 1 ;;
    esac
    (( i < attempts )) && sleep 2
  done
  echo "ERROR: restore Pod timed out; API/Web remain stopped" >&2
  return 1
}

wait_for_restore
k delete pod "$pod" --wait=true >/dev/null
pod_created=0
trap - EXIT
echo "Kubernetes database restore completed from $backup_file."
echo "API and Web remain scaled to 0. Images were not changed."
echo "Review the pre-restore safety copy and database checks before any separate startup action."
