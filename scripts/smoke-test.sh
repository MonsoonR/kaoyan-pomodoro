#!/usr/bin/env bash
set -Eeuo pipefail
trap 'echo "Smoke test command failed at line $LINENO" >&2' ERR

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
project="kaoyan-smoke-$(date +%s)-$RANDOM"
scratch="$(mktemp -d)"
export COMPOSE_PROJECT_NAME="$project"
export COMPOSE_FILE="compose.yml:compose.test.yml"
export DOMAIN=localhost APP_ORIGIN=https://localhost:18443 CADDY_EMAIL=test@example.invalid
export TEST_HTTP_PORT="${TEST_HTTP_PORT:-18080}" TEST_HTTPS_PORT="${TEST_HTTPS_PORT:-18443}"
export DATA_DIR="$scratch/data" BACKUP_DIR="$scratch/backups" CADDY_DATA_DIR="$scratch/caddy-data" CADDY_CONFIG_DIR="$scratch/caddy-config"
export IMAGE_TAG="$project" IMAGE_VERSION="$(git rev-parse HEAD 2>/dev/null || echo unknown)" BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
password='smoke-only-password-42'
base="https://localhost:$TEST_HTTPS_PORT"

compose() { docker compose "$@"; }
cleanup() {
  status=$?
  if (( status != 0 )); then
    compose ps >&2 || true
    compose logs --no-color --tail=200 >&2 || true
  fi
  compose down --remove-orphans --volumes >/dev/null 2>&1 || true
  rm -rf -- "$scratch"
  return "$status"
}
trap cleanup EXIT HUP INT TERM
mkdir -p "$DATA_DIR" "$BACKUP_DIR" "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR"
chmod 0770 "$DATA_DIR" "$BACKUP_DIR"
chmod 0770 "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR"
if command -v chown >/dev/null; then
  chown 10001:10001 "$DATA_DIR" "$BACKUP_DIR" 2>/dev/null || chmod 0777 "$DATA_DIR" "$BACKUP_DIR"
  chown 1000:1000 "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR" 2>/dev/null || chmod 0777 "$CADDY_DATA_DIR" "$CADDY_CONFIG_DIR"
fi

compose config --quiet
compose build
compose up -d
for _ in {1..60}; do
  if curl -kfsS "$base/api/health/ready" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -kfsS "$base/api/health/live" | grep -q '"status":"ok"'
test "$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:$TEST_HTTP_PORT/")" = 308
headers="$scratch/headers"
curl -kfsSI "$base/" > "$headers"
grep -qi '^strict-transport-security:' "$headers"
grep -qi '^content-security-policy:' "$headers"
grep -qi '^x-content-type-options: nosniff' "$headers"

for service in web api backup; do
  test -z "$(docker port "$(compose ps -q "$service")" 2>/dev/null || true)"
done
test "$(compose exec -T web id -u)" != 0
test "$(compose exec -T api id -u)" != 0
test "$(compose exec -T backup id -u)" != 0

printf '{"username":"learner","password":"%s","confirmPassword":"%s"}' "$password" "$password" |
  compose run --rm -T --no-deps -e KAOYAN_ACCOUNT_STDIN=1 api node dist/cli/account.js init
if printf '{"username":"second","password":"%s","confirmPassword":"%s"}' "$password" "$password" |
  compose run --rm -T --no-deps -e KAOYAN_ACCOUNT_STDIN=1 api node dist/cli/account.js init; then
  echo 'Second account initialization unexpectedly succeeded' >&2; exit 1
fi

cookie="$scratch/cookie"
login_headers="$scratch/login-headers"
curl -kfsS -D "$login_headers" -c "$cookie" -H "Origin: $base" -H 'Content-Type: application/json' \
  --data-binary "{\"username\":\"learner\",\"password\":\"$password\"}" "$base/api/auth/login" >/dev/null
grep -qi 'set-cookie:.*HttpOnly' "$login_headers"
grep -qi 'set-cookie:.*Secure' "$login_headers"
grep -qi 'set-cookie:.*SameSite=Lax' "$login_headers"
token="$(awk '$6=="kaoyan_session" {print $7}' "$cookie")"

