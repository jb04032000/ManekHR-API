#!/usr/bin/env bash
# Roll out the CrewRoster BACKEND on the EC2 host (hybrid deploy; frontend is on
# Amplify). Run this ON the EC2 box, from the repo root:
#
#   ./deploy/deploy.sh
#
# Pulls latest backend source, rebuilds the image, and brings the stack up. The
# one-shot `migrate` service runs FIRST and gates backend-web/worker (compose
# depends_on: service_completed_successfully) — a failed migration stops the new
# version from serving. Idempotent: re-run for every release.
set -euo pipefail

# Resolve to the repo root (this script lives in deploy/).
cd "$(dirname "$0")/.."

COMPOSE="docker compose -f deploy/docker-compose.yml"

echo "==> Pulling latest backend source"
git pull --ff-only

echo "==> Building image"
$COMPOSE build

echo "==> Rolling out (migrate gate runs first, then web + worker + caddy)"
$COMPOSE up -d

echo "==> Reclaiming old image layers"
docker image prune -f

echo "==> Status"
$COMPOSE ps
echo "Done. Smoke test:  curl -fsS https://api.\${DOMAIN}/api/health"
