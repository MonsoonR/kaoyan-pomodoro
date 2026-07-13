#!/usr/bin/env bash
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -P)"
cd "$ROOT"
docker compose config --quiet
backup="$(docker compose run --rm --no-deps backup /app/scripts/backup.sh pre-update | tail -n 1)"
docker compose run --rm --no-deps backup /app/scripts/validate-backup.sh "$backup"
export IMAGE_VERSION="$(git rev-parse HEAD)"
export BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker compose build
docker compose stop api
docker compose run --rm --no-deps api node dist/db/migrate.js
docker compose up -d api web backup
for _ in {1..30}; do
  if docker compose exec -T api node -e "fetch('http://127.0.0.1:3000/api/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; then break; fi
  sleep 2
done
docker compose up -d caddy
docker compose ps
echo "Deployed $IMAGE_VERSION after verified backup $(basename "$backup")"