created='2026-07-13T12:00:00.000Z'
curl -kfsS -b "$cookie" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @- "$base/api/sync/push" > "$scratch/push.json" <<JSON
{"operations":[{"operationId":"11111111-1111-4111-8111-111111111111","entityId":"22222222-2222-4222-8222-222222222222","baseVersion":0,"createdAt":"$created","entityType":"task","operationType":"create","payload":{"title":"smoke-original","subject":"math","defaultPomodoroTarget":2,"defaultTimerPreset":"25-5","notes":null}}]}
JSON
grep -q '"status":"applied"' "$scratch/push.json"
curl -kfsS -b "$cookie" "$base/api/sync/pull?cursor=0&limit=100" | grep -q 'smoke-original'

backup_path="$(compose run --rm --no-deps backup /app/scripts/backup.sh manual | tail -n 1)"
backup_name="$(basename "$backup_path")"
test -f "$BACKUP_DIR/$backup_name"
compose run --rm --no-deps backup /app/scripts/validate-backup.sh "/backups/$backup_name"

curl -kfsS -b "$cookie" -H "Origin: $base" -H 'Content-Type: application/json' --data-binary @- "$base/api/sync/push" > "$scratch/update.json" <<JSON
{"operations":[{"operationId":"33333333-3333-4333-8333-333333333333","entityId":"22222222-2222-4222-8222-222222222222","baseVersion":1,"createdAt":"2026-07-13T12:01:00.000Z","entityType":"task","operationType":"update","payload":{"title":"smoke-modified"}}]}
JSON
grep -q '"status":"applied"' "$scratch/update.json"
bash scripts/restore.sh "$BACKUP_DIR/$backup_name"
curl -kfsS -b "$cookie" "$base/api/sync/pull?cursor=0&limit=100" | grep -q 'smoke-original'

compose up -d --force-recreate api
for _ in {1..30}; do curl -kfsS "$base/api/health/ready" >/dev/null && break; sleep 2; done
compose run --rm --no-deps backup sh -c 'test "$(sqlite3 "$DATABASE_PATH" "SELECT count(*) FROM tasks WHERE title=\"smoke-original\";")" -eq 1'

rollback_name="kaoyan-20260713T130000000000000Z-manual.sqlite.gz"
compose run --rm --no-deps backup sh -c "sqlite3 /tmp/empty.sqlite 'VACUUM;' && gzip -c /tmp/empty.sqlite > /backups/$rollback_name"
if bash scripts/restore.sh "$BACKUP_DIR/$rollback_name"; then echo 'Account-less restore unexpectedly succeeded' >&2; exit 1; fi
curl -kfsS "$base/api/health/ready" >/dev/null
compose run --rm --no-deps backup sh -c 'test "$(sqlite3 "$DATABASE_PATH" "SELECT count(*) FROM tasks WHERE title=\"smoke-original\";")" -eq 1'

compose run --rm --no-deps backup sh -c 'touch -d "29 days ago" /backups/kaoyan-20260614T000000000000000Z-manual.sqlite.gz; touch -d "30 days ago" /backups/kaoyan-20260613T000000000000000Z-manual.sqlite.gz; touch -d "31 days ago" /backups/kaoyan-20260612T000000000000000Z-manual.sqlite.gz; touch -d "40 days ago" /backups/unrelated.sqlite.gz; /app/scripts/retention.sh; test -f /backups/kaoyan-20260614T000000000000000Z-manual.sqlite.gz; test -f /backups/kaoyan-20260613T000000000000000Z-manual.sqlite.gz; test ! -e /backups/kaoyan-20260612T000000000000000Z-manual.sqlite.gz; test -f /backups/unrelated.sqlite.gz'

logs="$(compose logs --no-color)"
! grep -Fq "$password" <<<"$logs"
! grep -Fq "$token" <<<"$logs"
for service in api web backup caddy; do
  for _ in {1..45}; do
    state="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$(compose ps -q "$service")")"
    [[ "$state" == healthy ]] && break
    sleep 2
  done
  [[ "$state" == healthy ]]
done
compose ps
echo "Docker smoke test passed for $project"
