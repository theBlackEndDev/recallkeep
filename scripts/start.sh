#!/usr/bin/env bash
# Start everything recallkeep needs, then run the HTTP API in the foreground.
# Used by the launchd and systemd templates in deploy/, and fine to run by hand.
#
# Docker is optional. The script looks at RECALLKEEP_DATABASE_URL (see src/db-target.ts):
#
#   database is this repo's docker-compose service   external Postgres (no Docker)
#   1. wait for Docker                               1. wait until the database accepts connections
#   2. docker compose up -d
#   3. wait until Postgres is ready
#
#   then, in both cases:
#   4. apply any new database migrations
#   5. exec the API server (so the service manager sees its exit code)
#
# Force one or the other with RECALLKEEP_USE_DOCKER=1 or RECALLKEEP_USE_DOCKER=0 in .env.
set -euo pipefail

cd "$(dirname "$0")/.."
BUN="${RECALLKEEP_BUN_PATH:-$(command -v bun || echo "$HOME/.bun/bin/bun")}"

TARGET="$("$BUN" scripts/db.ts target)"

if [ "$TARGET" = "docker" ]; then
  until docker info >/dev/null 2>&1; do
    echo "[start] waiting for Docker..." >&2
    sleep 5
  done

  docker compose up -d

  until docker compose exec -T db pg_isready -U recallkeep -d recallkeep >/dev/null 2>&1; do
    sleep 2
  done
else
  echo "[start] using your own Postgres (Docker not used)" >&2
  "$BUN" scripts/db.ts wait 120
fi

"$BUN" x prisma migrate deploy >/dev/null

exec "$BUN" run src/http-server.ts
