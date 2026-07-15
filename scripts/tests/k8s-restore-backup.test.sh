#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT HUP INT TERM
fake_bin="$scratch/bin"
mkdir -p "$fake_bin"

cat >"$fake_bin/kubectl" <<'FAKE_KUBECTL'
#!/usr/bin/env bash
set -eu
printf '%s\n' "$*" >>"$FAKE_KUBECTL_LOG"
args="$*"
case "$args" in
  'config current-context') printf 'kite-production\n' ;;
  'get namespace kaoyan-pomodoro -o name') printf 'namespace/kaoyan-pomodoro\n' ;;
  *'get deployment/kaoyan-api -o name') printf 'deployment.apps/kaoyan-api\n' ;;
  *'get deployment/kaoyan-web -o name') printf 'deployment.apps/kaoyan-web\n' ;;
  *'get cronjob/kaoyan-backup -o name') printf 'cronjob.batch/kaoyan-backup\n' ;;
  *'get persistentvolumeclaim/kaoyan-data -o name') printf 'persistentvolumeclaim/kaoyan-data\n' ;;
  *'get persistentvolumeclaim/kaoyan-backups -o name') printf 'persistentvolumeclaim/kaoyan-backups\n' ;;
  *'get deployment kaoyan-api -o jsonpath={.spec.replicas}') printf '%s' "${FAKE_API_REPLICAS:-0}" ;;
  *'get deployment kaoyan-web -o jsonpath={.spec.replicas}') printf '%s' "${FAKE_WEB_REPLICAS:-0}" ;;
  *'get pods -l app.kubernetes.io/component=api -o name') printf '%s' "${FAKE_API_PODS:-}" ;;
  *'get pods -l app.kubernetes.io/component=web -o name') printf '%s' "${FAKE_WEB_PODS:-}" ;;
  *'get cronjob kaoyan-backup -o jsonpath={.spec.suspend}') printf 'true' ;;
  *'get cronjob kaoyan-backup -o jsonpath={.status.active'*) ;;
  *'get cronjob kaoyan-backup -o jsonpath={.spec.jobTemplate.spec.template.spec.containers'*) printf 'ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  *'get pvc kaoyan-data -o jsonpath={.status.phase}') printf 'Bound' ;;
  *'get pvc kaoyan-backups -o jsonpath={.status.phase}') printf 'Bound' ;;
  *'create -f -') tee "$FAKE_MANIFEST" >/dev/null; printf 'pod/kaoyan-restore\n' ;;
  *'get pod kaoyan-restore-'*'-o jsonpath={.status.phase}') printf 'Succeeded' ;;
  *'delete pod kaoyan-restore-'*'--wait=true') printf 'pod deleted\n' ;;
  *) echo "Unhandled fake kubectl call: $args" >&2; exit 99 ;;
esac
FAKE_KUBECTL
chmod +x "$fake_bin/kubectl"

backup='kaoyan-20260715T120000000000000Z-pre-update.sqlite.gz'
common=(--namespace kaoyan-pomodoro --backup-file "$backup")

: >"$scratch/kubectl.log"
help_output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" bash "$ROOT/scripts/k8s-restore-backup.sh")"
grep -q 'only displays help' <<<"$help_output"
test ! -s "$scratch/kubectl.log"

set +e
missing_output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" bash "$ROOT/scripts/k8s-restore-backup.sh" --plan 2>&1)"
missing_status=$?
set -e
test "$missing_status" = 64
grep -q -- '--backup-file' <<<"$missing_output"

: >"$scratch/kubectl.log"
set +e
scaled_output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" FAKE_API_REPLICAS=1 bash "$ROOT/scripts/k8s-restore-backup.sh" --plan "${common[@]}" 2>&1)"
scaled_status=$?
set -e
test "$scaled_status" = 69
grep -q "API replicas is '1', expected '0'" <<<"$scaled_output"
! grep -Eq '(^| )(create|delete|patch|scale|set image)( |$)' "$scratch/kubectl.log"

: >"$scratch/kubectl.log"
set +e
confirm_output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" FAKE_MANIFEST="$scratch/manifest.yaml" bash "$ROOT/scripts/k8s-restore-backup.sh" --execute "${common[@]}" --confirm-context kite-production --confirm-restore WRONG 2>&1)"
confirm_status=$?
set -e
test "$confirm_status" = 64
grep -q -- '--confirm-restore must exactly match' <<<"$confirm_output"
! grep -q ' create -f -' "$scratch/kubectl.log"

: >"$scratch/kubectl.log"
confirmation="RESTORE $backup IN kaoyan-pomodoro ON kite-production AND KEEP APPS STOPPED"
env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" FAKE_MANIFEST="$scratch/manifest.yaml" \
  bash "$ROOT/scripts/k8s-restore-backup.sh" --execute "${common[@]}" \
  --confirm-context kite-production --confirm-restore "$confirmation" >/dev/null

grep -q 'key: deploy.sagirii.me/node-id' "$scratch/manifest.yaml"
grep -q -- '- guilyrh' "$scratch/manifest.yaml"
grep -q 'key: deploy.sagirii.me/edge' "$scratch/manifest.yaml"
grep -q 'operator: Equal' "$scratch/manifest.yaml"
grep -q 'effect: NoSchedule' "$scratch/manifest.yaml"
grep -q 'claimName: kaoyan-data' "$scratch/manifest.yaml"
grep -q 'claimName: kaoyan-backups' "$scratch/manifest.yaml"
grep -q 'pre-restore safety copy' "$scratch/manifest.yaml"
grep -q 'Insufficient free space on kaoyan-data' "$scratch/manifest.yaml"
grep -q 'chown 10001:10001' "$scratch/manifest.yaml"
grep -q "stat -c '%u:%g:%a'" "$scratch/manifest.yaml"
grep -q 'PRAGMA integrity_check' "$scratch/manifest.yaml"
! grep -q 'hostPath:' "$scratch/manifest.yaml"
! grep -q 'retention.sh' "$scratch/manifest.yaml"
! grep -Eq 'rm .*\$archive|rm .*BACKUP_FILE' "$scratch/manifest.yaml"
! grep -Eq '(^| )(patch|scale|set image|rollout|create deployment|delete pvc|delete job)( |$)' "$scratch/kubectl.log"
test "$(grep -c 'delete pod kaoyan-restore-' "$scratch/kubectl.log")" = 1

echo 'Kubernetes restore script safety tests passed'
