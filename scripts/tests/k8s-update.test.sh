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
  *'get ingress/kaoyan-pomodoro -o name') printf 'ingress.networking.k8s.io/kaoyan-pomodoro\n' ;;
  *'get certificate/kaoyan-pomodoro-certs -o name') printf 'certificate.cert-manager.io/kaoyan-pomodoro-certs\n' ;;
  *'get deployment kaoyan-api -o jsonpath={.spec.template.spec.containers'*'.image}') printf 'ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  *'get deployment kaoyan-web -o jsonpath={.spec.template.spec.containers'*'.image}') printf 'ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  *'get cronjob kaoyan-backup -o jsonpath={.spec.jobTemplate.spec.template.spec.containers'*'.image}') printf 'ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' ;;
  *'get deployment kaoyan-api -o jsonpath={.spec.replicas}') printf '1' ;;
  *'get deployment kaoyan-web -o jsonpath={.spec.replicas}') printf '1' ;;
  *'get deployment kaoyan-api -o jsonpath={.status.availableReplicas}') printf '1' ;;
  *'get deployment kaoyan-web -o jsonpath={.status.availableReplicas}') printf '1' ;;
  *'get deployment kaoyan-api -o jsonpath={.spec.strategy.type}') printf 'Recreate' ;;
  *'get cronjob kaoyan-backup -o jsonpath={.spec.suspend}') printf 'false' ;;
  *'get cronjob kaoyan-backup -o jsonpath={.status.active'*) ;;
  *'get cronjob kaoyan-backup -o jsonpath={.status.lastScheduleTime}') printf '2026-07-15T02:30:00Z' ;;
  *'get cronjob kaoyan-backup -o jsonpath={.status.lastSuccessfulTime}') printf '2026-07-15T02:31:00Z' ;;
  *'get pvc kaoyan-data -o jsonpath={.status.phase}') printf 'Bound' ;;
  *'get pvc kaoyan-backups -o jsonpath={.status.phase}') printf 'Bound' ;;
  *'get certificate kaoyan-pomodoro-certs -o jsonpath={.status.conditions'*) printf 'True' ;;
  *'get ingress kaoyan-pomodoro -o jsonpath={.spec.ingressClassName}') printf 'traefik' ;;
  *'get ingress kaoyan-pomodoro -o jsonpath={.spec.rules'*) printf 'pomodoro.losenone.cn' ;;
  *'affinity.nodeAffinity'*'values'*) printf 'guilyrh' ;;
  *'affinity.nodeAffinity'*'.operator}') printf 'In' ;;
  *'tolerations'*'.value}') printf 'true' ;;
  *'tolerations'*'.operator}') printf 'Equal' ;;
  *'tolerations'*'.effect}') printf 'NoSchedule' ;;
  *'get pods -l app.kubernetes.io/component=api -o jsonpath='*) printf 'guilyrh\n' ;;
  *'get pods -l app.kubernetes.io/component=web -o jsonpath='*) printf 'guilyrh\n' ;;
  *' run kaoyan-pull-api-'*) ;;
  *' run kaoyan-pull-web-'*) ;;
  *' run kaoyan-pull-backup-'*) ;;
  *' get pod kaoyan-pull-api-'*' -o jsonpath={.status.phase}') printf 'Succeeded' ;;
  *' get pod kaoyan-pull-web-'*' -o jsonpath={.status.phase}') printf 'Succeeded' ;;
  *' get pod kaoyan-pull-backup-'*' -o jsonpath={.status.phase}') printf 'Failed' ;;
  *' delete pod kaoyan-pull-'*) ;;
  *) echo "Unhandled fake kubectl call: $args" >&2; exit 99 ;;
esac
FAKE_KUBECTL
chmod +x "$fake_bin/kubectl"

cat >"$fake_bin/curl" <<'FAKE_CURL'
#!/usr/bin/env bash
echo 'Unexpected curl call before write freeze' >&2
exit 98
FAKE_CURL
chmod +x "$fake_bin/curl"

sha=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
digest=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
common=(
  --namespace kaoyan-pomodoro
  --main-sha "$sha"
  --api-image "ghcr.io/monsoonr/kaoyan-pomodoro-api:sha-$sha@sha256:$digest"
  --web-image "ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-$sha@sha256:$digest"
  --backup-image "ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-$sha@sha256:$digest"
)

: >"$scratch/kubectl.log"
output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" bash "$ROOT/scripts/k8s-update.sh" --plan "${common[@]}")"
grep -q 'PLAN ONLY: no Kubernetes object was changed' <<<"$output"
grep -q 'old API replicas: 1' <<<"$output"
grep -q 'old Backup CronJob suspend: false' <<<"$output"
! grep -Eq '(^| )(apply|patch|scale|set image|create|delete|rollout)( |$)' "$scratch/kubectl.log"

: >"$scratch/kubectl.log"
set +e
bad_output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" bash "$ROOT/scripts/k8s-update.sh" --plan \
  --namespace kaoyan-pomodoro --main-sha "$sha" \
  --api-image 'ghcr.io/monsoonr/kaoyan-pomodoro-api:latest@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' \
  --web-image "ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-$sha@sha256:$digest" \
  --backup-image "ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-$sha@sha256:$digest" 2>&1)"
bad_status=$?
set -e
test "$bad_status" = 64
grep -q 'must not use latest' <<<"$bad_output"
test ! -s "$scratch/kubectl.log"

set +e
feature_output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" bash "$ROOT/scripts/k8s-update.sh" --plan \
  --namespace kaoyan-pomodoro --main-sha "$sha" \
  --api-image "ghcr.io/monsoonr/kaoyan-pomodoro-api:feature-invite-multi-user@sha256:$digest" \
  --web-image "ghcr.io/monsoonr/kaoyan-pomodoro-web:sha-$sha@sha256:$digest" \
  --backup-image "ghcr.io/monsoonr/kaoyan-pomodoro-backup:sha-$sha@sha256:$digest" 2>&1)"
feature_status=$?
set -e
test "$feature_status" = 64
grep -q 'official repository and sha-' <<<"$feature_output"

set +e
execute_output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" bash "$ROOT/scripts/k8s-update.sh" --execute "${common[@]}" 2>&1)"
execute_status=$?
set -e
test "$execute_status" = 64
grep -q -- '--execute requires --confirm-context' <<<"$execute_output"

: >"$scratch/kubectl.log"
set +e
second_confirm_output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" bash "$ROOT/scripts/k8s-update.sh" --execute "${common[@]}" \
  --confirm-context kite-production --migration-check-passed --confirm-execute WRONG 2>&1)"
second_confirm_status=$?
set -e
test "$second_confirm_status" = 64
grep -q 'Required execute confirmation: UPDATE kaoyan-pomodoro ON kite-production' <<<"$second_confirm_output"
grep -q -- '--confirm-execute must exactly match' <<<"$second_confirm_output"
! grep -Eq '(^| )(create|delete|patch|scale|set image|rollout)( |$)' "$scratch/kubectl.log"

: >"$scratch/kubectl.log"
set +e
pull_output="$(env PATH="$fake_bin:$PATH" FAKE_KUBECTL_LOG="$scratch/kubectl.log" \
  bash -u "$ROOT/scripts/k8s-update.sh" --execute "${common[@]}" \
  --confirm-context kite-production \
  --confirm-execute "UPDATE kaoyan-pomodoro ON kite-production TO $sha" \
  --migration-check-passed \
  --record-file "$scratch/update-state.log" 2>&1)"
pull_status=$?
set -e
test "$pull_status" -ne 0
! grep -q 'unbound variable' <<<"$pull_output"
! grep -q 'component: unbound variable' <<<"$pull_output"
grep -Eq 'image pull probe kaoyan-pull-backup-.* failed' <<<"$pull_output"

mapfile -t pull_probe_calls < <(grep ' run kaoyan-pull-' "$scratch/kubectl.log")
test "${#pull_probe_calls[@]}" = 3
[[ "${pull_probe_calls[0]}" == *' run kaoyan-pull-api-'* ]]
[[ "${pull_probe_calls[1]}" == *' run kaoyan-pull-web-'* ]]
[[ "${pull_probe_calls[2]}" == *' run kaoyan-pull-backup-'* ]]
for call in "${pull_probe_calls[@]}"; do
  [[ "$call" == *'"deploy.sagirii.me/node-id":"guilyrh"'* ]]
  [[ "$call" == *'"key":"deploy.sagirii.me/edge","operator":"Equal","value":"true","effect":"NoSchedule"'* ]]
done

# A pull-probe failure happens after the state record but before the maintenance window.
# Cleanup may delete only fake pull probes; it must not suspend or scale workloads.
grep -q '^timestamp=' "$scratch/update-state.log"
! grep -Eq '(^| )(patch|scale|set image|create job|rollout)( |$)' "$scratch/kubectl.log"

echo 'Kubernetes update script safety tests passed'
